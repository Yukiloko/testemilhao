import { openAlerts } from "@/features/campaigns/metrics";
import { formatDateTime } from "@/lib/format";
import { resolveAlertAction } from "../actions";
import { Badge, Empty, PageHeader } from "../components/ui";

export default function AlertsPage() {
  const rows = openAlerts();
  return (
    <>
      <PageHeader title="Alertas de integração" description="Chrome, Instagram, API da Meta, OpenAI e disjuntor de segurança." />
      {rows.length === 0 ? (
        <Empty>Nenhum alerta aberto.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Quando</th><th>Gravidade</th><th>Mensagem</th><th></th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</td>
                  <td><Badge tone={a.severity === "critical" ? "bad" : a.severity === "warning" ? "warn" : "neutral"}>{a.severity === "critical" ? "Crítico" : a.severity === "warning" ? "Atenção" : "Info"}</Badge></td>
                  <td>{a.message}</td>
                  <td><form action={resolveAlertAction}><input type="hidden" name="id" value={a.id} /><button className="btn">Resolver</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
