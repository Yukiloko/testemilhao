import { eq, sql } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import { AFFILIATE_PIPELINE, CUSTOMER_PIPELINE, leads, type Funnel, type PipelineStatus } from "@/db/schema";
import { recordEvent } from "@/features/safety/audit";

export function pipelineFor(funnel: Funnel): readonly PipelineStatus[] {
  return funnel === "customer" ? CUSTOMER_PIPELINE : AFFILIATE_PIPELINE;
}

export class InvalidTransitionError extends Error {}

/** Forward-only: a lead may skip stages but never move back. `closed` is reachable from anywhere and final. */
export function canTransition(funnel: Funnel, from: PipelineStatus, to: PipelineStatus): boolean {
  const stages = pipelineFor(funnel);
  if (!stages.includes(to) || !stages.includes(from)) return false;
  if (from === "closed") return false;
  if (to === "closed") return true;
  return stages.indexOf(to) > stages.indexOf(from);
}

/** Atomic, audited pipeline change. Re-applying the current status is a no-op. */
export function transitionPipeline(
  leadId: number,
  to: PipelineStatus,
  input: { actor: "system" | "ai" | "operator" | "webhook" | "browser"; reason: string },
  d: Db = db(),
): boolean {
  return tx((t) => {
    const lead = t.select().from(leads).where(eq(leads.id, leadId)).get();
    if (!lead) throw new InvalidTransitionError(`Lead ${leadId} not found`);
    if (lead.pipelineStatus === to) return false;
    if (!canTransition(lead.funnel, lead.pipelineStatus, to)) {
      throw new InvalidTransitionError(`${lead.funnel}: ${lead.pipelineStatus} -> ${to} is not allowed`);
    }
    t.update(leads)
      .set({
        pipelineStatus: to,
        updatedAt: sql`(unixepoch('subsec') * 1000)`,
        ...(to === "closed" ? { closedReason: input.reason } : {}),
      })
      .where(eq(leads.id, leadId))
      .run();
    recordEvent("lead.pipeline_changed", { leadId, actor: input.actor, payload: { from: lead.pipelineStatus, to, reason: input.reason } }, t);
    return true;
  }, d);
}

/** Moves forward only if the lead is behind `to`; never throws for leads already past it. */
export function advanceAtLeast(
  leadId: number,
  to: PipelineStatus,
  input: { actor: "system" | "ai" | "operator" | "webhook" | "browser"; reason: string },
  d: Db = db(),
): boolean {
  const lead = d.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead || !canTransition(lead.funnel, lead.pipelineStatus, to)) return false;
  return transitionPipeline(leadId, to, input, d);
}
