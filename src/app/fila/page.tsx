import { desc, inArray, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, type Job } from "@/db/schema";
import { formatDateTime } from "@/lib/format";
import { JOB_LABELS, JOB_STATUS_LABELS, label } from "@/lib/labels";
import { retryJobAction } from "../actions";
import { Badge, PageHeader, Section } from "../components/ui";

const ROUTINE = ["plan_outreach", "circuit_breaker", "schedule_followups", "expire_windows"];

const tone = (s: string) => (s === "dead" ? "bad" : s === "running" ? "brand" : s === "succeeded" ? "ok" : "neutral");
function JobTable({ rows }: { rows: Job[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>#</th><th>Job</th><th>Status</th><th>Tentativas</th><th>Executar em</th><th>Último erro / espera</th><th></th></tr></thead>
        <tbody>
          {rows.map((j) => (
            <tr key={j.id}>
              <td className="tabular-nums">{j.id}</td>
              <td>{label(JOB_LABELS, j.type)}</td>
              <td><Badge tone={tone(j.status)}>{label(JOB_STATUS_LABELS, j.status)}</Badge></td>
              <td className="tabular-nums">{j.attempts}/{j.maxAttempts}</td>
              <td className="whitespace-nowrap">{formatDateTime(j.runAt)}</td>
              <td className="max-w-md text-xs text-zinc-500">{j.lastError}</td>
              <td>{j.status === "dead" && <form action={retryJobAction}><input type="hidden" name="id" value={j.id} /><button className="btn">Reenfileirar</button></form>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function QueuePage() {
  const d = db();
  const active = d.select().from(jobs).where(inArray(jobs.status, ["queued", "running", "dead", "failed"])).orderBy(desc(jobs.updatedAt)).limit(200).all();
  const recent = d.select().from(jobs).where(notInArray(jobs.type, ROUTINE)).orderBy(desc(jobs.updatedAt)).limit(100).all();
  return (
    <>
      <PageHeader title="Fila de jobs" description="Jobs duráveis no SQLite. Sobrevivem a reinício; leases expirados voltam para a fila." />
      <div className="flex flex-col gap-4">
        <Section title="Pendentes, em execução e dead-letter"><JobTable rows={active} /></Section>
        <Section title="Atividade recente"><JobTable rows={recent} /></Section>
      </div>
    </>
  );
}
