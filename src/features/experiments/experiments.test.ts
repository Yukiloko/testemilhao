import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { experimentVariants, experiments, messages, strategyChanges } from "@/db/schema";
import { advanceAtLeast } from "@/features/leads/pipeline";
import { AFTERNOON, freshDb, makeLead } from "@/test/helpers";
import { assignVariant, pickVariant } from "./assignment";
import { evaluateExperiment, revertStrategyChange, variantResults } from "./evaluation";
import { twoProportionPValue } from "./stats";

let d: Db;
beforeEach(() => {
  d = freshDb();
});

function createOpeningExperiment(minSample = 20) {
  const exp = d.insert(experiments).values({ name: "abertura", funnel: "customer", variable: "opening", hypothesis: "elogio vs pergunta", minSamplePerVariant: minSample, explorationRate: 0 }).returning().get();
  const control = d.insert(experimentVariants).values({ experimentId: exp.id, key: "compliment", isControl: true, content: { instructions: "elogie" } }).returning().get();
  const challenger = d.insert(experimentVariants).values({ experimentId: exp.id, key: "question", content: { instructions: "pergunte" } }).returning().get();
  return { exp, control, challenger };
}

describe("assignment", () => {
  it("is deterministic, stored, and roughly follows weights", () => {
    const { exp } = createOpeningExperiment();
    const lead = makeLead(d, "loja");
    const a = assignVariant(lead.id, "customer", "opening", d);
    const b = assignVariant(lead.id, "customer", "opening", d);
    expect(a?.variant.id).toBe(b?.variant.id);
    const variants = d.select().from(experimentVariants).where(eq(experimentVariants.experimentId, exp.id)).all();
    const counts = new Map<number, number>();
    for (let i = 0; i < 2000; i++) {
      const v = pickVariant(i, exp.id, variants, 0);
      counts.set(v.id, (counts.get(v.id) ?? 0) + 1);
    }
    for (const n of counts.values()) expect(n).toBeGreaterThan(850);
  });
});

describe("evaluation", () => {
  it("p-value behaves", () => {
    expect(twoProportionPValue(10, 100, 10, 100)).toBeCloseTo(1, 5);
    expect(twoProportionPValue(40, 100, 10, 100)).toBeLessThan(0.001);
  });

  function expose(variantId: number, experimentId: number, n: number, converted: number, prefix: string) {
    for (let i = 0; i < n; i++) {
      const lead = makeLead(d, `${prefix}${i}`);
      d.insert(messages).values({ leadId: lead.id, direction: "outbound", channel: "browser", kind: "opening", body: "x", status: "sent", dedupeKey: `${prefix}${i}` }).run();
      d.$client.prepare("insert into experiment_assignments (experiment_id, variant_id, lead_id) values (?, ?, ?)").run(experimentId, variantId, lead.id);
      advanceAtLeast(lead.id, "contacted", { actor: "system", reason: "t" }, d);
      if (i < converted) advanceAtLeast(lead.id, "replied", { actor: "system", reason: "t" }, d);
    }
  }

  it("does not declare a winner before the minimum sample", () => {
    const { exp, control, challenger } = createOpeningExperiment(50);
    expose(control.id, exp.id, 30, 3, "c");
    expose(challenger.id, exp.id, 30, 20, "q");
    expect(evaluateExperiment(exp, AFTERNOON, d).status).toBe("insufficient_sample");
  });

  it("ramps a significant winner gradually, logs it, and the change is reversible", () => {
    const { exp, control, challenger } = createOpeningExperiment(20);
    expose(control.id, exp.id, 40, 4, "c");
    expose(challenger.id, exp.id, 40, 20, "q");
    const results = variantResults(exp, d);
    expect(results.find((r) => r.key === "question")).toMatchObject({ exposed: 40, converted: 20 });

    const first = evaluateExperiment(exp, AFTERNOON, d);
    expect(first.status).toBe("ramped");
    expect(d.select().from(experimentVariants).where(eq(experimentVariants.id, challenger.id)).get()?.weight).toBe(2);

    const change = d.select().from(strategyChanges).get()!;
    revertStrategyChange(change.id, AFTERNOON, d);
    expect(d.select().from(experimentVariants).where(eq(experimentVariants.id, challenger.id)).get()?.weight).toBe(1);

    evaluateExperiment(exp, AFTERNOON, d);
    evaluateExperiment(exp, AFTERNOON, d);
    const last = evaluateExperiment(exp, AFTERNOON, d);
    expect(last.status).toBe("concluded");
    expect(d.select().from(experiments).where(eq(experiments.id, exp.id)).get()).toMatchObject({ status: "concluded", winnerVariantId: challenger.id });
  });
});
