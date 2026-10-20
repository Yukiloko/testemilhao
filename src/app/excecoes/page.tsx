import Link from "next/link";
import { openExceptions } from "@/features/campaigns/metrics";
import { formatDateTime } from "@/lib/format";
import { EXCEPTION_LABELS, label } from "@/lib/labels";
import { resolveExceptionAction } from "../actions";
import { Badge, Empty, PageHeader } from "../components/ui";

export default function ExceptionsPage() {
  const rows = openExceptions();
  return (
    <>
      <PageHeader title="Fila de exceções" description="Situações que a automação não resolve sozinha: entrega incerta, janela expirada, conteúdo bloqueado, pedidos de revisão humana." />
      {rows.length === 0 ? (
        <Empty>Nenhuma exceção aberta.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Quando</th><th>Tipo</th><th>Lead</th><th>Motivo</th><th></th></tr></thead>
            <tbody>
              {rows.map(({ exception, handle }) => (
                <tr key={exception.id}>
                  <td className="whitespace-nowrap">{formatDateTime(exception.createdAt)}</td>
                  <td><Badge tone="warn">{label(EXCEPTION_LABELS, exception.kind)}</Badge></td>
                  <td>{handle ? <Link className="hover:underline" href={`/leads/${exception.leadId}`}>@{handle}</Link> : "—"}</td>
                  <td>{exception.reason}</td>
                  <td>
                    <form action={resolveExceptionAction}><input type="hidden" name="id" value={exception.id} /><button className="btn">Marcar como resolvida</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
