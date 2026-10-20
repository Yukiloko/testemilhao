import { and, desc, eq, inArray } from "drizzle-orm";
import { aiDecisions, conversations, leads, messages } from "@/db/schema";
import { closeExpiredWindow, getConversation, isWindowOpen, transitionChannel, WRITABLE } from "@/features/conversations/channel";
import { ContentBlockedError, decideNextStep, type Decision } from "@/features/conversations/engine";
import { acceptInbound, loadWebhookEvent, markWebhookProcessed, type ResolveUsername } from "@/features/conversations/inbound";
import { markFailed, markSent, reserveOutbound } from "@/features/conversations/outbound";
import { isDoNotContact, markDoNotContact } from "@/features/leads/do-not-contact";
import { advanceAtLeast, transitionPipeline } from "@/features/leads/pipeline";
import { openException, recordEvent } from "@/features/safety/audit";
import { getSettings } from "@/features/safety/settings";
import { GraphApiError } from "@/integrations/instagram/api";
import { MINUTE } from "@/lib/time";
import { cancel, done, later, payloadNumber, type Handler } from "../context";
import { enqueue } from "../queue";

export type InstagramApi = {
  ownAccountId: string;
  configured: boolean;
  resolveUsername: ResolveUsername;
  send: (igsid: string, text: string) => Promise<{ messageId: string }>;
};

/** Small debounce so a burst of messages from the lead gets one considered answer. */
const REPLY_DEBOUNCE_MS = 20_000;

export const createProcessInbound =
  (api: InstagramApi): Handler =>
  async ({ job, now, d }) => {
    const id = payloadNumber(job, "webhookEventId");
    const event = loadWebhookEvent(id, d);
    if (event.processed) return done("already processed");
    const outcome = await acceptInbound(event, api.ownAccountId, api.resolveUsername, d);
    markWebhookProcessed(id, now, d);
    if (outcome.kind === "accepted") {
      enqueue(
        "reply_inbound",
        { leadId: outcome.leadId, inboundMessageId: outcome.messageId },
        { idempotencyKey: `reply:${outcome.messageId}`, runAt: new Date(now.getTime() + REPLY_DEBOUNCE_MS), priority: 10 },
        d,
      );
    }
    return done(outcome.kind === "ignored" ? `ignored: ${outcome.reason}` : outcome.kind);
  };

function recordDecision(leadId: number, inboundMessageId: number, decision: Decision, outcome: (typeof aiDecisions.$inferInsert)["outcome"], d: Parameters<Handler>[0]["d"]) {
  d.insert(aiDecisions).values({ leadId, inboundMessageId, ...decision, outcome }).run();
  recordEvent("ai.decision", { leadId, actor: "ai", payload: { intent: decision.intent, action: decision.action, confidence: decision.confidence, outcome } }, d);
}

function escalate(leadId: number, reason: string, d: Parameters<Handler>[0]["d"]) {
  const conv = getConversation(leadId, d);
  if (conv.channelState !== "human_review_required") {
    transitionChannel(leadId, { from: [conv.channelState], to: "human_review_required", owner: "human", actor: "ai", reason }, d);
  }
  openException("needs_human", reason, { leadId }, d);
}

/**
 * Interprets the lead's message, applies the decision to the CRM and replies through the
 * official API. Never falls back to the browser: if the API cannot send, it goes to exceptions.
 */
