import { eq } from "drizzle-orm";
import { leads } from "@/db/schema";
import { registerDiscoveredProfile } from "@/features/leads/discovery";
import { applyQualification, qualify } from "@/features/leads/qualification";
import { getSettings } from "@/features/safety/settings";
import { collectHashtagAuthors, readProfile } from "@/integrations/browser/instagram";
import { ProfileNotFoundError } from "@/integrations/browser/errors";
import { transitionPipeline } from "@/features/leads/pipeline";
import { recordEvent } from "@/features/safety/audit";
import { HOUR, localDay } from "@/lib/time";
import { cancel, done, later, payloadNumber, payloadString, type Handler } from "../context";
import { enqueue } from "../queue";

/** Daily: one hashtag job per ICP keyword / affiliate topic. */
export const planDiscovery: Handler = async ({ now, d, config }) => {
  const s = getSettings(d);
  if (!s.discoveryEnabled || s.paused) return done("discovery disabled or paused");
  const day = localDay(now, s.operatingTimezone);
  const tags = [
    ...config.icpKeywords.map((tag) => ({ tag, funnel: "customer" as const })),
    ...config.affiliateTopics.map((tag) => ({ tag, funnel: "affiliate" as const })),
  ];
  tags.forEach(({ tag, funnel }, i) => {
    const clean = tag.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase();
    if (!clean) return;
    enqueue("discover_hashtag", { tag: clean, funnel }, { idempotencyKey: `discover:${day}:${funnel}:${clean}`, runAt: new Date(now.getTime() + i * 10 * 60_000) }, d);
  });
  return done(`${tags.length} discovery jobs planned`);
};

export const discoverHashtag: Handler = async ({ job, now, d, config, browser, baseUrl }) => {
  if (getSettings(d).paused) return later(new Date(now.getTime() + HOUR), "paused");
  const tag = payloadString(job, "tag");
  const funnel = job.payload.funnel === "affiliate" ? "affiliate" : "customer";
  const handles = await browser({ jobId: job.id }, (page) => collectHashtagAuthors(page, baseUrl, tag));
  let created = 0;
  for (const handle of handles) {
    const result = registerDiscoveredProfile({ handle, funnel, source: "hashtag", sourceDetail: `#${tag}` }, config.instagramHandle, d);
    if (result.outcome === "created") {
      created++;
      enqueue("enrich_profile", { leadId: result.lead.id }, { idempotencyKey: `enrich:${result.lead.id}` }, d);
    }
  }
  return done(`#${tag}: ${handles.length} authors, ${created} new`);
};

export const enrichProfile: Handler = async ({ job, now, d, config, browser, baseUrl }) => {
  if (getSettings(d).paused) return later(new Date(now.getTime() + HOUR), "paused");
  const leadId = payloadNumber(job, "leadId");
  const lead = d.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead || lead.pipelineStatus !== "discovered") return cancel("lead no longer in discovered");
  try {
    const profile = await browser({ jobId: job.id, leadId }, (page) => readProfile(page, baseUrl, lead.handle));
    registerDiscoveredProfile({ ...profile, funnel: lead.funnel, source: lead.source }, config.instagramHandle, d);
  } catch (error) {
    if (!(error instanceof ProfileNotFoundError)) throw error;
    transitionPipeline(leadId, "closed", { actor: "browser", reason: "profile not found" }, d);
    return done("profile not found");
  }
  enqueue("qualify_lead", { leadId }, { idempotencyKey: `qualify:${leadId}` }, d);
  return done();
};

export const qualifyLead: Handler = async ({ job, d, config }) => {
  const leadId = payloadNumber(job, "leadId");
  const lead = d.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead || lead.pipelineStatus !== "discovered") return cancel("lead no longer in discovered");
  const s = getSettings(d);
  const q = qualify(lead, config);
  const insight = q.niche ? s.nicheInsights[q.niche] : undefined;
  const outcome = applyQualification(lead, q, { minScore: s.minQualifyScore, nicheBoost: insight?.boost, bestSendHour: insight?.bestHour ?? null }, d);
  recordEvent("lead.qualification_decided", { leadId, actor: "system", payload: { outcome, score: q.score } }, d);
  return done(outcome);
};

/** One discovery planner per local day; the idempotency key makes repeated calls harmless. */
export function ensureDailyDiscovery(now: Date, timeZone: string, d: Parameters<typeof enqueue>[3]): void {
  enqueue("plan_discovery", {}, { idempotencyKey: `plan_discovery:${localDay(now, timeZone)}` }, d);
}
