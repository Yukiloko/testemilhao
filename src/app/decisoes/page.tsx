import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { aiDecisions, leads, strategyChanges } from "@/db/schema";
import { formatDateTime } from "@/lib/format";
import { ACTION_LABELS, INTENT_LABELS, label, OUTCOME_LABELS } from "@/lib/labels";
import { PageHeader, Section } from "../components/ui";

export default function DecisionsPage() {
  const d = db();
  const rows = d.select({ decision: aiDecisions, handle: leads.handle }).from(aiDecisions).innerJoin(leads, eq(leads.id, aiDecisions.leadId)).orderBy(desc(aiDecisions.createdAt)).limit(200).all();
  const changes = d.select().from(strategyChanges).orderBy(desc(strategyChanges.createdAt)).limit(50).all();
  return (
    <>
      <PageHeader title="Log de decisões da IA" description="O que a IA entendeu, o que decidiu e por quê." />
      <div className="flex flex-col gap-4">
        <Section title="Conversas">
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Quando</th><th>Lead</th><th>Intenção</th><th>Ação</th><th>Confiança</th><th>Resultado</th><th>Raciocínio</th><th>Resposta</th></tr></thead>
              <tbody>
                {rows.map(({ decision: x, handle }) => (
                  <tr key={x.id}>
                    <td className="whitespace-nowrap">{formatDateTime(x.createdAt)}</td>
                    <td><Link className="hover:underline" href={`/leads/${x.leadId}`}>@{handle}</Link></td>
                    <td>{label(INTENT_LABELS, x.intent)}</td>
                    <td>{label(ACTION_LABELS, x.action)}</td>
                    <td>{Math.round(x.confidence * 100)}%</td>
                    <td>{label(OUTCOME_LABELS, x.outcome)}</td>
                    <td className="text-xs">{x.reasoning}</td>
                    <td className="text-xs">{x.reply}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Mudanças de estratégia">
          <ul className="flex flex-col gap-2 text-sm">
            {changes.map((c) => (
              <li key={c.id}>
                <span className="font-medium">{formatDateTime(c.createdAt)}</span> · {c.target} · {c.reason} {c.status === "reverted" && <em className="text-zinc-500">(revertida)</em>}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}
