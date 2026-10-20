import type { Lead, Message } from "@/db/schema";
import type { BusinessConfig } from "@/lib/business-config";

/** Business facts the model is allowed to use. Unverified claims are listed only as forbidden. */
export function businessBrief(c: BusinessConfig): string {
  return [
    `Empresa: ${c.companyName} (${c.companyWebsite})`,
    `Quem fala: ${c.ownerName}, ${c.ownerRole}. Instagram: ${c.instagramHandle}`,
    `Em uma frase: ${c.oneLinePitch}`,
    `Como funciona: ${c.howItWorks.map((s, i) => `${i + 1}) ${s}`).join(" ")}`,
    `Modelo de receita: ${c.revenueModel}`,
    `Jargão: ${c.marketJargon.map((j) => `${j.term} = ${j.meaning}`).join("; ")}`,
    `AFIRMAÇÕES VERIFICADAS (as únicas que você pode fazer):\n${c.verifiedClaims.map((v) => `- ${v}`).join("\n") || "- (nenhuma)"}`,
    `AFIRMAÇÕES PROIBIDAS (não comprovadas — nunca mencione, nem parafraseadas):\n${c.unverifiedClaims.map((v) => `- ${v}`).join("\n") || "- (nenhuma)"}`,
  ].join("\n");
}

export const HARD_RULES = `Regras invioláveis:
- Escreva em português do Brasil, tom pessoal e curto, como uma pessoa real escrevendo no direct. Nada de cara de campanha.
- Só afirme o que está em AFIRMAÇÕES VERIFICADAS. Nunca invente taxa, condição, prazo, garantia, número, relação societária ou superlativo.
- Nunca prometa aprovação de conta nem resultado financeiro. Cadastro segue as regras de KYC/KYB/PLD da empresa.
- Nunca finja ser cliente, nunca use informação falsa ou pressão para obter resposta.
- Se a pessoa pedir para parar, a conversa termina.
- Não inclua links além dos fornecidos explicitamente.`;

export function leadBrief(lead: Lead): string {
  return [
    `@${lead.handle} (${lead.displayName ?? "sem nome"}) — funil: ${lead.funnel === "customer" ? "cliente" : "afiliado"}, papel provável: ${lead.role}, nicho: ${lead.niche ?? "?"}`,
    `Bio: ${lead.bio ?? "-"}`,
    `Categoria: ${lead.category ?? "-"} | Local: ${lead.location ?? "-"} | Seguidores: ${lead.followers ?? "?"}`,
    `Legendas recentes: ${(lead.signals.recentCaptions ?? []).slice(0, 3).join(" || ") || "-"}`,
    `Hashtags: ${(lead.signals.hashtags ?? []).slice(0, 10).join(" ") || "-"}`,
  ].join("\n");
}

export function historyBrief(history: Message[]): string {
  if (history.length === 0) return "(sem histórico)";
  return history
    .filter((m) => m.status === "sent" || m.status === "received")
    .map((m) => `${m.direction === "inbound" ? "LEAD" : "NÓS"} [${m.channel}]: ${m.body}`)
    .join("\n");
}
