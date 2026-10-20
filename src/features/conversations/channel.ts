import { and, eq, inArray, sql } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import { conversations, type ChannelOwner, type ChannelState, type Conversation } from "@/db/schema";
import { recordEvent } from "@/features/safety/audit";
import { HOUR } from "@/lib/time";

/** Instagram allows automated replies only within 24h of the user's last message. */
export const MESSAGING_WINDOW_MS = 24 * HOUR;

/** States from which each owner may write to the thread. Anything else is refused. */
export const WRITABLE: Record<"browser" | "api", readonly ChannelState[]> = {
  browser: ["browser_contact_pending", "waiting_inbound_reply"],
  api: ["api_eligible", "api_active"],
};

/** Terminal for automation: nothing is sent from these states, by any channel. */
export const CLOSED_STATES: readonly ChannelState[] = ["do_not_contact", "blocked", "completed", "human_review_required"];

export class ChannelLockError extends Error {}

export function getConversation(leadId: number, d: Db = db()): Conversation {
  const conv = d.select().from(conversations).where(eq(conversations.leadId, leadId)).get();
  if (!conv) throw new ChannelLockError(`No conversation for lead ${leadId}`);
  return conv;
}

/**
 * Compare-and-swap on (version, state). This is the channel ownership lock: two writers that
 * read the same version cannot both win, so browser and API never own a thread at the same time.
 */
export function transitionChannel(
  leadId: number,
  input: {
    from: readonly ChannelState[];
    to: ChannelState;
    owner?: ChannelOwner;
    actor: "system" | "ai" | "operator" | "webhook" | "browser";
    reason: string;
    set?: Partial<typeof conversations.$inferInsert>;
  },
  d: Db = db(),
): Conversation {
  return tx((t) => {
    const conv = getConversation(leadId, t);
    if (!input.from.includes(conv.channelState)) {
      throw new ChannelLockError(`lead ${leadId}: channel ${conv.channelState} -> ${input.to} refused (${input.reason})`);
    }
    const result = t
      .update(conversations)
      .set({
        ...input.set,
        channelState: input.to,
        ...(input.owner ? { channelOwner: input.owner } : {}),
        version: conv.version + 1,
        updatedAt: sql`(unixepoch('subsec') * 1000)`,
      })
      .where(and(eq(conversations.id, conv.id), eq(conversations.version, conv.version), inArray(conversations.channelState, [...input.from])))
      .returning()
      .get();
    if (!result) throw new ChannelLockError(`lead ${leadId}: concurrent channel change detected`);
    recordEvent("channel.changed", { leadId, actor: input.actor, payload: { from: conv.channelState, to: input.to, owner: result.channelOwner, reason: input.reason } }, t);
    return result;
  }, d);
}

export function assertCanWrite(conv: Conversation, writer: "browser" | "api", now: Date): void {
  if (!WRITABLE[writer].includes(conv.channelState)) {
    throw new ChannelLockError(`${writer} may not write while channel is ${conv.channelState}`);
  }
  const otherOwner = writer === "browser" ? "api" : "browser";
  if (conv.channelOwner === otherOwner || conv.channelOwner === "human") {
    throw new ChannelLockError(`${writer} may not write: thread owned by ${conv.channelOwner}`);
  }
  if (writer === "api" && !isWindowOpen(conv, now)) {
    throw new ChannelLockError("messaging window closed");
  }
}

export function isWindowOpen(conv: Conversation, now: Date): boolean {
  return !!conv.windowExpiresAt && conv.windowExpiresAt.getTime() > now.getTime();
}

/** Closes expired windows so the panel and the worker agree on what can be sent. */
export function closeExpiredWindow(leadId: number, now: Date, d: Db = db()): boolean {
  const conv = getConversation(leadId, d);
  if (!WRITABLE.api.includes(conv.channelState) || isWindowOpen(conv, now)) return false;
  transitionChannel(leadId, { from: WRITABLE.api, to: "api_window_closed", actor: "system", reason: "24h messaging window expired" }, d);
  return true;
}
