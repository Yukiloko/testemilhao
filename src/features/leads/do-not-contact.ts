import { eq, or } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import { conversations, doNotContact, leads } from "@/db/schema";
import { recordEvent } from "@/features/safety/audit";
import { normalizeHandle } from "./handle";

export function isDoNotContact(input: { handle?: string | null; igsid?: string | null }, d: Db = db()): boolean {
  const conds = [];
  if (input.handle) conds.push(eq(doNotContact.handle, normalizeHandle(input.handle)));
  if (input.igsid) conds.push(eq(doNotContact.metaIgsid, input.igsid));
  if (conds.length === 0) return false;
  return d.select({ id: doNotContact.id }).from(doNotContact).where(or(...conds)).get() !== undefined;
}

/**
 * Permanent and global: no follow-up, no other campaign, no channel. Closes the lead and
 * moves the conversation to do_not_contact in the same transaction.
 */
export function markDoNotContact(leadId: number, reason: string, actor: "ai" | "operator" | "system", d: Db = db()): void {
  tx((t) => {
    const lead = t.select().from(leads).where(eq(leads.id, leadId)).get();
    if (!lead) return;
    const conv = t.select().from(conversations).where(eq(conversations.leadId, leadId)).get();
    t.insert(doNotContact)
      .values({ handle: lead.handle, metaIgsid: conv?.metaIgsid ?? null, reason })
      .onConflictDoNothing()
      .run();
    t.update(leads).set({ pipelineStatus: "closed", closedReason: `do_not_contact: ${reason}`, nextAction: null, nextActionAt: null }).where(eq(leads.id, leadId)).run();
    if (conv) {
      t.update(conversations)
        .set({ channelState: "do_not_contact", channelOwner: "none", nextFollowupAt: null, version: conv.version + 1 })
        .where(eq(conversations.id, conv.id))
        .run();
    }
    recordEvent("lead.opted_out", { leadId, actor, payload: { reason } }, t);
  }, d);
}
