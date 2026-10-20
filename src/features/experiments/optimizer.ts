import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, tx, type Db } from "@/db/client";
import { experimentVariants, experiments, leads, strategyChanges, type Experiment, type Funnel } from "@/db/schema";
import { callStructured } from "@/integrations/openai/client";
import type { BusinessConfig } from "@/lib/business-config";
import { recordEvent } from "@/features/safety/audit";
import { getSettings, updateSettings, type RuntimeSettings } from "@/features/safety/settings";
import { businessBrief, HARD_RULES } from "@/features/conversations/prompts";
import { localHour } from "@/lib/time";

const MIN_NICHE_SAMPLE = 20;
const MIN_HOUR_SAMPLE = 15;

type NicheInsights = RuntimeSettings["nicheInsights"];

/**
 * Learns from outcomes, per funnel: niches whose contacted leads reply above average get a
 * bounded priority boost, and the local hour with the best reply rate becomes their send hour.
 */
export function computeNicheInsights(timeZone: string, d: Db = db()): NicheInsights {
  const rows = d
    .select({ niche: leads.niche, contactedAt: leads.contactedAt, repliedAt: leads.repliedAt })
    .from(leads)
    .where(and(isNotNull(leads.niche), isNotNull(leads.contactedAt)))
    .all();
  if (rows.length === 0) return {};
  const overall = rows.filter((r) => r.repliedAt).length / rows.length;
  const byNiche = new Map<string, typeof rows>();
  for (const r of rows) byNiche.set(r.niche!, [...(byNiche.get(r.niche!) ?? []), r]);

  const insights: NicheInsights = {};
  for (const [niche, list] of byNiche) {
    if (list.length < MIN_NICHE_SAMPLE) continue;
    const rate = list.filter((r) => r.repliedAt).length / list.length;
    const boost = Math.max(-15, Math.min(15, Math.round((rate - overall) * 100)));
    const byHour = new Map<number, { n: number; replied: number }>();
    for (const r of list) {
      const h = localHour(r.contactedAt!, timeZone);
      const cur = byHour.get(h) ?? { n: 0, replied: 0 };
      byHour.set(h, { n: cur.n + 1, replied: cur.replied + (r.repliedAt ? 1 : 0) });
    }
    const best = [...byHour.entries()].filter(([, v]) => v.n >= MIN_HOUR_SAMPLE).sort((a, b) => b[1].replied / b[1].n - a[1].replied / a[1].n)[0];
    insights[niche] = { boost, bestHour: best?.[0] ?? null, samples: list.length };
  }
  return insights;
}

/** Applies new insights as a logged, reversible strategy change, and re-prioritises waiting leads. */
export function applyNicheInsights(next: NicheInsights, d: Db = db()): boolean {
  const before = getSettings(d).nicheInsights;
  if (JSON.stringify(before) === JSON.stringify(next)) return false;
  tx((t) => {
    updateSettings({ nicheInsights: next }, t);
    t.insert(strategyChanges).values({ kind: "setting", target: "nicheInsights", before, after: next, reason: "reply rate by niche and send hour", actor: "ai" }).run();
    for (const [niche, insight] of Object.entries(next)) {
      const delta = insight.boost - (before[niche]?.boost ?? 0);
      t.update(leads)
        .set({ priority: sql`${leads.priority} + ${delta}`, bestSendHour: insight.bestHour })
        .where(and(eq(leads.niche, niche), eq(leads.pipelineStatus, "qualified")))
        .run();
    }
    recordEvent("strategy.niche_insights", { actor: "ai", payload: { niches: Object.keys(next).length } }, t);
  }, d);
  return true;
}

const challengerSchema = z.object({ key: z.string().regex(/^[a-z0-9_]{3,40}$/), instructions: z.string(), hypothesis: z.string() });

/**
 * After an opening experiment concludes, the winner becomes the next control and the AI
 * proposes one new challenger, so a slice of traffic always explores a fresh hypothesis.
 */
export async function startFollowUpExperiment(concluded: Experiment, config: BusinessConfig, d: Db = db()): Promise<number | null> {
  if (concluded.variable !== "opening" || !concluded.winnerVariantId) return null;
  const winner = d.select().from(experimentVariants).where(eq(experimentVariants.id, concluded.winnerVariantId)).get();
  if (!winner) return null;
  const proposal = await callStructured(
    {
      purpose: "propose_variant",
      tier: "main",
      schemaName: "challenger",
      schema: challengerSchema,
      system: `Você desenha experimentos de abordagem para primeira mensagem no Instagram. Proponha UMA nova abordagem que mude uma única variável em relação à vencedora.\n${HARD_RULES}\n\n${businessBrief(config)}`,
      user: `Vencedora atual (${winner.key}): ${winner.content.instructions ?? winner.content.template ?? "-"}\nFunil: ${concluded.funnel}`,
    },
    undefined,
    d,
  );
  return tx((t) => {
    const exp = t
      .insert(experiments)
      .values({ name: `${concluded.name} → ${proposal.key}`, funnel: concluded.funnel as Funnel, variable: "opening", hypothesis: proposal.hypothesis, primaryMetric: concluded.primaryMetric, minSamplePerVariant: concluded.minSamplePerVariant, explorationRate: concluded.explorationRate })
      .returning()
      .get();
    t.insert(experimentVariants).values({ experimentId: exp.id, key: winner.key, isControl: true, weight: 1, content: winner.content, createdBy: winner.createdBy }).run();
    const challenger = t
      .insert(experimentVariants)
      .values({ experimentId: exp.id, key: proposal.key, isControl: false, weight: 1, content: { instructions: proposal.instructions }, createdBy: "ai" })
      .returning()
      .get();
    t.insert(strategyChanges).values({ kind: "variant_added", target: `experiment:${exp.id}`, before: null, after: { variantId: challenger.id, key: proposal.key }, reason: proposal.hypothesis, actor: "ai" }).run();
    recordEvent("experiment.started", { actor: "ai", payload: { experimentId: exp.id, control: winner.key, challenger: proposal.key } }, t);
    return exp.id;
  }, d);
}
