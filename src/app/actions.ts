"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, tx } from "@/db/client";
import { alerts, conversations, exceptions, experimentVariants, experiments, jobs, leads, messages, EXPERIMENT_VARIABLES, type PipelineStatus } from "@/db/schema";
import { getConversation, isWindowOpen, transitionChannel } from "@/features/conversations/channel";
import { markFailed, markSent } from "@/features/conversations/outbound";
import { revertStrategyChange } from "@/features/experiments/evaluation";
import { registerDiscoveredProfile } from "@/features/leads/discovery";
import { markDoNotContact } from "@/features/leads/do-not-contact";
import { normalizeHandle } from "@/features/leads/handle";
import { advanceAtLeast, transitionPipeline } from "@/features/leads/pipeline";
import { recordEvent } from "@/features/safety/audit";
import { pauseSystem, resumeSystem } from "@/features/safety/pause";
import { HARD_LIMITS, updateSettings } from "@/features/safety/settings";
import { businessConfig } from "@/lib/business-config";
import { DAY } from "@/lib/time";
import { enqueue } from "@/worker/queue";

const id = z.coerce.number().int().positive();

export type FormState = { error?: string; ok?: boolean; message?: string };

export async function pauseAction(formData: FormData) {
  pauseSystem(String(formData.get("reason") || "Pausa manual pelo operador"), "operator");
  revalidatePath("/", "layout");
}

export async function resumeAction() {
  resumeSystem();
  revalidatePath("/", "layout");
}

const limitsSchema = z.object({
  maxDmsPerDay: z.coerce.number().int().min(0).max(HARD_LIMITS.maxDmsPerDay),
  minSecondsBetweenDms: z.coerce.number().int().min(HARD_LIMITS.minSecondsBetweenDms),
  maxSecondsBetweenDms: z.coerce.number().int().min(HARD_LIMITS.minSecondsBetweenDms),
  operatingHours: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/),
  followupDays: z.string().transform((v) => v.split(",").map((x) => Number(x.trim())).filter((x) => x > 0)),
  minQualifyScore: z.coerce.number().min(0).max(100),
  minConfidenceToAutoReply: z.coerce.number().min(0).max(1),
  discoveryEnabled: z.literal("on").optional().transform((v) => v === "on"),
  autoReplyEnabled: z.literal("on").optional().transform((v) => v === "on"),
});

export async function updateLimitsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = limitsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Valores inválidos: " + parsed.error.issues.map((i) => i.path.join(".")).join(", ") };
  if (parsed.data.minSecondsBetweenDms > parsed.data.maxSecondsBetweenDms) return { error: "O intervalo mínimo deve ser menor ou igual ao máximo." };
  updateSettings(parsed.data);
  recordEvent("settings.updated", { actor: "operator", payload: parsed.data });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function importLeadsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const funnel = formData.get("funnel") === "affiliate" ? "affiliate" : "customer";
  const handles = String(formData.get("handles") ?? "")
    .split(/[\s,;]+/)
    .map((h) => h.trim())
    .filter(Boolean);
  if (handles.length === 0) return { error: "Informe ao menos um @ ou link de perfil." };
  const own = businessConfig().instagramHandle;
  const counts = { created: 0, updated: 0, skipped: 0 };
  for (const handle of handles.slice(0, 500)) {
    const r = registerDiscoveredProfile({ handle, funnel, source: "import" }, own);
    counts[r.outcome]++;
    if (r.outcome === "created") enqueue("enrich_profile", { leadId: r.lead.id }, { idempotencyKey: `enrich:${r.lead.id}` });
  }
  revalidatePath("/leads");
  return { message: `${counts.created} novos, ${counts.updated} já existiam, ${counts.skipped} ignorados (inválidos ou na lista de não contato).` };
}

export async function markDoNotContactAction(formData: FormData) {
  const leadId = id.parse(formData.get("leadId"));
  markDoNotContact(leadId, String(formData.get("reason") || "Marcado pelo operador"), "operator");
  revalidatePath(`/leads/${leadId}`);
}

const OPERATOR_STAGES = ["registered", "active_customer", "joined_affiliate_group", "active_affiliate", "generated_customer", "closed"] as const;

export async function advanceLeadAction(formData: FormData) {
  const leadId = id.parse(formData.get("leadId"));
  const to = z.enum(OPERATOR_STAGES).parse(formData.get("to")) as PipelineStatus;
  transitionPipeline(leadId, to, { actor: "operator", reason: "atualizado no painel" });
  const lead = db().select().from(leads).where(eq(leads.id, leadId)).get();
  // A referred customer becoming active credits the affiliate that brought them.
  if (to === "active_customer" && lead?.referredByLeadId) {
    advanceAtLeast(lead.referredByLeadId, "generated_customer", { actor: "operator", reason: `indicou @${lead.handle}` });
  }
  revalidatePath(`/leads/${leadId}`);
}

