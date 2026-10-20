import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { aiDecisions, browserArtifacts, conversations, events, leads, messages } from "@/db/schema";
import { pipelineFor } from "@/features/leads/pipeline";
import { formatBrl, formatDateTime, formatNumber } from "@/lib/format";
import { ACTION_LABELS, ACTOR_LABELS, scoreReasonLabel, CHANNEL_LABELS, EVENT_LABELS, FUNNEL_LABELS, INTENT_LABELS, label, OUTCOME_LABELS, PIPELINE_LABELS, ROLE_LABELS, SOURCE_LABELS } from "@/lib/labels";
import { businessConfig } from "@/lib/business-config";
import { handoffLink } from "@/integrations/whatsapp/links";
import { advanceLeadAction, markDoNotContactAction, reconcileDeliveryAction, returnToAutomationAction, updateLeadCommercialAction } from "../../actions";
import { Badge, channelTone, PageHeader, Section } from "../../components/ui";

const OPERATOR_STAGES = { customer: ["registered", "active_customer", "closed"], affiliate: ["joined_affiliate_group", "active_affiliate", "generated_customer", "closed"] } as const;

function describeEvent(type: string, payload: Record<string, unknown>): string {
  if (type === "lead.pipeline_changed") return `${label(PIPELINE_LABELS, String(payload.from))} → ${label(PIPELINE_LABELS, String(payload.to))}`;
  if (type === "channel.changed") return `${label(CHANNEL_LABELS, String(payload.from))} → ${label(CHANNEL_LABELS, String(payload.to))}`;
  if (type === "ai.decision") return `${label(INTENT_LABELS, String(payload.intent))} → ${label(ACTION_LABELS, String(payload.action))}`;
  if (type === "lead.scored") return `Pontuação ${String(payload.score)} · prioridade ${String(payload.priority)}`;
  if (type === "ai.reply_blocked") return `${(payload.violations as string[] | undefined)?.length ?? 0} problema(s) de conformidade no rascunho`;
  return "";
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const leadId = Number(id);
  const d = db();
  const lead = Number.isInteger(leadId) ? d.select().from(leads).where(eq(leads.id, leadId)).get() : undefined;
  if (!lead) notFound();
  const conv = d.select().from(conversations).where(eq(conversations.leadId, leadId)).get()!;
  const msgs = d.select().from(messages).where(eq(messages.leadId, leadId)).orderBy(asc(messages.createdAt)).all();
  const timeline = d.select().from(events).where(eq(events.leadId, leadId)).orderBy(desc(events.createdAt)).limit(200).all();
  const decisions = d.select().from(aiDecisions).where(eq(aiDecisions.leadId, leadId)).orderBy(desc(aiDecisions.createdAt)).all();
  const artifacts = d.select().from(browserArtifacts).where(eq(browserArtifacts.leadId, leadId)).orderBy(desc(browserArtifacts.createdAt)).limit(10).all();
  const referrer = lead.referredByLeadId ? d.select().from(leads).where(eq(leads.id, lead.referredByLeadId)).get() : undefined;
  const config = businessConfig();
  const allowed = pipelineFor(lead.funnel);
  const pending = msgs.filter((m) => m.status === "pending");

  return (
    <>
      <PageHeader
        title={`@${lead.handle}`}
        description={`${lead.displayName ?? "Sem nome"} · ${FUNNEL_LABELS[lead.funnel]} · ${label(SOURCE_LABELS, lead.source)}${lead.sourceDetail ? ` (${lead.sourceDetail})` : ""}`}
        actions={
          <>
            <a className="btn" href={`https://www.instagram.com/${lead.handle}/`} target="_blank" rel="noreferrer">Abrir no Instagram ↗</a>
            <a className="btn" href={handoffLink(lead.funnel, config, lead.handle)} target="_blank" rel="noreferrer">{lead.funnel === "customer" ? "WhatsApp ↗" : "Grupo ↗"}</a>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Section title="Conversa">
            {msgs.length === 0 ? (
              <p className="text-sm text-zinc-500">Nenhuma mensagem ainda.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {msgs.map((m) => (
                  <li key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${m.direction === "inbound" ? "self-start bg-zinc-100 dark:bg-zinc-800" : "self-end bg-pink-50 dark:bg-pink-950/40"}`}>
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>
                    <div className="mt-1 text-xs text-zinc-500">
                      {m.direction === "inbound" ? "Lead" : m.channel === "browser" ? "Navegador" : "API oficial"} · {formatDateTime(m.sentAt ?? m.createdAt)} ·{" "}
                      {m.status === "sent" ? "enviada" : m.status === "received" ? "recebida" : m.status === "pending" ? "entrega incerta" : m.status === "blocked" ? "bloqueada" : "falhou"}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
          {pending.length > 0 && (
            <Section title="Reconciliar entrega incerta">
              {pending.map((m) => (
                <form key={m.id} action={reconcileDeliveryAction} className="flex flex-wrap items-center gap-2 text-sm">
                  <input type="hidden" name="messageId" value={m.id} />
                  <span className="flex-1">Confira no direct se esta mensagem saiu: “{m.body.slice(0, 80)}…”</span>
                  <button className="btn btn-primary" name="delivered" value="yes">Foi entregue</button>
                  <button className="btn" name="delivered" value="no">Não foi entregue</button>
                </form>
              ))}
            </Section>
          )}
          <Section title="Decisões da IA">
            {decisions.length === 0 ? (
              <p className="text-sm text-zinc-500">Nenhuma decisão registrada.</p>
            ) : (
              <table className="table">
                <thead><tr><th>Quando</th><th>Intenção</th><th>Ação</th><th>Confiança</th><th>Resultado</th><th>Raciocínio</th></tr></thead>
                <tbody>
                  {decisions.map((x) => (
                    <tr key={x.id}>
                      <td>{formatDateTime(x.createdAt)}</td>
                      <td>{label(INTENT_LABELS, x.intent)}</td>
                      <td>{label(ACTION_LABELS, x.action)}</td>
                      <td>{Math.round(x.confidence * 100)}%</td>
                      <td>{label(OUTCOME_LABELS, x.outcome)}</td>
                      <td className="text-xs">{x.reasoning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section title="Timeline (auditoria)">
            <ol className="flex flex-col gap-2 text-sm">
              {timeline.map((e) => (
                <li key={e.id} className="border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
                  <div className="font-medium">{label(EVENT_LABELS, e.type)} <span className="text-xs font-normal text-zinc-500">· {formatDateTime(e.createdAt)} · {label(ACTOR_LABELS, e.actor)}</span></div>
                  <div className="text-xs text-zinc-500">{describeEvent(e.type, e.payload)}</div>
                </li>
              ))}
            </ol>
          </Section>
        </div>
        <div className="flex flex-col gap-4">
          <Section title="Estado">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-zinc-500">Etapa</dt><dd><Badge tone="brand">{label(PIPELINE_LABELS, lead.pipelineStatus)}</Badge></dd>
              <dt className="text-zinc-500">Canal</dt><dd><Badge tone={channelTone(conv.channelState)}>{label(CHANNEL_LABELS, conv.channelState)}</Badge></dd>
              <dt className="text-zinc-500">Dono do canal</dt><dd>{{ none: "Ninguém", browser: "Navegador", api: "API oficial", human: "Humano" }[conv.channelOwner]}</dd>
              <dt className="text-zinc-500">Janela da API</dt><dd>{formatDateTime(conv.windowExpiresAt)}</dd>
              <dt className="text-zinc-500">Próximo follow-up</dt><dd>{formatDateTime(conv.nextFollowupAt)}</dd>
              <dt className="text-zinc-500">Follow-ups enviados</dt><dd>{conv.followupsSent}</dd>
              <dt className="text-zinc-500">Próxima ação</dt><dd>{lead.nextAction ?? "—"}</dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              {conv.channelState === "human_review_required" && (
                <form action={returnToAutomationAction}><input type="hidden" name="leadId" value={lead.id} /><button className="btn btn-primary">Devolver para a automação</button></form>
              )}
              {conv.channelState !== "do_not_contact" && (
                <form action={markDoNotContactAction}><input type="hidden" name="leadId" value={lead.id} /><button className="btn btn-danger">Não contatar</button></form>
              )}
            </div>
          </Section>
          <Section title="Perfil e pontuação">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-zinc-500">Pontuação</dt><dd>{lead.score === null ? "—" : Math.round(lead.score)}</dd>
              <dt className="text-zinc-500">Prioridade</dt><dd>{lead.priority}</dd>
              <dt className="text-zinc-500">Papel</dt><dd>{label(ROLE_LABELS, lead.role)}</dd>
              <dt className="text-zinc-500">Nicho</dt><dd>{lead.niche ?? "—"}</dd>
              <dt className="text-zinc-500">Seguidores</dt><dd>{formatNumber(lead.followers)}</dd>
              <dt className="text-zinc-500">Categoria</dt><dd>{lead.category ?? "—"}</dd>
            </dl>
            {lead.bio && <p className="mt-3 whitespace-pre-wrap text-sm">{lead.bio}</p>}
            {lead.scoreReasons.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-zinc-500">{lead.scoreReasons.map((r) => <li key={r}>{scoreReasonLabel(r)}</li>)}</ul>}
          </Section>
          <Section title="Comercial">
            <form action={updateLeadCommercialAction} className="flex flex-col gap-2 text-sm">
              <input type="hidden" name="leadId" value={lead.id} />
              <label>Volume transacionado (R$)<input className="input mt-1" name="transactedVolume" type="number" min="0" step="0.01" defaultValue={lead.transactedVolume} /></label>
              {lead.funnel === "customer" && <label>Indicado por (@ do afiliado)<input className="input mt-1" name="referrer" defaultValue={referrer?.handle ?? ""} /></label>}
              <label>Tags (separadas por vírgula)<input className="input mt-1" name="tags" defaultValue={lead.tags.join(", ")} /></label>
              <button className="btn self-start">Salvar</button>
              <p className="text-xs text-zinc-500">Volume atual: {formatBrl(lead.transactedVolume)}</p>
            </form>
            <div className="mt-3 flex flex-wrap gap-2">
              {OPERATOR_STAGES[lead.funnel].filter((s) => allowed.indexOf(s) > allowed.indexOf(lead.pipelineStatus) || (s === "closed" && lead.pipelineStatus !== "closed")).map((s) => (
                <form key={s} action={advanceLeadAction}>
                  <input type="hidden" name="leadId" value={lead.id} />
                  <input type="hidden" name="to" value={s} />
                  <button className="btn">Marcar: {PIPELINE_LABELS[s]}</button>
                </form>
              ))}
            </div>
          </Section>
          {artifacts.length > 0 && (
            <Section title="Falhas do navegador">
              <ul className="flex flex-col gap-2 text-xs">
                {artifacts.map((a) => (
                  <li key={a.id}>
                    <div className="font-medium">{formatDateTime(a.createdAt)} — {a.error}</div>
                    <div className="text-zinc-500">{a.url}</div>
                    {a.screenshotPath && <Link className="underline" href={`/api/artefatos/${a.id}?tipo=screenshot`} target="_blank">Ver screenshot</Link>}{" "}
                    {a.snapshotPath && <Link className="underline" href={`/api/artefatos/${a.id}?tipo=snapshot`} target="_blank">Ver snapshot de acessibilidade</Link>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
