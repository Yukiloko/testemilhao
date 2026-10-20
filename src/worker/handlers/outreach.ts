import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { conversations, leads, messages, type Lead } from "@/db/schema";
import type { Db } from "@/db/client";
import { checkBrowserPacing, startWarmupIfNeeded } from "@/features/campaigns/pacing";
import { ChannelLockError, getConversation, transitionChannel } from "@/features/conversations/channel";
import { ContentBlockedError, generateFollowup, generateOpening } from "@/features/conversations/engine";
import { markFailed, markSent, reserveOutbound } from "@/features/conversations/outbound";
import { assignVariant } from "@/features/experiments/assignment";
import { isDoNotContact } from "@/features/leads/do-not-contact";
import { advanceAtLeast, transitionPipeline } from "@/features/leads/pipeline";
import { openException, recordEvent } from "@/features/safety/audit";
import { getSettings } from "@/features/safety/settings";
import { BrowserActionError } from "@/integrations/browser/errors";
import { sendDirectMessage, type HumanTiming } from "@/integrations/browser/instagram";
import { DAY, localHour, MINUTE } from "@/lib/time";
import { cancel, done, later, payloadNumber, type HandlerContext, type HandlerResult, type Handler } from "../context";
import { enqueue, hasOpenJob } from "../queue";

export const HUMAN_TIMING: HumanTiming = { charDelayMs: [45, 160], pauseBeforeSendMs: [1_500, 4_000] };

/** Picks the single best next lead for first contact; send jobs are enqueued one at a time. */
export const planOutreach: Handler = async ({ now, d }) => {
  const s = getSettings(d);
  if (s.paused || !s.browserAvailable) return done("paused or browser unavailable");
  if (hasOpenJob("send_first_dm", d)) return done("a first-contact job is already pending");
  const hour = localHour(now, s.operatingTimezone);
  const next = d
    .select({ lead: leads })
    .from(leads)
    .innerJoin(conversations, eq(conversations.leadId, leads.id))
    .where(and(eq(leads.pipelineStatus, "qualified"), eq(conversations.channelState, "browser_contact_pending")))
    .orderBy(sql`case when ${leads.bestSendHour} is null or ${leads.bestSendHour} = ${hour} then 0 else 1 end`, desc(leads.priority), leads.id)
    .get();
  if (!next) return done("no qualified leads waiting");
  enqueue("send_first_dm", { leadId: next.lead.id }, { idempotencyKey: `first_dm:${next.lead.id}`, priority: 5 }, d);
  return done(`queued first contact for lead ${next.lead.id}`);
};

type Gate = { ok: true } | { ok: false; result: HandlerResult };

function gateBrowserSend(ctx: HandlerContext, lead: Lead): Gate {
  const { now, d } = ctx;
  const s = getSettings(d);
  if (s.paused) return { ok: false, result: later(new Date(now.getTime() + 15 * MINUTE), "system paused") };
  if (!ctx.sendEnabled) return { ok: false, result: later(new Date(now.getTime() + 60 * MINUTE), "BROWSER_SEND_ENABLED=false") };
  if (isDoNotContact({ handle: lead.handle }, d)) return { ok: false, result: cancel("do_not_contact") };
  const pacing = checkBrowserPacing(now, d, ctx.random);
  if (!pacing.ok) return { ok: false, result: later(pacing.retryAt, pacing.reason) };
  return { ok: true };
}

/**
 * Shared browser send path for opening and follow-ups. The outbound row is reserved before
 * the browser acts; its final status reflects what we actually know about delivery.
 */
