import { and, eq, inArray, sql } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import {
  experimentAssignments,
  experimentVariants,
  experiments,
  messages,
  settings,
  strategyChanges,
  type Experiment,
  type PipelineStatus,
} from "@/db/schema";
import { pipelineFor } from "@/features/leads/pipeline";
import { recordEvent } from "@/features/safety/audit";
import { twoProportionPValue } from "./stats";

export const SIGNIFICANCE = 0.05;
const RAMP_STEP = 0.5;
const CONCLUDE_SHARE = 0.8;

export type VariantResult = { variantId: number; key: string; isControl: boolean; weight: number; exposed: number; converted: number; rate: number };

/** Stages at or beyond `metric` (excluding `closed`, which carries no progress information). */
export function stagesAtOrBeyond(experiment: Experiment): PipelineStatus[] {
  const stages: PipelineStatus[] = pipelineFor(experiment.funnel).filter((s) => s !== "closed");
  return stages.slice(stages.indexOf(experiment.primaryMetric));
}

/**
 * Exposure = the lead actually received a sent message. Conversion = the lead ever reached the
 * primary metric (read from the audit trail, so a later `closed` does not erase it).
 */
export function variantResults(experiment: Experiment, d: Db = db()): VariantResult[] {
  const reached = stagesAtOrBeyond(experiment);
  const variants = d.select().from(experimentVariants).where(eq(experimentVariants.experimentId, experiment.id)).all();
  // Drizzle renders columns unqualified in single-table selects; inside correlated subqueries
  // that would bind to the inner table, so the outer column is spelled out explicitly.
  const outerLead = sql.raw(`"experiment_assignments"."lead_id"`);
  return variants.map((v) => {
    const row = d
      .select({
        exposed: sql<number>`count(distinct ${experimentAssignments.leadId})`,
        converted: sql<number>`count(distinct case when exists (
          select 1 from events e where e.lead_id = ${outerLead}
            and e.type = 'lead.pipeline_changed'
            and json_extract(e.payload, '$.to') in (${sql.join(reached.map((r) => sql`${r}`), sql`, `)})
        ) then ${experimentAssignments.leadId} end)`,
      })
      .from(experimentAssignments)
      .where(
        and(
          eq(experimentAssignments.variantId, v.id),
          sql`exists (select 1 from ${messages} m where m.lead_id = ${outerLead} and m.direction = 'outbound' and m.status = 'sent')`,
        ),
      )
      .get();
    const exposed = row?.exposed ?? 0;
    const converted = row?.converted ?? 0;
    return { variantId: v.id, key: v.key, isControl: v.isControl, weight: v.weight, exposed, converted, rate: exposed ? converted / exposed : 0 };
  });
}

export type Evaluation =
  | { status: "insufficient_sample"; results: VariantResult[] }
  | { status: "no_significant_winner"; results: VariantResult[] }
  | { status: "ramped" | "concluded"; winner: VariantResult; pValue: number; results: VariantResult[] };

/**
 * One controlled step per evaluation: no winner before every variant hits the minimum sample,
 * then the winner's traffic share grows gradually and the change is logged as reversible.
 */
export function evaluateExperiment(experiment: Experiment, now: Date, d: Db = db()): Evaluation {
  const results = variantResults(experiment, d);
  const control = results.find((r) => r.isControl);
  if (!control || results.some((r) => r.exposed < experiment.minSamplePerVariant)) return { status: "insufficient_sample", results };

  const candidates = results
    .filter((r) => !r.isControl && r.rate > control.rate)
    .map((r) => ({ r, p: twoProportionPValue(r.converted, r.exposed, control.converted, control.exposed) }))
    .filter((c) => c.p < SIGNIFICANCE)
    .sort((a, b) => b.r.rate - a.r.rate);
  const best = candidates[0];
  if (!best) return { status: "no_significant_winner", results };

  return tx((t) => {
    const before = results.map((r) => ({ id: r.variantId, weight: r.weight }));
    const total = results.reduce((s, r) => s + r.weight, 0);
    const newWeight = best.r.weight + RAMP_STEP * total;
    t.update(experimentVariants).set({ weight: newWeight }).where(eq(experimentVariants.id, best.r.variantId)).run();
    const after = results.map((r) => ({ id: r.variantId, weight: r.variantId === best.r.variantId ? newWeight : r.weight }));
    const share = newWeight / (total - best.r.weight + newWeight);
    const reason = `${best.r.key}: ${(best.r.rate * 100).toFixed(1)}% vs controle ${(control.rate * 100).toFixed(1)}% (p=${best.p.toFixed(4)}, n=${best.r.exposed}/${control.exposed})`;
    t.insert(strategyChanges).values({ kind: "variant_weight", target: `experiment:${experiment.id}`, before, after, reason, actor: "ai" }).run();

    if (share >= CONCLUDE_SHARE) {
      t.update(experiments).set({ status: "concluded", winnerVariantId: best.r.variantId, concludedAt: now }).where(eq(experiments.id, experiment.id)).run();
      t.insert(strategyChanges).values({ kind: "experiment_concluded", target: `experiment:${experiment.id}`, before: null, after: { winner: best.r.key }, reason, actor: "ai" }).run();
      recordEvent("experiment.concluded", { actor: "ai", payload: { experimentId: experiment.id, winner: best.r.key, pValue: best.p } }, t);
      return { status: "concluded" as const, winner: best.r, pValue: best.p, results };
    }
    recordEvent("experiment.ramped", { actor: "ai", payload: { experimentId: experiment.id, winner: best.r.key, share, pValue: best.p } }, t);
    return { status: "ramped" as const, winner: best.r, pValue: best.p, results };
  }, d);
}

/** Every automated strategy change can be undone from the panel. */
export function revertStrategyChange(changeId: number, now: Date, d: Db = db()): void {
  tx((t) => {
    const change = t.select().from(strategyChanges).where(eq(strategyChanges.id, changeId)).get();
    if (!change || change.status === "reverted") return;
    if (change.kind === "variant_weight") {
      for (const v of change.before as { id: number; weight: number }[]) {
        t.update(experimentVariants).set({ weight: v.weight }).where(eq(experimentVariants.id, v.id)).run();
      }
    }
    if (change.kind === "experiment_concluded") {
      const id = Number(change.target.split(":")[1]);
      t.update(experiments).set({ status: "running", winnerVariantId: null, concludedAt: null }).where(eq(experiments.id, id)).run();
    }
    if (change.kind === "variant_added") {
      const ids = (change.after as { variantId: number } | null)?.variantId;
      if (ids) t.update(experimentVariants).set({ active: false }).where(inArray(experimentVariants.id, [ids])).run();
    }
    if (change.kind === "setting" && change.before === null) {
      t.delete(settings).where(eq(settings.key, change.target)).run();
    } else if (change.kind === "setting") {
      t.insert(settings).values({ key: change.target, value: change.before }).onConflictDoUpdate({ target: settings.key, set: { value: change.before } }).run();
    }
    t.update(strategyChanges).set({ status: "reverted", revertedAt: now }).where(eq(strategyChanges.id, changeId)).run();
    recordEvent("strategy.reverted", { actor: "operator", payload: { changeId, kind: change.kind, target: change.target } }, t);
  }, d);
}
