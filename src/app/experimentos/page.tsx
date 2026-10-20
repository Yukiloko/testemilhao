import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { experiments, strategyChanges } from "@/db/schema";
import { variantResults, SIGNIFICANCE } from "@/features/experiments/evaluation";
import { twoProportionPValue } from "@/features/experiments/stats";
import { formatDateTime, formatPercent } from "@/lib/format";
import { FUNNEL_LABELS, label, PIPELINE_LABELS, VARIABLE_LABELS } from "@/lib/labels";
import { revertChangeAction, toggleExperimentAction } from "../actions";
import { Badge, Empty, PageHeader, Section } from "../components/ui";
import { ExperimentForm } from "./form";

export default function ExperimentsPage() {
  const d = db();
  const list = d.select().from(experiments).orderBy(desc(experiments.createdAt)).all();
  const changes = d.select().from(strategyChanges).orderBy(desc(strategyChanges.createdAt)).limit(30).all();
  return (
    <>
      <PageHeader title="Experimentos" description={`Uma variável por vez, grupo de controle, amostra mínima e significância de ${SIGNIFICANCE * 100}% antes de qualquer vencedor. A variante campeã ganha tráfego aos poucos.`} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          {list.length === 0 && <Empty>Nenhum experimento ainda. Crie o primeiro ao lado.</Empty>}
          {list.map((exp) => {
            const results = variantResults(exp, d);
            const control = results.find((r) => r.isControl);
            const totalWeight = results.reduce((s, r) => s + r.weight, 0);
            return (
              <Section
                key={exp.id}
                title={`${exp.name} — ${label(VARIABLE_LABELS, exp.variable)} (${FUNNEL_LABELS[exp.funnel]})`}
                actions={
                  <div className="flex items-center gap-2">
                    <Badge tone={exp.status === "running" ? "ok" : exp.status === "concluded" ? "brand" : "neutral"}>{{ running: "Rodando", paused: "Pausado", concluded: "Concluído" }[exp.status]}</Badge>
                    {exp.status !== "concluded" && <form action={toggleExperimentAction}><input type="hidden" name="id" value={exp.id} /><button className="btn">{exp.status === "running" ? "Pausar" : "Retomar"}</button></form>}
                  </div>
                }
              >
                <p className="mb-2 text-xs text-zinc-500">Hipótese: {exp.hypothesis} · Métrica: {label(PIPELINE_LABELS, exp.primaryMetric)} · Amostra mínima: {exp.minSamplePerVariant}/variante · Exploração: {Math.round(exp.explorationRate * 100)}%</p>
                <table className="table">
                  <thead><tr><th>Variante</th><th>Tráfego</th><th>Expostos</th><th>Convertidos</th><th>Taxa</th><th>p-valor vs controle</th></tr></thead>
                  <tbody>
                    {results.map((r) => (
                      <tr key={r.variantId}>
                        <td>{r.key} {r.isControl && <Badge>controle</Badge>} {exp.winnerVariantId === r.variantId && <Badge tone="brand">vencedora</Badge>}</td>
                        <td>{formatPercent(r.weight, totalWeight)}</td>
                        <td className="tabular-nums">{r.exposed}</td>
                        <td className="tabular-nums">{r.converted}</td>
                        <td>{formatPercent(r.converted, r.exposed)}</td>
                        <td className="tabular-nums">{r.isControl || !control ? "—" : twoProportionPValue(r.converted, r.exposed, control.converted, control.exposed).toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            );
          })}
          <Section title="Mudanças automáticas (reversíveis)">
            {changes.length === 0 ? (
              <Empty>Nenhuma mudança aplicada ainda.</Empty>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {changes.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="text-zinc-500">{formatDateTime(c.createdAt)}</span> · {c.target} · {c.reason}
                    </span>
                    {c.status === "applied" ? (
                      <form action={revertChangeAction}><input type="hidden" name="id" value={c.id} /><button className="btn">Reverter</button></form>
                    ) : (
                      <Badge>Revertida</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <ExperimentForm />
      </div>
    </>
  );
}
