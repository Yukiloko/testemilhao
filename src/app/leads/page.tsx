import Link from "next/link";
import { and, desc, eq, like, or } from "drizzle-orm";
import { db } from "@/db/client";
import { AFFILIATE_PIPELINE, conversations, CUSTOMER_PIPELINE, leads } from "@/db/schema";
import { formatDateTime } from "@/lib/format";
import { CHANNEL_LABELS, FUNNEL_LABELS, label, PIPELINE_LABELS, ROLE_LABELS } from "@/lib/labels";
import { Badge, channelTone, PageHeader } from "../components/ui";

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ funil?: string; q?: string }> }) {
  const params = await searchParams;
  const funnel = params.funil === "affiliate" ? "affiliate" : "customer";
  const stages = funnel === "customer" ? CUSTOMER_PIPELINE : AFFILIATE_PIPELINE;
  const q = params.q?.trim().toLowerCase();
  const rows = db()
    .select({ lead: leads, conv: conversations })
    .from(leads)
    .innerJoin(conversations, eq(conversations.leadId, leads.id))
    .where(and(eq(leads.funnel, funnel), q ? or(like(leads.handle, `%${q}%`), like(leads.niche, `%${q}%`), like(leads.displayName, `%${q}%`)) : undefined))
    .orderBy(desc(leads.priority), desc(leads.updatedAt))
    .limit(1500)
    .all();

  return (
    <>
      <PageHeader
        title={`Kanban — ${FUNNEL_LABELS[funnel]}`}
        description="Leads por etapa do funil. Etapa e estado do canal são independentes."
        actions={
          <>
            <Link className={`btn ${funnel === "customer" ? "btn-primary" : ""}`} href="/leads?funil=customer">Clientes</Link>
            <Link className={`btn ${funnel === "affiliate" ? "btn-primary" : ""}`} href="/leads?funil=affiliate">Afiliados</Link>
            <form className="flex gap-2" role="search">
              <input type="hidden" name="funil" value={funnel} />
              <label className="sr-only" htmlFor="q">Buscar lead</label>
              <input id="q" name="q" defaultValue={params.q} placeholder="Buscar @, nome ou nicho" className="input w-56" />
            </form>
          </>
        }
      />
      <div className="flex gap-3 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const items = rows.filter((r) => r.lead.pipelineStatus === stage);
          return (
            <section key={stage} aria-label={PIPELINE_LABELS[stage]} className="flex w-64 shrink-0 flex-col rounded-xl bg-zinc-100 p-2 dark:bg-zinc-900/60">
              <h2 className="flex items-center justify-between px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {PIPELINE_LABELS[stage]} <span>{items.length}</span>
              </h2>
              <ul className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
                {items.slice(0, 100).map(({ lead, conv }) => (
                  <li key={lead.id}>
                    <Link href={`/leads/${lead.id}`} className="card block p-3 hover:border-brand">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">@{lead.handle}</span>
                        {lead.score !== null && <span className="text-xs tabular-nums text-zinc-500">{Math.round(lead.score)}</span>}
                      </div>
                      <div className="mt-1 truncate text-xs text-zinc-500">{lead.niche ?? "sem nicho"} · {label(ROLE_LABELS, lead.role)}</div>
                      <div className="mt-2"><Badge tone={channelTone(conv.channelState)}>{label(CHANNEL_LABELS, conv.channelState)}</Badge></div>
                      {conv.nextFollowupAt && <div className="mt-1 text-xs text-zinc-500">Follow-up: {formatDateTime(conv.nextFollowupAt)}</div>}
                    </Link>
                  </li>
                ))}
                {items.length > 100 && <li className="px-1 text-xs text-zinc-500">+{items.length - 100} — use a busca</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
