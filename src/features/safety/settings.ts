import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Db } from "@/db/client";
import { settings } from "@/db/schema";

/**
 * Runtime limits editable from the panel. Defaults come from .env; the panel can tighten them.
 * Hard ceilings below can never be exceeded, by the operator UI or by the optimizer.
 */
export const HARD_LIMITS = { maxDmsPerDay: 60, minSecondsBetweenDms: 60 } as const;

export const runtimeSettingsSchema = z.object({
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  maxDmsPerDay: z.number().int().min(0).max(HARD_LIMITS.maxDmsPerDay),
  minSecondsBetweenDms: z.number().int().min(HARD_LIMITS.minSecondsBetweenDms),
  maxSecondsBetweenDms: z.number().int().min(HARD_LIMITS.minSecondsBetweenDms),
  operatingHours: z.string(),
  operatingTimezone: z.string(),
  warmupStartedAt: z.string().nullable(),
  followupDays: z.array(z.number().positive()).max(4),
  discoveryEnabled: z.boolean(),
  autoReplyEnabled: z.boolean(),
  minQualifyScore: z.number().min(0).max(100),
  minConfidenceToAutoReply: z.number().min(0).max(1),
  browserAvailable: z.boolean(),
  /** Learned by the optimizer from conversion data; bounded so it can only nudge priorities. */
  nicheInsights: z.record(z.string(), z.object({ boost: z.number().min(-15).max(15), bestHour: z.number().int().min(0).max(23).nullable(), samples: z.number() })),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

function defaults(): RuntimeSettings {
  return {
    paused: false,
    pauseReason: null,
    maxDmsPerDay: Number(process.env.MAX_DMS_PER_DAY ?? 30),
    minSecondsBetweenDms: Number(process.env.MIN_SECONDS_BETWEEN_DMS ?? 90),
    maxSecondsBetweenDms: Number(process.env.MAX_SECONDS_BETWEEN_DMS ?? 240),
    operatingHours: process.env.OPERATING_HOURS ?? "09:00-20:00",
    operatingTimezone: process.env.OPERATING_TIMEZONE ?? "America/Sao_Paulo",
    warmupStartedAt: null,
    followupDays: [3, 7],
    discoveryEnabled: true,
    autoReplyEnabled: true,
    minQualifyScore: 55,
    minConfidenceToAutoReply: 0.6,
    browserAvailable: true,
    nicheInsights: {},
  };
}

export function getSettings(d: Db = db()): RuntimeSettings {
  const rows = d.select().from(settings).all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return runtimeSettingsSchema.parse({ ...defaults(), ...stored });
}

export function updateSettings(patch: Partial<RuntimeSettings>, d: Db = db()): RuntimeSettings {
  const next = runtimeSettingsSchema.parse({ ...getSettings(d), ...patch });
  for (const [key, value] of Object.entries(patch)) {
    d.insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`(unixepoch('subsec') * 1000)` } })
      .run();
  }
  return next;
}

export function deleteSetting(key: keyof RuntimeSettings, d: Db = db()): void {
  d.delete(settings).where(eq(settings.key, key)).run();
}
