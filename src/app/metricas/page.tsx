import { conversionBy, costOverview, type Breakdown } from "@/features/campaigns/metrics";
import { getSettings } from "@/features/safety/settings";
import { formatNumber, formatPercent, formatUsd } from "@/lib/format";
import { FUNNEL_LABELS, label, ROLE_LABELS, SOURCE_LABELS } from "@/lib/labels";
import { Empty, PageHeader, Section } from "../components/ui";

const DIMENSIONS = [
  { key: "niche", title: "Por nicho" },
  { key: "source", title: "Por origem", labels: SOURCE_LABELS },
  { key: "role", title: "Loja vs. dono vs. decisor", labels: ROLE_LABELS },
  { key: "hour", title: "Por horário do 1º contato" },
  { key: "variant", title: "Por variante da mensagem inicial" },
] as const;

function BreakdownTable({ rows, labels }: { rows: Breakdown[]; labels?: Record<string, string> }) {
  if (rows.length === 0) return <Empty>Sem dados ainda.</Empty>;
  return (
    <table className="table">
      <thead><tr><th>Segmento</th><th>Abordados</th><th>Resposta</th><th>Interesse</th><th>Conversão</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{labels ? label(labels, r.key) : r.key}</td>
            <td className="tabular-nums">{formatNumber(r.contacted)}</td>
            <td>{formatPercent(r.replied, r.contacted)}</td>
            <td>{formatPercent(r.interested, r.contacted)}</td>
            <td>{formatPercent(r.converted, r.contacted)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function MetricsPage({ searchParams }: { searchParams: Promise<{ funil?: string }> }) {
  const funnel = (await searchParams).funil === "affiliate" ? "affiliate" : "customer";
  const tz = getSettings().operatingTimezone;
  const cost = costOverview(new Date());
  return (
    <>
      <PageHeader
        title={`Métricas — ${FUNNEL_LABELS[funnel]}`}
        description="Conversão = encaminhado ao WhatsApp (clientes) ou entrada no grupo (afiliados) ou além."
        actions={
          <>
            <a className={`btn ${funnel === "customer" ? "btn-primary" : ""}`} href="/metricas?funil=customer">Clientes</a>
            <a className={`btn ${funnel === "affiliate" ? "btn-primary" : ""}`} href="/metricas?funil=affiliate">Afiliados</a>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {DIMENSIONS.map((dim) => (
          <Section key={dim.key} title={dim.title}>
            <BreakdownTable rows={conversionBy(dim.key, funnel, tz)} labels={"labels" in dim ? dim.labels : undefined} />
          </Section>
        ))}
        <Section title="Custo de IA">
          <dl className="mb-3 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-zinc-500">Total</dt><dd>{formatUsd(cost.totalUsd)}</dd>
            <dt className="text-zinc-500">Este mês</dt><dd>{formatUsd(cost.monthUsd)}</dd>
            <dt className="text-zinc-500">Chamadas</dt><dd>{formatNumber(cost.calls)}</dd>
            <dt className="text-zinc-500">Por lead</dt><dd>{formatUsd(cost.perLeadUsd)}</dd>
            <dt className="text-zinc-500">Por cliente ativo</dt><dd>{formatUsd(cost.perActiveCustomerUsd)}</dd>
          </dl>
          <table className="table">
            <thead><tr><th>Modelo</th><th>Uso</th><th>Chamadas</th><th>Falhas</th><th>Custo</th></tr></thead>
            <tbody>
              {cost.byModel.map((m) => (
                <tr key={`${m.model}-${m.purpose}`}><td className="text-xs">{m.model}</td><td>{m.purpose}</td><td>{m.calls}</td><td>{m.failures}</td><td>{formatUsd(m.cost)}</td></tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </>
  );
}