export const createReplyInbound =
  (api: InstagramApi): Handler =>
  async ({ job, now, d, config }) => {
    const leadId = payloadNumber(job, "leadId");
    const inboundMessageId = payloadNumber(job, "inboundMessageId");
    const s = getSettings(d);
    if (s.paused) return later(new Date(now.getTime() + 5 * MINUTE), "system paused");

    const lead = d.select().from(leads).where(eq(leads.id, leadId)).get();
    if (!lead || isDoNotContact({ handle: lead.handle }, d)) return cancel("lead gone or do_not_contact");
    const newer = d
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.leadId, leadId), eq(messages.direction, "inbound")))
      .orderBy(desc(messages.id))
      .get();
    if (newer && newer.id !== inboundMessageId) return cancel("a newer inbound message will be answered instead");
    const inbound = d.select().from(messages).where(eq(messages.id, inboundMessageId)).get();
    if (!inbound) return cancel("inbound message missing");

    closeExpiredWindow(leadId, now, d);
    const conv = getConversation(leadId, d);
    if (!WRITABLE.api.includes(conv.channelState)) {
      if (conv.channelState === "api_window_closed") openException("api_window_closed", "Janela de 24h expirou antes da resposta.", { leadId }, d);
      return done(`not answering: channel ${conv.channelState}`);
    }
    if (!api.configured) {
      escalate(leadId, "API oficial do Instagram não configurada", d);
      return done("api not configured");
    }
    if (!s.autoReplyEnabled) {
      escalate(leadId, "Resposta automática desativada no painel", d);
      return done("auto reply disabled");
    }

    let decision: Decision;
    try {
      decision = await decideNextStep(lead, inbound.body, config, d);
    } catch (error) {
      if (!(error instanceof ContentBlockedError)) throw error;
      escalate(leadId, `Resposta bloqueada pelo filtro de afirmações: ${error.violations.join("; ")}`, d);
      return done("reply blocked by claims guard");
    }

    if (decision.intent === "opt_out") {
      recordDecision(leadId, inboundMessageId, decision, "no_reply", d);
      markDoNotContact(leadId, "lead asked to stop", "ai", d);
      return done("opted out");
    }
    if (decision.action === "escalate" || decision.confidence < s.minConfidenceToAutoReply) {
      recordDecision(leadId, inboundMessageId, decision, "escalated", d);
      escalate(leadId, `IA pediu revisão humana (${decision.intent}, confiança ${decision.confidence.toFixed(2)})`, d);
      return done("escalated");
    }

    if (["interested", "asked_info", "asked_pricing", "wants_whatsapp"].includes(decision.intent)) {
      advanceAtLeast(leadId, "interested", { actor: "ai", reason: decision.intent }, d);
    }

    if (decision.reply) {
      const sent = await sendApiReply(api, { leadId, inboundMessageId, body: decision.reply, now, d });
      if (sent !== "sent") {
        recordDecision(leadId, inboundMessageId, decision, "failed", d);
        return done(`reply ${sent}`);
      }
    }
    recordDecision(leadId, inboundMessageId, decision, decision.reply ? "sent" : "no_reply", d);

    if (decision.action === "send_whatsapp" && decision.reply) {
      if (lead.funnel === "customer") advanceAtLeast(leadId, "whatsapp_handoff", { actor: "ai", reason: "sent WhatsApp link" }, d);
      else recordEvent("affiliate.group_link_sent", { leadId, actor: "ai" }, d);
    }
    if (decision.action === "close" || decision.intent === "not_interested") {
      transitionPipeline(leadId, "closed", { actor: "ai", reason: decision.intent }, d);
      transitionChannel(leadId, { from: [...WRITABLE.api], to: "completed", owner: "none", actor: "ai", reason: decision.intent }, d);
    }
    return done(`${decision.intent} -> ${decision.action}`);
  };

/** Pre-send checks, then the official Send API, with the reservation protecting against duplicates. */
async function sendApiReply(
  api: InstagramApi,
  input: { leadId: number; inboundMessageId: number; body: string; now: Date; d: Parameters<Handler>[0]["d"] },
): Promise<"sent" | "refused" | "unknown"> {
  const { d, leadId, now } = input;
  const conv = getConversation(leadId, d);
  const refusal =
    !conv.metaIgsid ? "recipient IGSID unknown" :
    !WRITABLE.api.includes(conv.channelState) ? `channel ${conv.channelState}` :
    conv.channelOwner !== "api" ? `thread owned by ${conv.channelOwner}` :
    !isWindowOpen(conv, now) ? "messaging window closed" :
    null;
  if (refusal) {
    openException("api_send_refused", `Envio pela API recusado: ${refusal}`, { leadId }, d);
    return "refused";
  }

  const reserved = reserveOutbound({ leadId, channel: "api", kind: "reply", body: input.body, dedupeKey: `reply:${input.inboundMessageId}` }, d);
  try {
    const { messageId } = await api.send(conv.metaIgsid!, input.body);
    markSent(reserved.id, messageId, now, d);
  } catch (error) {
    if (error instanceof GraphApiError) {
      markFailed(reserved.id, error.message, d);
      if (error.isPermanent) {
        openException("api_error", `API do Instagram recusou o envio: ${error.message}`, { leadId, payload: { code: error.code, subcode: error.subcode } }, d);
        return "refused";
      }
      throw error;
    }
    // Network failure mid-request: Meta may have delivered it. Leave the reservation pending.
    openException("delivery_unknown", "Falha de rede ao enviar pela API; a mensagem pode ter sido entregue.", { leadId, payload: { messageId: reserved.id } }, d);
    return "unknown";
  }
  if (conv.channelState === "api_eligible") {
    transitionChannel(leadId, { from: ["api_eligible"], to: "api_active", owner: "api", actor: "ai", reason: "first API reply", set: { lastOutboundAt: now } }, d);
  } else {
    d.update(conversations).set({ lastOutboundAt: now }).where(eq(conversations.id, conv.id)).run();
  }
  recordEvent("message.outbound", { leadId, actor: "ai", payload: { kind: "reply", channel: "api", messageId: reserved.id } }, d);
  return "sent";
}

/** Periodic: moves threads whose 24h window lapsed to api_window_closed. */
export const expireWindows: Handler = async ({ now, d }) => {
  const open = d.select({ leadId: conversations.leadId }).from(conversations).where(inArray(conversations.channelState, [...WRITABLE.api])).all();
  let closed = 0;
  for (const { leadId } of open) if (closeExpiredWindow(leadId, now, d)) closed++;
  return done(`${closed} windows closed`);
};