async function sendViaBrowser(
  ctx: HandlerContext,
  lead: Lead,
  input: { kind: "opening" | "followup"; body: string; dedupeKey: string; experimentId?: number | null; variantId?: number | null },
): Promise<"sent" | "not_sent" | "unknown"> {
  const { d, now, job } = ctx;
  const reserved = reserveOutbound({ leadId: lead.id, channel: "browser", ...input }, d);
  try {
    await ctx.browser({ jobId: job.id, leadId: lead.id }, (page) => sendDirectMessage(page, ctx.baseUrl, lead.handle, input.body, { ...HUMAN_TIMING, random: ctx.random }, false));
    markSent(reserved.id, null, now, d);
    recordEvent("message.outbound", { leadId: lead.id, jobId: job.id, actor: "browser", payload: { kind: input.kind, messageId: reserved.id, variantId: input.variantId ?? null } }, d);
    return "sent";
  } catch (error) {
    if (error instanceof BrowserActionError && error.delivered === "unknown") {
      openException("delivery_unknown", "O envio pelo navegador pode ter saído. Confira o direct e reconcilie.", { leadId: lead.id, payload: { messageId: reserved.id, error: error.message } }, d);
      return "unknown";
    }
    markFailed(reserved.id, error instanceof Error ? error.message : String(error), d);
    throw error;
  }
}

export const sendFirstDm: Handler = async (ctx) => {
  const { job, d, now, config } = ctx;
  const leadId = payloadNumber(job, "leadId");
  const lead = d.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead || lead.pipelineStatus !== "qualified") return cancel("lead not qualified");
  const conv = getConversation(leadId, d);
  if (conv.channelState === "browser_contact_sent") {
    // A previous run died between reserving and confirming the send (crash/restart).
    tryTransition(leadId, d, { from: ["browser_contact_sent"], to: "human_review_required", owner: "human", actor: "system", reason: "interrupted send recovered after restart" });
    openException("delivery_unknown", "Envio interrompido por reinício. Confira no direct se a mensagem saiu.", { leadId }, d);
    return done("interrupted send escalated");
  }
  if (conv.channelState !== "browser_contact_pending" || conv.channelOwner !== "none") return cancel(`channel is ${conv.channelState}/${conv.channelOwner}`);
  const gate = gateBrowserSend(ctx, lead);
  if (!gate.ok) return gate.result;

  const opening = assignVariant(leadId, lead.funnel, "opening", d);
  const cadence = assignVariant(leadId, lead.funnel, "followup_cadence", d);
  let body: string;
  try {
    body = await generateOpening(lead, opening?.variant.content ?? null, config, d);
  } catch (error) {
    if (!(error instanceof ContentBlockedError)) throw error;
    transitionChannel(leadId, { from: ["browser_contact_pending"], to: "human_review_required", owner: "human", actor: "ai", reason: "opening blocked by claims guard" }, d);
    openException("content_blocked", "A IA não conseguiu gerar uma abertura sem afirmações não verificadas.", { leadId, payload: { violations: error.violations } }, d);
    return done("opening blocked");
  }

  transitionChannel(leadId, { from: ["browser_contact_pending"], to: "browser_contact_sent", owner: "browser", actor: "browser", reason: "sending first DM" }, d);
  let outcome: Awaited<ReturnType<typeof sendViaBrowser>>;
  try {
    outcome = await sendViaBrowser(ctx, lead, { kind: "opening", body, dedupeKey: `opening:${leadId}`, experimentId: opening?.experiment.id, variantId: opening?.variant.id });
  } catch (error) {
    // Nothing reached Instagram: give the thread back so a retry can run.
    tryTransition(leadId, d, { from: ["browser_contact_sent"], to: "browser_contact_pending", owner: "none", actor: "system", reason: "send failed before delivery" });
    throw error;
  }
  if (outcome === "unknown") {
    tryTransition(leadId, d, { from: ["browser_contact_sent"], to: "human_review_required", owner: "human", actor: "system", reason: "delivery unknown" });
    return done("delivery unknown, escalated");
  }

  const followupDays = cadence?.variant.content.followupDays ?? followupDaysFor(lead, d);
  tryTransition(leadId, d, {
    from: ["browser_contact_sent"],
    to: "waiting_inbound_reply",
    actor: "browser",
    reason: "first DM sent",
    set: { lastOutboundAt: now, nextFollowupAt: followupDays[0] ? new Date(now.getTime() + followupDays[0] * DAY) : null },
  });
  d.update(leads).set({ contactedAt: now }).where(eq(leads.id, leadId)).run();
  advanceAtLeast(leadId, "contacted", { actor: "browser", reason: "first DM sent" }, d);
  startWarmupIfNeeded(now, d);
  return done("first DM sent");
};

