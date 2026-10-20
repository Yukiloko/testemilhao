import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, type Db } from "@/db/client";
import { messages } from "@/db/schema";
import { getSettings, updateSettings, type RuntimeSettings } from "@/features/safety/settings";
import { DAY, isWithinWindow, localDay, nextWindowOpening, randomBetween } from "@/lib/time";

export type PacingDecision = { ok: true } | { ok: false; reason: string; retryAt: Date };

/** 5/day in week one, +5 per week, never above the configured daily maximum. */
export function warmupCap(settings: RuntimeSettings, now: Date): number {
  if (!settings.warmupStartedAt) return Math.min(5, settings.maxDmsPerDay);
  const weeks = Math.floor((now.getTime() - new Date(settings.warmupStartedAt).getTime()) / (7 * DAY));
  return Math.min(settings.maxDmsPerDay, 5 + 5 * Math.max(0, weeks));
}

function browserSendsSince(since: Date, d: Db): number {
  const row = d
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.channel, "browser"), eq(messages.direction, "outbound"), inArray(messages.status, ["sent", "pending"]), gte(messages.createdAt, since)))
    .get();
  return row?.n ?? 0;
}

function startOfLocalDay(now: Date, timeZone: string): Date {
  // Walk back minute-by-minute is wasteful; step back hours until the local day changes.
  const today = localDay(now, timeZone);
  let probe = new Date(now);
  while (localDay(new Date(probe.getTime() - 60 * 60_000), timeZone) === today) probe = new Date(probe.getTime() - 60 * 60_000);
  while (localDay(new Date(probe.getTime() - 60_000), timeZone) === today) probe = new Date(probe.getTime() - 60_000);
  probe.setUTCSeconds(0, 0);
  return probe;
}

/**
 * Account-health pacing for browser DMs (first contact and follow-ups): operating window,
 * warm-up quota, daily cap and a randomised human interval since the last send.
 */
export function checkBrowserPacing(now: Date, d: Db = db(), random: () => number = Math.random): PacingDecision {
  const s = getSettings(d);
  if (!isWithinWindow(now, s.operatingHours, s.operatingTimezone)) {
    return { ok: false, reason: "outside_operating_hours", retryAt: nextWindowOpening(now, s.operatingHours, s.operatingTimezone) };
  }
  const dayStart = startOfLocalDay(now, s.operatingTimezone);
  const cap = warmupCap(s, now);
  if (browserSendsSince(dayStart, d) >= cap) {
    const tomorrow = new Date(dayStart.getTime() + DAY);
    return { ok: false, reason: `daily_cap_${cap}`, retryAt: nextWindowOpening(tomorrow, s.operatingHours, s.operatingTimezone) };
  }
  const last = d
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.channel, "browser"), eq(messages.direction, "outbound"), inArray(messages.status, ["sent", "pending"])))
    .orderBy(desc(messages.createdAt))
    .get();
  if (last) {
    const gapMs = randomBetween(s.minSecondsBetweenDms, s.maxSecondsBetweenDms, random) * 1000;
    const earliest = last.at.getTime() + gapMs;
    if (earliest > now.getTime()) return { ok: false, reason: "interval", retryAt: new Date(earliest) };
  }
  return { ok: true };
}

export function startWarmupIfNeeded(now: Date, d: Db = db()): void {
  if (!getSettings(d).warmupStartedAt) updateSettings({ warmupStartedAt: now.toISOString() }, d);
}
