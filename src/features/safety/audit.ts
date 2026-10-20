import { alerts, events, exceptions } from "@/db/schema";
import { db, type Db } from "@/db/client";
import { log } from "@/lib/logger";

type Actor = (typeof events.$inferInsert)["actor"];

/** Every meaningful action becomes a structured, queryable event. This is the audit trail. */
export function recordEvent(
  type: string,
  input: { leadId?: number | null; jobId?: number | null; actor: Actor; payload?: Record<string, unknown> },
  d: Db = db(),
): void {
  d.insert(events)
    .values({ type, leadId: input.leadId ?? null, jobId: input.jobId ?? null, actor: input.actor, payload: input.payload ?? {} })
    .run();
}

export function raiseAlert(
  severity: "info" | "warning" | "critical",
  kind: string,
  message: string,
  payload: Record<string, unknown> = {},
  d: Db = db(),
): void {
  log[severity === "critical" ? "error" : "warn"]("alert", { kind, message, ...payload });
  d.insert(alerts).values({ severity, kind, message, payload }).run();
}

/** Work the system must not resolve on its own goes to the exception queue for the operator. */
export function openException(
  kind: string,
  reason: string,
  input: { leadId?: number | null; payload?: Record<string, unknown> } = {},
  d: Db = db(),
): void {
  d.insert(exceptions).values({ kind, reason, leadId: input.leadId ?? null, payload: input.payload ?? {} }).run();
  recordEvent("exception.opened", { leadId: input.leadId, actor: "system", payload: { kind, reason } }, d);
}
