import { and, eq } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import {
  experimentAssignments,
  experimentVariants,
  experiments,
  type Experiment,
  type ExperimentVariable,
  type ExperimentVariant,
  type Funnel,
} from "@/db/schema";
import { hashToUnit } from "@/lib/crypto";

export function runningExperiment(funnel: Funnel, variable: ExperimentVariable, d: Db = db()): Experiment | undefined {
  return d
    .select()
    .from(experiments)
    .where(and(eq(experiments.funnel, funnel), eq(experiments.variable, variable), eq(experiments.status, "running")))
    .get();
}

/**
 * Deterministic bucketing: the same lead always lands in the same variant. A fixed exploration
 * slice ignores weights and spreads uniformly, so losing or new variants keep collecting data.
 */
export function pickVariant(leadId: number, experimentId: number, variants: ExperimentVariant[], explorationRate: number): ExperimentVariant {
  const active = variants.filter((v) => v.active).sort((a, b) => a.id - b.id);
  if (active.length === 0) throw new Error(`experiment ${experimentId} has no active variants`);
  const explore = hashToUnit(`explore:${experimentId}:${leadId}`) < explorationRate;
  const roll = hashToUnit(`assign:${experimentId}:${leadId}`);
  if (explore) return active[Math.min(active.length - 1, Math.floor(roll * active.length))]!;
  const total = active.reduce((s, v) => s + v.weight, 0);
  let acc = 0;
  for (const v of active) {
    acc += v.weight / total;
    if (roll < acc) return v;
  }
  return active[active.length - 1]!;
}

/** Returns the lead's variant, assigning it on first use. Assignment is stored, so it survives weight changes. */
export function assignVariant(
  leadId: number,
  funnel: Funnel,
  variable: ExperimentVariable,
  d: Db = db(),
): { experiment: Experiment; variant: ExperimentVariant } | null {
  const experiment = runningExperiment(funnel, variable, d);
  if (!experiment) return null;
  return tx((t) => {
    const existing = t
      .select({ variant: experimentVariants })
      .from(experimentAssignments)
      .innerJoin(experimentVariants, eq(experimentVariants.id, experimentAssignments.variantId))
      .where(and(eq(experimentAssignments.experimentId, experiment.id), eq(experimentAssignments.leadId, leadId)))
      .get();
    if (existing) return { experiment, variant: existing.variant };
    const variants = t.select().from(experimentVariants).where(eq(experimentVariants.experimentId, experiment.id)).all();
    const variant = pickVariant(leadId, experiment.id, variants, experiment.explorationRate);
    t.insert(experimentAssignments).values({ experimentId: experiment.id, variantId: variant.id, leadId }).run();
    return { experiment, variant };
  }, d);
}
