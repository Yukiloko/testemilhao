import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type Db } from "@/db/client";
import { messages, type Lead, type VariantContent } from "@/db/schema";
import { callStructured } from "@/integrations/openai/client";
import { handoffLink } from "@/integrations/whatsapp/links";
import type { BusinessConfig } from "@/lib/business-config";
import { fold } from "@/features/leads/text-match";
import { recordEvent } from "@/features/safety/audit";
import { checkClaims, claimReviewSchema } from "./claims-guard";
import { businessBrief, HARD_RULES, historyBrief, leadBrief } from "./prompts";

export const INTENTS = [
  "interested",
  "asked_info",
  "asked_pricing",
  "wants_whatsapp",
  "not_the_owner",
  "will_forward",
  "objection",
  "not_interested",
  "opt_out",
  "ambiguous",
  "needs_human",
] as const;
export type Intent = (typeof INTENTS)[number];

export const ACTIONS = ["reply", "ask", "present", "handle_objection", "send_whatsapp", "wait", "schedule_followup", "close", "escalate"] as const;
export type Action = (typeof ACTIONS)[number];

const classificationSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});

const decisionSchema = z.object({
  action: z.enum(ACTIONS),
  reply: z.string().nullable().describe("Message to send, or null when the action sends nothing"),
  reasoning: z.string(),
});

const draftSchema = z.object({ message: z.string(), personalHook: z.string().describe("Which real detail of the profile the message refers to") });

export class ContentBlockedError extends Error {
  constructor(readonly violations: string[]) {
    super(`content blocked: ${violations.join("; ")}`);
  }
}

const OPT_OUT = /\b(para de me|pare de me|nao quero mais|nao quero receber|nao tenho interesse|me tira da|me remove|me remova|nao me mande|nao mande mais|para de mandar|pare de mandar|stop|unsubscribe|sai fora|vou denunciar|vou bloquear)\b/;

/** Keyword safety net that runs before (and regardless of) the model. */
export function isExplicitOptOut(text: string): boolean {
  return OPT_OUT.test(fold(text));
}

function history(leadId: number, d: Db) {
  return d.select().from(messages).where(eq(messages.leadId, leadId)).orderBy(asc(messages.createdAt)).all();
}

async function reviewClaims(text: string, lead: Lead, config: BusinessConfig, d: Db): Promise<string[]> {
  const deterministic = checkClaims(text, config);
  if (!deterministic.ok) return deterministic.violations;
  const review = await callStructured(
    {
      purpose: "claim_review",
      tier: "fast",
      leadId: lead.id,
      schemaName: "claim_review",
      schema: claimReviewSchema,
      system: `Você é um revisor de conformidade. Liste toda afirmação factual sobre a empresa, oferta, taxas, condições, prazos ou resultados que NÃO esteja sustentada pelas AFIRMAÇÕES VERIFICADAS abaixo. Saudações, perguntas e menções ao perfil do lead não são afirmações.\n\n${businessBrief(config)}`,
      user: text,
    },
    undefined,
    d,
  );
  return review.unsupportedClaims;
}

/** Drafts with the model and re-drafts once with the violations as feedback before giving up. */
async function draftChecked(
  input: { purpose: string; lead: Lead; system: string; user: string },
  config: BusinessConfig,
  d: Db,
): Promise<string> {
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const draft = await callStructured(
      { purpose: input.purpose, tier: "main", leadId: input.lead.id, schemaName: "draft", schema: draftSchema, system: input.system, user: input.user + feedback },
      undefined,
      d,
    );
    const violations = await reviewClaims(draft.message, input.lead, config, d);
    if (violations.length === 0) return draft.message.trim();
    recordEvent("ai.reply_blocked", { leadId: input.lead.id, actor: "ai", payload: { purpose: input.purpose, violations, draft: draft.message } }, d);
    feedback = `\n\nSeu rascunho anterior foi bloqueado por: ${violations.join("; ")}. Reescreva sem essas afirmações.`;
  }
  throw new ContentBlockedError(["draft blocked twice by claims guard"]);
}

export async function generateOpening(lead: Lead, variant: VariantContent | null, config: BusinessConfig, d: Db = db()): Promise<string> {
  const goal =
    lead.funnel === "customer"
      ? "Abrir conversa com um possível cliente. Não venda ainda: mostre que você olhou o perfil e faça uma pergunta leve e relevante."
      : "Abrir conversa com um criador de conteúdo sobre uma possível parceria de afiliados. Não detalhe remuneração ainda.";
  return draftChecked(
    {
      purpose: "opening",
      lead,
      system: `Você escreve a PRIMEIRA mensagem de direct de ${config.ownerName} para um perfil do Instagram.\n${HARD_RULES}\n- Máximo 280 caracteres, sem emojis em excesso, sem link.\n- Cite um detalhe REAL do perfil abaixo. Se não houver detalhe suficiente, seja genérico mas honesto.\n\n${businessBrief(config)}`,
      user: `Objetivo: ${goal}\n${variant?.instructions ? `Abordagem a testar: ${variant.instructions}\n` : ""}${variant?.template ? `Estrutura de referência: ${variant.template}\n` : ""}\nPerfil:\n${leadBrief(lead)}`,
    },
    config,
    d,
  );
}

