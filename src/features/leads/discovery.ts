import { eq } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import { conversations, leads, type Funnel, type Lead, type NewLead, type ProfileSignals } from "@/db/schema";
import { recordEvent } from "@/features/safety/audit";
import { isDoNotContact } from "./do-not-contact";
import { isValidHandle, normalizeHandle } from "./handle";

export type DiscoveredProfile = {
  handle: string;
  funnel: Funnel;
  source: NewLead["source"];
  sourceDetail?: string;
  displayName?: string | null;
  bio?: string | null;
  category?: string | null;
  location?: string | null;
  externalUrl?: string | null;
  followers?: number | null;
  following?: number | null;
  postsCount?: number | null;
  signals?: ProfileSignals;
};

export type DiscoveryResult =
  | { outcome: "created"; lead: Lead }
  | { outcome: "updated"; lead: Lead }
  | { outcome: "skipped"; reason: "invalid_handle" | "do_not_contact" | "own_account" };

/**
 * Idempotent: the unique handle index guarantees one lead per profile across both funnels.
 * A re-discovered profile only refreshes its public data; funnel and status are never reset.
 */
export function registerDiscoveredProfile(profile: DiscoveredProfile, ownHandle: string, d: Db = db()): DiscoveryResult {
  const handle = normalizeHandle(profile.handle);
  if (!isValidHandle(handle)) return { outcome: "skipped", reason: "invalid_handle" };
  if (handle === normalizeHandle(ownHandle)) return { outcome: "skipped", reason: "own_account" };
  if (isDoNotContact({ handle }, d)) return { outcome: "skipped", reason: "do_not_contact" };

  const publicData = {
    displayName: profile.displayName ?? undefined,
    bio: profile.bio ?? undefined,
    category: profile.category ?? undefined,
    location: profile.location ?? undefined,
    externalUrl: profile.externalUrl ?? undefined,
    followers: profile.followers ?? undefined,
    following: profile.following ?? undefined,
    postsCount: profile.postsCount ?? undefined,
  };

  return tx((t) => {
    const existing = t.select().from(leads).where(eq(leads.handle, handle)).get();
    if (existing) {
      const signals = { ...existing.signals, ...profile.signals };
      const lead = t.update(leads).set({ ...publicData, signals }).where(eq(leads.id, existing.id)).returning().get();
      return { outcome: "updated" as const, lead };
    }
    const lead = t
      .insert(leads)
      .values({ handle, funnel: profile.funnel, source: profile.source, sourceDetail: profile.sourceDetail, signals: profile.signals ?? {}, ...publicData })
      .returning()
      .get();
    t.insert(conversations).values({ leadId: lead.id }).run();
    recordEvent("lead.discovered", { leadId: lead.id, actor: "system", payload: { source: profile.source, detail: profile.sourceDetail, funnel: profile.funnel } }, t);
    return { outcome: "created" as const, lead };
  }, d);
}
