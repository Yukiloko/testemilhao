import Link from "next/link";
import { CUSTOMER_PIPELINE, AFFILIATE_PIPELINE } from "@/db/schema";
import { costOverview, openAlerts, openExceptions, overdueFollowups, pipelineCounts, reachedCounts, todayActivity } from "@/features/campaigns/metrics";
import { formatDateTime, formatNumber, formatPercent, formatUsd } from "@/lib/format";
import { EXCEPTION_LABELS, label, PIPELINE_LABELS } from "@/lib/labels";
import { queueStats } from "@/worker/queue";
import { Badge, Empty, PageHeader, Section, Stat } from "./components/ui";

function Funnel({ title, stages, counts, reached }: { title: string; stages: readonly string[]; counts: Record<string, number>; reached: Record<string, number> }) {
  const contacted = reached.contacted ?? 0;
  return (
    <Section title={title}>
      <ol className="flex flex-col gap-1.5">
        {stages.map((s) => (
          <li key={s} className="flex items-center justify-between text-sm">
            <span>{PIPELINE_LABELS[s]}</span>
            <span className="tabular-nums text-zinc-500">
              <strong className="text-zinc-900 dark:text-zinc-100">{formatNumber(counts[s] ?? 0)}</strong> agora
              {s !== "discovered" && s !== "qualified" && s !== "closed" && s !== "contacted" && contacted > 0 && <> · {formatPercent(reached[s] ?? 0, contacted)} dos abordados</>}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export default function DashboardPage() {
  const now = new Date();
  const today = todayActivity(now);
  const cost = costOverview(now);
  const followups = overdueFollowups(now);
  const alertList = openAlerts().slice(0, 5);
  const exceptionList = openExceptions().slice(0, 5);
  const queue = queueStats();
  const budget = Number(process.env.OPENAI_MONTHLY_BUDGET_USD ?? 0);

  return (
    <>
      <PageHeader title="Painel geral" description="Visão do ciclo Observar → Decidir → Agir → Medir → Aprender → Adaptar." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="DMs hoje" value={`${today.browserDms} / ${today.cap}`} hint="Limite do dia com aquecimento" />
        <Stat label="Respostas hoje" value={formatNumber(today.inbound)} />
        <Stat label="Respostas pela API" value={formatNumber(today.apiReplies)} hint="Hoje" />
        <Stat label="Custo de IA no mês" value={formatUsd(cost.monthUsd)} hint={budget ? `Teto ${formatUsd(budget)}` : undefined} />
        <Stat label="Custo por lead" value={formatUsd(cost.perLeadUsd)} />
        <Stat label="Custo por cliente ativo" value={formatUsd(cost.perActiveCustomerUsd)} hint={`${cost.activeCustomers} clientes ativos`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Funnel title="Funil de clientes" stages={CUSTOMER_PIPELINE} counts={pipelineCounts("customer")} reached={reachedCounts("customer")} />
        <Funnel title="Funil de afiliados" stages={AFFILIATE_PIPELINE} counts={pipelineCounts("affiliate")} reached={reachedCounts("affiliate")} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Section title="Follow-ups vencidos">
          {followups.length === 0 ? (
            <Empty>Nenhum follow-up vencido.</Empty>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {followups.map(({ lead, conv }) => (
                <li key={lead.id} className="flex justify-between">
                  <Link className="hover:underline" href={`/leads/${lead.id}`}>@{lead.handle}</Link>
                  <span className="text-zinc-500">{formatDateTime(conv.nextFollowupAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Exceções abertas" actions={<Link className="text-xs hover:underline" href="/excecoes">Ver todas</Link>}>
          {exceptionList.length === 0 ? (
            <Empty>Nada aguardando o operador.</Empty>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {exceptionList.map(({ exception, handle }) => (
                <li key={exception.id}>
                  <Badge tone="warn">{label(EXCEPTION_LABELS, exception.kind)}</Badge> {handle && <Link className="hover:underline" href={`/leads/${exception.leadId}`}>@{handle}</Link>}
                  <div className="text-xs text-zinc-500">{exception.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Alertas de integração" actions={<Link className="text-xs hover:underline" href="/alertas">Ver todos</Link>}>
          {alertList.length === 0 ? (
            <Empty>Nenhum alerta aberto.</Empty>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {alertList.map((a) => (
                <li key={a.id}>
                  <Badge tone={a.severity === "critical" ? "bad" : "warn"}>{a.severity === "critical" ? "Crítico" : a.severity === "warning" ? "Atenção" : "Info"}</Badge> {a.message}
                  <div className="text-xs text-zinc-500">{formatDateTime(a.createdAt)}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="mt-4">
        <Section title="Fila de jobs" actions={<Link className="text-xs hover:underline" href="/fila">Abrir fila</Link>}>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>Na fila: <strong>{queue.queued ?? 0}</strong></span>
            <span>Executando: <strong>{queue.running ?? 0}</strong></span>
            <span>Dead-letter: <strong className={queue.dead ? "text-bad" : ""}>{queue.dead ?? 0}</strong></span>
            <span>Concluídos: <strong>{queue.succeeded ?? 0}</strong></span>
          </div>
        </Section>
      </div>
    </>
  );
}