export async function generateFollowup(lead: Lead, followupNumber: number, config: BusinessConfig, d: Db = db()): Promise<string> {
  return draftChecked(
    {
      purpose: "followup",
      lead,
      system: `Você escreve um follow-up curto (máx. 200 caracteres) de ${config.ownerName} para alguém que ainda não respondeu.\n${HARD_RULES}\n- Sem cobrança, sem culpa, sem urgência falsa. Deixe claro que tudo bem não responder.\n\n${businessBrief(config)}`,
      user: `Follow-up nº ${followupNumber}.\nPerfil:\n${leadBrief(lead)}\n\nHistórico:\n${historyBrief(history(lead.id, d))}`,
    },
    config,
    d,
  );
}

export type Decision = { intent: Intent; confidence: number; action: Action; reply: string | null; reasoning: string };

/**
 * Interprets the latest inbound message (fast model) and decides the next action with a reply
 * (main model). The reply is claim-checked; links to WhatsApp/group are added deterministically.
 */
export async function decideNextStep(lead: Lead, inboundText: string, config: BusinessConfig, d: Db = db()): Promise<Decision> {
  if (isExplicitOptOut(inboundText)) {
    return { intent: "opt_out", confidence: 1, action: "close", reply: null, reasoning: "explicit opt-out keyword" };
  }
  const past = historyBrief(history(lead.id, d));
  const classification = await callStructured(
    {
      purpose: "classify_intent",
      tier: "fast",
      leadId: lead.id,
      schemaName: "intent",
      schema: classificationSchema,
      system: `Classifique a intenção da ÚLTIMA mensagem do lead numa conversa de prospecção no Instagram. Intenções: ${INTENTS.join(", ")}. Use opt_out para qualquer pedido de parar/remover. Use needs_human para reclamação, assunto jurídico, financeiro sensível ou algo fora do escopo.`,
      user: `Histórico:\n${past}\n\nÚltima mensagem do lead: ${inboundText}`,
    },
    undefined,
    d,
  );
  if (classification.intent === "opt_out") {
    return { ...classification, action: "close", reply: null, reasoning: classification.summary };
  }
  if (classification.intent === "needs_human") {
    return { ...classification, action: "escalate", reply: null, reasoning: classification.summary };
  }

  const link = handoffLink(lead.funnel, config, lead.handle);
  const destination = lead.funnel === "customer" ? `o WhatsApp comercial (${link})` : `o grupo de afiliados (${link})`;
  const decision = await callStructured(
    {
      purpose: "decide_reply",
      tier: "main",
      leadId: lead.id,
      schemaName: "decision",
      schema: decisionSchema,
      system: `Você conduz a conversa de ${config.ownerName} (${config.ownerRole} da ${config.companyName}) no direct do Instagram.\n${HARD_RULES}\n- Apresente ${config.ownerName} e a empresa no momento certo, sem despejar informação.\n- Entenda a necessidade antes de oferecer. Trate objeções com honestidade.\n- Quando houver interesse claro, use a ação send_whatsapp para encaminhar para ${destination}.\n- Ações: ${ACTIONS.join(", ")}. Use escalate se não tiver segurança.\n- Respostas com no máximo 400 caracteres.\n\n${businessBrief(config)}`,
      user: `Perfil:\n${leadBrief(lead)}\n\nHistórico:\n${past}\n\nÚltima mensagem do lead: ${inboundText}\nIntenção detectada: ${classification.intent} (confiança ${classification.confidence.toFixed(2)}) — ${classification.summary}`,
    },
    undefined,
    d,
  );

  let reply = decision.reply?.trim() || null;
  if (decision.action === "send_whatsapp" && reply && !reply.includes(link)) reply = `${reply}\n${link}`;
  if (reply) {
    const violations = await reviewClaims(reply, lead, config, d);
    if (violations.length) {
      recordEvent("ai.reply_blocked", { leadId: lead.id, actor: "ai", payload: { purpose: "reply", violations, draft: reply } }, d);
      throw new ContentBlockedError(violations);
    }
  }
  return { intent: classification.intent, confidence: classification.confidence, action: decision.action, reply, reasoning: decision.reasoning };
}
