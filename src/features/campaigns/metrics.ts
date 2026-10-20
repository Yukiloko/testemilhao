import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db, type Db } from "@/db/client";
import { aiCalls, alerts, conversations, events, exceptions, leads, messages, type Funnel } from "@/db/schema";
import { monthlySpendUsd } from "@/features/safety/budget";
import { warmupCap } from "./pacing";
import { getSettings } from "@/features/safety/settings";
import { localDay, localHour } from "@/lib/time";

export function pipelineCounts(funnel: Funnel, d: Db = db()): Record<string, number> {
  const rows = d.select({ status: leads.pipelineStatus, n: sql<number>`count(*)` }).from(leads).where(eq(leads.funnel, funnel)).groupBy(leads.pipelineStatus).all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Leads that ever reached each stage (from the audit trail), so closed leads still count. */
export function reachedCounts(funnel: Funnel, d: Db = db()): Record<string, number> {
  const rows = d
    .select({ stage: sql<string>`json_extract(${events.payload}, '$.to')`, n: sql<number>`count(distinct ${events.leadId})` })
    .from(events)
    .innerJoin(leads, eq(leads.id, events.leadId))
    .where(and(eq(events.type, "lead.pipeline_changed"), eq(leads.funnel, funnel)))
    .groupBy(sql`json_extract(${events.payload}, '$.to')`)
    .all();
  return Object.fromEntries(rows.map((r) => [r.stage, r.n]));
}

export type Breakdown = { key: string; contacted: number; replied: number; interested: number; converted: number };

/** Conversion by any lead dimension. `converted` = whatsapp_handoff+ (customers) or joined group+ (affiliates). */
export function conversionBy(dimension: "niche" | "source" | "role" | "hour" | "variant", funnel: Funnel, timeZone: string, d: Db = db()): Breakdown[] {
  const converted = funnel === "customer" ? ["whatsapp_handoff", "registered", "active_customer"] : ["joined_affiliate_group", "active_affiliate", "generated_customer"];
  const interested = ["interested", ...converted];
  const reached = (stages: string[]) =>
    sql<number>`exists (select 1 from events e where e.lead_id = ${sql.raw('"leads"."id"')} and e.type = 'lead.pipeline_changed' and json_extract(e.payload, '$.to') in (${sql.join(stages.map((s) => sql`${s}`), sql`, `)}))`;
  const rows = d
    .select({
      niche: leads.niche,
      source: leads.source,
      role: leads.role,
      contactedAt: leads.contactedAt,
      repliedAt: leads.repliedAt,
      variant: sql<string | null>`(select v.key from experiment_assignments a join experiment_variants v on v.id = a.variant_id join experiments x on x.id = a.experiment_id where a.lead_id = ${sql.raw('"leads"."id"')} and x.variable = 'opening' order by a.id desc limit 1)`,
      interested: reached(interested),
      converted: reached(converted),
    })
    .from(leads)
    .where(and(eq(leads.funnel, funnel), isNotNull(leads.contactedAt)))
    .all();
  const map = new Map<string, Breakdown>();
  for (const r of rows) {
    const key = dimension === "hour" ? `${String(localHour(r.contactedAt!, timeZone)).padStart(2, "0")}h` : (r[dimension] ?? "—");
    const b = map.get(key) ?? { key, contacted: 0, replied: 0, interested: 0, converted: 0 };
    b.contacted++;
    if (r.repliedAt) b.replied++;
    if (r.interested) b.interested++;
    if (r.converted) b.converted++;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => b.contacted - a.contacted);
}

export function costOverview(now: Date, d: Db = db()) {
  const totals = d
    .select({ cost: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`, calls: sql<number>`count(*)` })
    .from(aiCalls)
    .get();
  const leadsWithAi = d.select({ n: sql<number>`count(distinct ${aiCalls.leadId})` }).from(aiCalls).where(isNotNull(aiCalls.leadId)).get();
  const activeCustomers = d.select({ n: sql<number>`count(*)` }).from(leads).where(eq(leads.pipelineStatus, "active_customer")).get();
  const byModel = d
    .select({ model: aiCalls.model, purpose: aiCalls.purpose, cost: sql<number>`sum(${aiCalls.costUsd})`, calls: sql<number>`count(*)`, failures: sql<number>`sum(case when ${aiCalls.ok} then 0 else 1 end)` })
    .from(aiCalls)
    .groupBy(aiCalls.model, aiCalls.purpose)
    .orderBy(desc(sql`sum(${aiCalls.costUsd})`))
    .all();
  const total = totals?.cost ?? 0;
  return {
    totalUsd: total,
    monthUsd: monthlySpendUsd(now, d),
    calls: totals?.calls ?? 0,
    perLeadUsd: leadsWithAi?.n ? total / leadsWithAi.n : 0,
    perActiveCustomerUsd: activeCustomers?.n ? total / activeCustomers.n : null,
    activeCustomers: activeCustomers?.n ?? 0,
    byModel,
  };
}

export function todayActivity(now: Date, d: Db = db()) {
  const s = getSettings(d);
  const today = localDay(now, s.operatingTimezone);
  const recent = d
    .select({ createdAt: messages.createdAt, direction: messages.direction, channel: messages.channel })
    .from(messages)
    .where(and(gte(messages.createdAt, new Date(now.getTime() - 36 * 3_600_000)), inArray(messages.status, ["sent", "received"])))
    .all()
    .filter((m) => localDay(m.createdAt, s.operatingTimezone) === today);
  return {
    browserDms: recent.filter((m) => m.channel === "browser" && m.direction === "outbound").length,
    apiReplies: recent.filter((m) => m.channel === "api" && m.direction === "outbound").length,
    inbound: recent.filter((m) => m.direction === "inbound").length,
    cap: warmupCap(s, now),
  };
}

export function overdueFollowups(now: Date, d: Db = db()) {
  return d
    .select({ lead: leads, conv: conversations })
    .from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.channelState, "waiting_inbound_reply"), isNotNull(conversations.nextFollowupAt), lte(conversations.nextFollowupAt, now)))
    .orderBy(conversations.nextFollowupAt)
    .limit(20)
    .all();
}

export function openAlerts(d: Db = db()) {
  return d.select().from(alerts).where(isNull(alerts.resolvedAt)).orderBy(desc(alerts.createdAt)).limit(50).all();
}

export function openExceptions(d: Db = db()) {
  return d
    .select({ exception: exceptions, handle: leads.handle })
    .from(exceptions)
    .leftJoin(leads, eq(leads.id, exceptions.leadId))
    .where(eq(exceptions.status, "open"))
    .orderBy(desc(exceptions.createdAt))
    .all();
}