/** The reply may have flipped the channel to the API mid-send; that is expected, not an error. */
function tryTransition(leadId: number, d: Db, input: Parameters<typeof transitionChannel>[1]): void {
  try {
    transitionChannel(leadId, input, d);
  } catch (error) {
    if (!(error instanceof ChannelLockError)) throw error;
    recordEvent("channel.transition_skipped", { leadId, actor: "system", payload: { to: input.to, reason: error.message } }, d);
  }
}

/** Cadence comes from the lead's follow-up experiment variant when one is running, else settings. */
function followupDaysFor(lead: Lead, d: Db): number[] {
  return assignVariant(lead.id, lead.funnel, "followup_cadence", d)?.variant.content.followupDays ?? getSettings(d).followupDays;
}

/** Enqueues due follow-ups and closes leads that never answered after the last one. */
export const scheduleFollowups: Handler = async ({ now, d }) => {
  const due = d
    .select({ conv: conversations, lead: leads })
    .from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.channelState, "waiting_inbound_reply"), isNotNull(conversations.nextFollowupAt), lte(conversations.nextFollowupAt, now)))
    .all();
  let queued = 0;
  for (const { conv, lead } of due) {
    if (conv.followupsSent >= followupDaysFor(lead, d).length) {
      transitionChannel(lead.id, { from: ["waiting_inbound_reply"], to: "completed", owner: "none", actor: "system", reason: "no reply after follow-ups", set: { nextFollowupAt: null } }, d);
      transitionPipeline(lead.id, "closed", { actor: "system", reason: "no reply" }, d);
      continue;
    }
    const n = conv.followupsSent + 1;
    if (enqueue("send_followup", { leadId: lead.id, n }, { idempotencyKey: `followup:${lead.id}:${n}`, priority: 3 }, d)) queued++;
  }
  return done(`${queued} follow-ups queued`);
};

export const sendFollowup: Handler = async (ctx) => {
  const { job, d, now, config } = ctx;
  const leadId = payloadNumber(job, "leadId");
  const n = payloadNumber(job, "n");
  const lead = d.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead || lead.pipelineStatus !== "contacted") return cancel("lead not waiting for a reply");
  const conv = getConversation(leadId, d);
  if (conv.channelState !== "waiting_inbound_reply" || conv.channelOwner !== "browser") return cancel(`channel is ${conv.channelState}`);
  const inbound = d.select({ id: messages.id }).from(messages).where(and(eq(messages.leadId, leadId), eq(messages.direction, "inbound"))).get();
  if (inbound) return cancel("lead already replied");
  const gate = gateBrowserSend(ctx, lead);
  if (!gate.ok) return gate.result;

  let body: string;
  try {
    body = await generateFollowup(lead, n, config, d);
  } catch (error) {
    if (!(error instanceof ContentBlockedError)) throw error;
    openException("content_blocked", "Follow-up bloqueado pelo filtro de afirmações.", { leadId, payload: { violations: error.violations } }, d);
    return done("follow-up blocked");
  }
  const outcome = await sendViaBrowser(ctx, lead, { kind: "followup", body, dedupeKey: `followup:${leadId}:${n}` });
  if (outcome === "unknown") {
    tryTransition(leadId, d, { from: ["waiting_inbound_reply"], to: "human_review_required", owner: "human", actor: "system", reason: "delivery unknown" });
    return done("delivery unknown, escalated");
  }
  const days = followupDaysFor(lead, d);
  const base = lead.contactedAt ?? now;
  const nextDay = days[n];
  // After the last follow-up wait one more week before closing as "no reply".
  const nextFollowupAt = nextDay ? new Date(base.getTime() + nextDay * DAY) : new Date(now.getTime() + 7 * DAY);
  d.update(conversations).set({ followupsSent: n, lastOutboundAt: now, nextFollowupAt, version: sql`${conversations.version} + 1` }).where(eq(conversations.id, conv.id)).run();
  return done(`follow-up ${n} sent`);
};
