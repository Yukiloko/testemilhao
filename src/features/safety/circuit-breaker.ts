import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, type Db } from "@/db/client";
import { events, jobs } from "@/db/schema";
import { HOUR } from "@/lib/time";
import { pauseSystem } from "./pause";

export const BROWSER_JOB_TYPES = ["send_first_dm", "send_followup", "discover_hashtag", "enrich_profile"] as const;

export const TRIP_REASONS = {
  instagramRestriction: "Instagram exibiu alerta ou restrição na conta",
  sessionLost: "Sessão do Instagram no Chrome foi perdida",
  browserErrors: "Taxa anormal de erros no navegador",
  duplicateSend: "Tentativa de mensagem duplicada detectada",
  optOutSpike: "Aumento anormal de pedidos de remoção ou bloqueios",
  channelDivergence: "Divergência entre navegador, API e CRM",
  aiMisbehaviour: "Comportamento inesperado da IA",
  budget: "Orçamento mensal da OpenAI atingido",
} as const;

export type TripReason = keyof typeof TRIP_REASONS;

/** Immediate trip for conditions that are dangerous on first occurrence. */
export function trip(reason: TripReason, d: Db = db()): void {
  pauseSystem(TRIP_REASONS[reason], "system", d);
}

const WINDOW = 6 * HOUR;

/** Periodic check for conditions that are only dangerous as a trend. Returns the reason if it tripped. */
export function evaluateCircuitBreaker(now: Date, d: Db = db()): TripReason | null {
  const since = new Date(now.getTime() - WINDOW);

  const browserJobs = d
    .select({ status: jobs.status, n: sql<number>`count(*)` })
    .from(jobs)
    .where(and(inArray(jobs.type, [...BROWSER_JOB_TYPES]), gte(jobs.updatedAt, since), inArray(jobs.status, ["succeeded", "failed", "dead"])))
    .groupBy(jobs.status)
    .all();
  const total = browserJobs.reduce((s, r) => s + r.n, 0);
  const failed = browserJobs.filter((r) => r.status !== "succeeded").reduce((s, r) => s + r.n, 0);
  if (total >= 4 && failed / total > 0.5) {
    trip("browserErrors", d);
    return "browserErrors";
  }

  const counts = d
    .select({ type: events.type, n: sql<number>`count(*)` })
    .from(events)
    .where(and(gte(events.createdAt, new Date(now.getTime() - 24 * HOUR)), inArray(events.type, ["message.inbound", "lead.opted_out", "lead.blocked_us"])))
    .groupBy(events.type)
    .all();
  const get = (t: string) => counts.find((c) => c.type === t)?.n ?? 0;
  const replies = get("message.inbound");
  const negatives = get("lead.opted_out") + get("lead.blocked_us");
  if (replies >= 5 && negatives / replies > 0.3) {
    trip("optOutSpike", d);
    return "optOutSpike";
  }

  const claimBlocks = d
    .select({ n: sql<number>`count(*)` })
    .from(events)
    .where(and(eq(events.type, "ai.reply_blocked"), gte(events.createdAt, since)))
    .get();
  if ((claimBlocks?.n ?? 0) >= 5) {
    trip("aiMisbehaviour", d);
    return "aiMisbehaviour";
  }
  return null;
}
