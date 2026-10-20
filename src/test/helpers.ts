import { eq } from "drizzle-orm";
import { openDatabase, setDb, type Db } from "@/db/client";
import { conversations, leads, type Funnel, type Lead } from "@/db/schema";
import { registerDiscoveredProfile } from "@/features/leads/discovery";
import { transitionPipeline } from "@/features/leads/pipeline";
import { setBusinessConfigForTests, type BusinessConfig } from "@/lib/business-config";
import { setCompleter, type CompletionRequest } from "@/integrations/openai/client";

export const testConfig: BusinessConfig = {
  ownerName: "Ana Teste",
  ownerRole: "Fundadora",
  companyName: "PagaFácil",
  companyWebsite: "https://pagafacil.example",
  instagramHandle: "@pagafacil",
  whatsappLink: "https://wa.me/5511999999999",
  affiliateGroupLink: "https://chat.whatsapp.com/AFILIADOSTESTE",
  oneLinePitch: "Maquininha e link de pagamento para lojas pequenas",
  howItWorks: ["Cadastro online", "Análise da conta", "Começa a vender"],
  revenueModel: "Taxa por transação",
  marketJargon: [{ term: "MDR", meaning: "taxa cobrada por transação" }],
  verifiedClaims: ["Recebimento em 1 dia útil no plano D+1", "Sem mensalidade"],
  unverifiedClaims: ["Menor taxa do mercado para lojistas"],
  icpSegments: ["moda feminina", "cafeteria", "pet shop"],
  icpKeywords: ["loja", "moda", "boutique"],
  affiliateTopics: ["empreendedorismo", "finanças"],
  geography: "São Paulo",
};

/** Fresh in-memory database with migrations applied, installed as the process-wide connection. */
export function freshDb(): Db {
  const d = openDatabase(":memory:");
  setDb(d);
  setBusinessConfigForTests(testConfig);
  return d;
}

export type ScriptedReply = (req: CompletionRequest) => unknown;

/** Scripted model: answers by schema name; records every request for assertions. */
export function scriptModel(replies: Partial<Record<string, ScriptedReply>>) {
  const calls: CompletionRequest[] = [];
  setCompleter(async (req) => {
    calls.push(req);
    const reply = replies[req.schemaName];
    if (!reply) throw new Error(`no scripted reply for ${req.schemaName}`);
    return { text: JSON.stringify(reply(req)), inputTokens: 1_000, outputTokens: 200 };
  });
  return calls;
}

export const defaultModel = {
  draft: () => ({ message: "Oi! Vi as peças novas da vitrine de vocês, ficaram lindas. Vocês vendem mais pelo direct ou na loja física?", personalHook: "vitrine" }),
  claim_review: () => ({ unsupportedClaims: [] }),
  intent: () => ({ intent: "interested", confidence: 0.9, summary: "quer saber mais" }),
  decision: () => ({ action: "send_whatsapp", reply: "Que bom! A Ana pode te explicar tudo por lá:", reasoning: "interesse claro" }),
  challenger: () => ({ key: "question_first", instructions: "Comece com uma pergunta", hypothesis: "Perguntas geram mais respostas" }),
};

export function makeLead(d: Db, handle: string, funnel: Funnel = "customer", status: "discovered" | "qualified" | "contacted" = "qualified"): Lead {
  const result = registerDiscoveredProfile(
    { handle, funnel, source: "import", bio: "Loja de moda feminina em São Paulo", followers: 2_000, signals: { isBusiness: true } },
    testConfig.instagramHandle,
    d,
  );
  if (result.outcome !== "created") throw new Error(`could not create ${handle}`);
  if (status !== "discovered") transitionPipeline(result.lead.id, "qualified", { actor: "system", reason: "test" }, d);
  if (status === "contacted") transitionPipeline(result.lead.id, "contacted", { actor: "system", reason: "test" }, d);
  return d.select().from(leads).where(eq(leads.id, result.lead.id)).get()!;
}

export function conversationOf(d: Db, leadId: number) {
  return d.select().from(conversations).where(eq(conversations.leadId, leadId)).get()!;
}

/** 14:00 in São Paulo on a weekday, after real "now" so jobs enqueued with the system clock are due — inside the default operating window. */
export const AFTERNOON = new Date("2027-03-10T17:00:00Z");
