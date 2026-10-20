import { eq } from "drizzle-orm";
import { experiments } from "@/db/schema";
import { backupDatabase } from "@/db/backup";
import { evaluateExperiment } from "@/features/experiments/evaluation";
import { applyNicheInsights, computeNicheInsights, startFollowUpExperiment } from "@/features/experiments/optimizer";
import { evaluateCircuitBreaker } from "@/features/safety/circuit-breaker";
import { getSettings } from "@/features/safety/settings";
import { done, type Handler } from "../context";

export const evaluateExperiments: Handler = async ({ now, d, config }) => {
  const running = d.select().from(experiments).where(eq(experiments.status, "running")).all();
  const summary: string[] = [];
  for (const exp of running) {
    const result = evaluateExperiment(exp, now, d);
    summary.push(`${exp.id}:${result.status}`);
    if (result.status === "concluded") {
      const concluded = d.select().from(experiments).where(eq(experiments.id, exp.id)).get()!;
      await startFollowUpExperiment(concluded, config, d);
    }
  }
  return done(summary.join(" ") || "no running experiments");
};

export const optimizeInsights: Handler = async ({ d }) => {
  const changed = applyNicheInsights(computeNicheInsights(getSettings(d).operatingTimezone, d), d);
  return done(changed ? "niche insights updated" : "no change");
};

export const circuitBreaker: Handler = async ({ now, d }) => {
  const tripped = evaluateCircuitBreaker(now, d);
  return done(tripped ? `tripped: ${tripped}` : "ok");
};

export const createBackup =
  (dir: string): Handler =>
  async ({ now, d }) =>
    done(await backupDatabase(d, dir, now));
