import { and, desc, eq, gte } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import { conversations, leads, messages, webhookEvents, type Lead } from "@/db/schema";
import type { InboundEvent } from "@/integrations/instagram/webhook";
import { isDoNotContact } from "@/features/leads/do-not-contact";
import { normalizeHandle } from "@/features/leads/handle";
import { advanceAtLeast } from "@/features/leads/pipeline";
import { openException, recordEvent } from "@/features/safety/audit";
import { HOUR } from "@/lib/time";
import { getConversation, MESSAGING_WINDOW_MS, transitionChannel } from "./channel";

/** Idempotent on Meta's message id: redelivered webhooks are stored once. Returns ids to process. */
export function storeWebhookEvents(events: InboundEvent[], d: Db = db()): number[] {
  const ids: number[] = [];
  for (const e of events) {
    const row = d
      .insert(webhookEvents)
      .values({ externalId: e.mid, payload: { ...e, timestamp: e.timestamp.toISOString() } })
      .onConflictDoNothing({ target: webhookEvents.externalId })
      .returning({ id: webhookEvents.id })
      .get();
    if (row) ids.push(row.id);
  }
  return ids;
}

export function loadWebhookEvent(id: number, d: Db = db()): InboundEvent & { processed: boolean } {
  const row = d.select().from(webhookEvents).where(eq(webhookEvents.id, id)).get();
  if (!row) throw new Error(`webhook event ${id} not found`);
  const p = row.payload as Omit<InboundEvent, "timestamp"> & { timestamp: string };
  return { ...p, timestamp: new Date(p.timestamp), processed: row.processedAt !== null };
}

export type ResolveUsername = (igsid: string) => Promise<string | null>;

/** Matches a Meta IGSID to a lead: known mapping first, then the @handle from the Graph API. */
export async function resolveLead(igsid: string, resolveUsername: ResolveUsername, d: Db = db()): Promise<Lead | null> {
  const known = d.select({ lead: leads }).from(conversations).innerJoin(leads, eq(leads.id, conversations.leadId)).where(eq(conversations.metaIgsid, igsid)).get();
  if (known) return known.lead;
  const username = await resolveUsername(igsid);
  if (!username) return null;
  const lead = d.select().from(leads).where(eq(leads.handle, normalizeHandle(username))).get();
  if (!lead) return null;
  d.update(conversations).set({ metaIgsid: igsid }).where(eq(conversations.leadId, lead.id)).run();
  recordEvent("channel.igsid_matched", { leadId: lead.id, actor: "webhook", payload: { igsid, username } }, d);
  return lead;
}

export type InboundOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "accepted"; leadId: number; messageId: number }
  | { kind: "echo_matched"; leadId: number }
  | { kind: "human_took_over"; leadId: number };

/**
 * Handoff point. A lead's reply moves channel ownership to the official API and opens the
 * 24h window; from here on the browser is refused for this thread by the channel lock.
 */
export async function acceptInbound(event: InboundEvent, ownAccountId: string, resolveUsername: ResolveUsername, d: Db = db()): Promise<InboundOutcome> {
  if (event.isEcho) return handleEcho(event, resolveUsername, d);
  if (event.senderId === ownAccountId) return { kind: "ignored", reason: "own message" };
  if (isDoNotContact({ igsid: event.senderId }, d)) return { kind: "ignored", reason: "do_not_contact" };

  const lead = await resolveLead(event.senderId, resolveUsername, d);
  // Personal conversations of the account are never touched by the prospecting system.
  if (!lead) return { kind: "ignored", reason: "not a prospecting lead" };
  if (isDoNotContact({ handle: lead.handle }, d)) return { kind: "ignored", reason: "do_not_contact" };

  return tx((t) => {
    const message = t
      .insert(messages)
      .values({ leadId: lead.id, direction: "inbound", channel: "api", kind: "inbound", body: event.text, status: "received", externalId: event.mid, sentAt: event.timestamp })
      .onConflictDoNothing({ target: messages.externalId })
      .returning()
      .get();
    if (!message) return { kind: "ignored" as const, reason: "duplicate message" };

    const conv = getConversation(lead.id, t);
    const windowExpiresAt = new Date(event.timestamp.getTime() + MESSAGING_WINDOW_MS);
    const set = { lastInboundAt: event.timestamp, windowExpiresAt, nextFollowupAt: null, metaIgsid: event.senderId };
    if (["browser_contact_pending", "browser_contact_sent", "waiting_inbound_reply", "api_window_closed"].includes(conv.channelState)) {
      transitionChannel(lead.id, { from: [conv.channelState], to: "api_eligible", owner: "api", actor: "webhook", reason: "lead replied", set }, t);
    } else {
      t.update(conversations).set({ ...set, version: conv.version + 1 }).where(eq(conversations.id, conv.id)).run();
    }
    t.update(leads).set({ repliedAt: lead.repliedAt ?? event.timestamp }).where(eq(leads.id, lead.id)).run();
    advanceAtLeast(lead.id, "replied", { actor: "webhook", reason: "inbound message" }, t);
    recordEvent("message.inbound", { leadId: lead.id, actor: "webhook", payload: { messageId: message.id, channelState: conv.channelState } }, t);
    if (conv.channelState === "human_review_required") {
      openException("inbound_during_review", "O lead respondeu enquanto a conversa está com um humano.", { leadId: lead.id, payload: { messageId: message.id } }, t);
    }
    return { kind: "accepted" as const, leadId: lead.id, messageId: message.id };
  }, d);
}

/**
 * Echoes are our own outgoing messages. One that matches a browser DM we just sent teaches us
 * the lead's IGSID. One we have no record of means a human typed in the thread: the bot steps back.
 */
async function handleEcho(event: InboundEvent, resolveUsername: ResolveUsername, d: Db): Promise<InboundOutcome> {
  const known = d.select().from(messages).where(eq(messages.externalId, event.mid)).get();
  if (known) return { kind: "ignored", reason: "echo of api message" };
  const recentBrowser = d
    .select()
    .from(messages)
    .where(and(eq(messages.channel, "browser"), eq(messages.direction, "outbound"), eq(messages.body, event.text), gte(messages.createdAt, new Date(event.timestamp.getTime() - 2 * HOUR))))
    .orderBy(desc(messages.createdAt))
    .get();
  if (recentBrowser) {
    const conv = getConversation(recentBrowser.leadId, d);
    if (!conv.metaIgsid) d.update(conversations).set({ metaIgsid: event.recipientId }).where(eq(conversations.id, conv.id)).run();
    d.update(messages).set({ externalId: event.mid }).where(eq(messages.id, recentBrowser.id)).run();
    return { kind: "echo_matched", leadId: recentBrowser.leadId };
  }
  const lead = await resolveLead(event.recipientId, resolveUsername, d);
  if (!lead) return { kind: "ignored", reason: "echo in personal conversation" };
  const conv = getConversation(lead.id, d);
  if (conv.channelState === "human_review_required" || conv.channelState === "do_not_contact") return { kind: "ignored", reason: "already with human" };
  transitionChannel(lead.id, { from: [conv.channelState], to: "human_review_required", owner: "human", actor: "webhook", reason: "operator wrote manually in the thread" }, d);
  recordEvent("channel.divergence", { leadId: lead.id, actor: "webhook", payload: { mid: event.mid } }, d);
  return { kind: "human_took_over", leadId: lead.id };
}

export function markWebhookProcessed(id: number, now: Date, d: Db = db()): void {
  d.update(webhookEvents).set({ processedAt: now }).where(eq(webhookEvents.id, id)).run();
}