export async function updateLeadCommercialAction(formData: FormData) {
  const leadId = id.parse(formData.get("leadId"));
  const volume = z.coerce.number().min(0).parse(formData.get("transactedVolume") || 0);
  const referrer = String(formData.get("referrer") ?? "").trim();
  const tags = String(formData.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  let referredByLeadId: number | null = null;
  if (referrer) {
    const aff = db().select().from(leads).where(and(eq(leads.handle, normalizeHandle(referrer)), eq(leads.funnel, "affiliate"))).get();
    referredByLeadId = aff?.id ?? null;
  }
  db().update(leads).set({ transactedVolume: volume, referredByLeadId, tags }).where(eq(leads.id, leadId)).run();
  recordEvent("lead.commercial_updated", { leadId, actor: "operator", payload: { volume, referrer, tags } });
  revalidatePath(`/leads/${leadId}`);
}

/** Gives a thread back to automation after human review, to whichever channel is legitimate now. */
export async function returnToAutomationAction(formData: FormData) {
  const leadId = id.parse(formData.get("leadId"));
  const conv = getConversation(leadId);
  if (conv.channelState !== "human_review_required") return;
  const now = new Date();
  const hasInbound = db().select({ id: messages.id }).from(messages).where(and(eq(messages.leadId, leadId), eq(messages.direction, "inbound"))).get();
  const to = hasInbound ? (isWindowOpen(conv, now) ? "api_eligible" : "api_window_closed") : conv.lastOutboundAt ? "waiting_inbound_reply" : "browser_contact_pending";
  const owner = to === "browser_contact_pending" ? "none" : to === "waiting_inbound_reply" ? "browser" : "api";
  transitionChannel(leadId, { from: ["human_review_required"], to, owner, actor: "operator", reason: "devolvido à automação" });
  revalidatePath(`/leads/${leadId}`);
}

/** Operator reconciliation for "delivery unknown": they checked the DM thread by hand. */
export async function reconcileDeliveryAction(formData: FormData) {
  const messageId = id.parse(formData.get("messageId"));
  const delivered = formData.get("delivered") === "yes";
  const msg = db().select().from(messages).where(eq(messages.id, messageId)).get();
  if (!msg || msg.status !== "pending") return;
  const now = new Date();
  tx((t) => {
    if (delivered) {
      markSent(msg.id, null, now, t);
      if (msg.kind === "opening") {
        t.update(conversations)
          .set({ channelState: "waiting_inbound_reply", channelOwner: "browser", lastOutboundAt: now, nextFollowupAt: new Date(now.getTime() + 3 * DAY), version: sql`${conversations.version} + 1` })
          .where(and(eq(conversations.leadId, msg.leadId), eq(conversations.channelState, "human_review_required")))
          .run();
        t.update(leads).set({ contactedAt: msg.createdAt }).where(eq(leads.id, msg.leadId)).run();
        advanceAtLeast(msg.leadId, "contacted", { actor: "operator", reason: "entrega confirmada" }, t);
      }
    } else {
      markFailed(msg.id, "operador confirmou que não foi entregue", t);
    }
    recordEvent("message.reconciled", { leadId: msg.leadId, actor: "operator", payload: { messageId, delivered } }, t);
  });
  revalidatePath(`/leads/${msg.leadId}`);
}

export async function resolveExceptionAction(formData: FormData) {
  db().update(exceptions).set({ status: "resolved", resolvedAt: new Date() }).where(eq(exceptions.id, id.parse(formData.get("id")))).run();
  revalidatePath("/excecoes");
}

export async function resolveAlertAction(formData: FormData) {
  db().update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.id, id.parse(formData.get("id")))).run();
  revalidatePath("/alertas");
}

export async function retryJobAction(formData: FormData) {
  db().update(jobs).set({ status: "queued", attempts: 0, runAt: new Date(), lastError: null }).where(and(eq(jobs.id, id.parse(formData.get("id"))), eq(jobs.status, "dead"))).run();
  revalidatePath("/fila");
}

const experimentSchema = z.object({
  name: z.string().min(3),
  funnel: z.enum(["customer", "affiliate"]),
  variable: z.enum(EXPERIMENT_VARIABLES),
  hypothesis: z.string().min(5),
  primaryMetric: z.enum(["replied", "interested", "whatsapp_handoff", "joined_affiliate_group"]),
  minSamplePerVariant: z.coerce.number().int().min(10),
  explorationRate: z.coerce.number().min(0).max(0.5),
  controlInstructions: z.string().min(3),
  challengerInstructions: z.string().min(3),
  controlFollowupDays: z.string().optional(),
  challengerFollowupDays: z.string().optional(),
});

const days = (v?: string) => (v ? v.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) : undefined);

export async function createExperimentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = experimentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Preencha todos os campos corretamente." };
  const e = parsed.data;
  const running = db().select().from(experiments).where(and(eq(experiments.funnel, e.funnel), eq(experiments.variable, e.variable), eq(experiments.status, "running"))).get();
  if (running) return { error: "Já existe um experimento rodando para essa variável neste funil. Uma variável por vez." };
  tx((t) => {
    const exp = t.insert(experiments).values({ name: e.name, funnel: e.funnel, variable: e.variable, hypothesis: e.hypothesis, primaryMetric: e.primaryMetric, minSamplePerVariant: e.minSamplePerVariant, explorationRate: e.explorationRate }).returning().get();
    t.insert(experimentVariants).values({ experimentId: exp.id, key: "control", isControl: true, content: { instructions: e.controlInstructions, followupDays: days(e.controlFollowupDays) } }).run();
    t.insert(experimentVariants).values({ experimentId: exp.id, key: "challenger", content: { instructions: e.challengerInstructions, followupDays: days(e.challengerFollowupDays) } }).run();
    recordEvent("experiment.started", { actor: "operator", payload: { experimentId: exp.id } }, t);
  });
  revalidatePath("/experimentos");
  return { ok: true };
}

export async function toggleExperimentAction(formData: FormData) {
  const expId = id.parse(formData.get("id"));
  const exp = db().select().from(experiments).where(eq(experiments.id, expId)).get();
  if (!exp || exp.status === "concluded") return;
  db().update(experiments).set({ status: exp.status === "running" ? "paused" : "running" }).where(eq(experiments.id, expId)).run();
  revalidatePath("/experimentos");
}

export async function revertChangeAction(formData: FormData) {
  revertStrategyChange(id.parse(formData.get("id")), new Date());
  revalidatePath("/experimentos");
}
