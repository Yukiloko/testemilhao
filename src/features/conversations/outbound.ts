import { and, eq } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import { messages, type Message } from "@/db/schema";
import { trip } from "@/features/safety/circuit-breaker";
import { recordEvent } from "@/features/safety/audit";

export class DuplicateSendError extends Error {}

type Reservation = {
  leadId: number;
  channel: "browser" | "api";
  kind: "opening" | "followup" | "reply";
  body: string;
  dedupeKey: string;
  experimentId?: number | null;
  variantId?: number | null;
};

/**
 * Reserves an outbound slot BEFORE talking to Instagram. The unique dedupe key is the
 * duplicate-send lock:
 *  - no row          -> reserve and send
 *  - row "failed"    -> we know nothing left; reuse the row and retry
 *  - row "blocked"   -> retry allowed (content guard blocked it, nothing left)
 *  - row "pending"   -> a previous attempt crashed mid-send; it MAY have been delivered.
 *                       Refuse, and trip the breaker so a human reconciles.
 *  - row "sent"      -> already delivered; refuse.
 */
export function reserveOutbound(r: Reservation, d: Db = db()): Message {
  const result = tx((t) => {
    const existing = t.select().from(messages).where(eq(messages.dedupeKey, r.dedupeKey)).get();
    if (existing?.status === "sent" || existing?.status === "pending") return { conflict: existing.status };
    if (existing) {
      return t
        .update(messages)
        .set({ status: "pending", body: r.body, error: null, variantId: r.variantId ?? null, experimentId: r.experimentId ?? null })
        .where(eq(messages.id, existing.id))
        .returning()
        .get();
    }
    return t
      .insert(messages)
      .values({ ...r, direction: "outbound", status: "pending", experimentId: r.experimentId ?? null, variantId: r.variantId ?? null })
      .returning()
      .get();
  }, d);
  if ("conflict" in result) {
    if (result.conflict === "pending") {
      // Outside the transaction on purpose: the pause must persist even though we refuse.
      recordEvent("message.duplicate_suspected", { leadId: r.leadId, actor: "system", payload: { dedupeKey: r.dedupeKey } }, d);
      trip("duplicateSend", d);
      throw new DuplicateSendError(`unresolved in-flight send: ${r.dedupeKey}`);
    }
    throw new DuplicateSendError(`already sent: ${r.dedupeKey}`);
  }
  return result;
}

export function markSent(messageId: number, externalId: string | null, now: Date, d: Db = db()): void {
  d.update(messages).set({ status: "sent", sentAt: now, externalId }).where(and(eq(messages.id, messageId), eq(messages.status, "pending"))).run();
}

/** Only call when it is certain nothing reached Instagram (e.g. failure before pressing send). */
export function markFailed(messageId: number, error: string, d: Db = db()): void {
  d.update(messages).set({ status: "failed", error }).where(eq(messages.id, messageId)).run();
}

export function markBlocked(messageId: number, error: string, d: Db = db()): void {
  d.update(messages).set({ status: "blocked", error }).where(eq(messages.id, messageId)).run();
}
