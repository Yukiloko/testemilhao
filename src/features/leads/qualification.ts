import { eq } from "drizzle-orm";
import { db, type Db } from "@/db/client";
import { leads, type Lead, type LeadRole } from "@/db/schema";
import type { BusinessConfig } from "@/lib/business-config";
import { scoreAffiliate } from "@/features/affiliates/qualification";
import { recordEvent } from "@/features/safety/audit";
import { transitionPipeline } from "./pipeline";
import { profileText } from "./profile-text";
import { matches } from "./text-match";

export type Qualification = { score: number; reasons: string[]; role: LeadRole; niche: string | null };

const ROLE_PATTERNS: [LeadRole, RegExp][] = [
  ["owner", /\b(ceo|fundador|fundadora|founder|dono|dona|proprietari[oa]|socio|socia|owner)\b/],
  ["decision_maker", /\b(gerente|diretor|diretora|manager|head|coordenador|coordenadora|gestor|gestora)\b/],
  ["employee", /\b(vendedor|vendedora|atendente|consultor|consultora|colaborador|colaboradora)\b/],
  ["store", /\b(loja|store|shop|oficial|atacado|varejo|delivery|pedidos)\b/],
];

export function detectRole(text: string): LeadRole {
  const folded = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return ROLE_PATTERNS.find(([, re]) => re.test(folded))?.[0] ?? "unknown";
}

/** Transparent, rule-based ICP fit. Each point awarded is explained in `reasons`. */
export function scoreCustomer(lead: Lead, config: BusinessConfig): Qualification {
  const text = profileText(lead);
  const reasons: string[] = [];
  let score = 0;

  const keywordHits = matches(text, config.icpKeywords);
  if (keywordHits.length) {
    score += Math.min(40, keywordHits.length * 15);
    reasons.push(`keywords: ${keywordHits.join(", ")}`);
  }
  const segmentHits = matches(text, config.icpSegments);
  if (segmentHits.length) {
    score += 20;
    reasons.push(`segment: ${segmentHits[0]}`);
  }
  if (lead.signals.isBusiness) {
    score += 10;
    reasons.push("business account");
  }
  if (matches(text, [config.geography]).length) {
    score += 10;
    reasons.push("geography match");
  }
  const followers = lead.followers ?? 0;
  if (followers >= 300 && followers <= 100_000) {
    score += 10;
    reasons.push("followers in range");
  }
  if (lead.signals.isPrivate) {
    score = Math.min(score, 30);
    reasons.push("private profile (capped)");
  } else {
    score += 10;
  }

  const role = detectRole(text);
  if (role === "owner" || role === "decision_maker") reasons.push(`role: ${role}`);
  return { score: Math.min(100, score), reasons, role, niche: segmentHits[0] ?? keywordHits[0] ?? null };
}

export function qualify(lead: Lead, config: BusinessConfig): Qualification {
  return lead.funnel === "customer" ? scoreCustomer(lead, config) : scoreAffiliate(lead, config);
}

const ROLE_PRIORITY: Record<LeadRole, number> = { owner: 20, decision_maker: 15, store: 10, creator: 5, employee: 0, unknown: 0 };

/**
 * Persists the score and decides: qualified (queued for first contact) or closed as poor fit.
 * `nicheBoost` lets the optimizer promote niches that convert better.
 */
export function applyQualification(
  lead: Lead,
  q: Qualification,
  input: { minScore: number; nicheBoost?: number; bestSendHour?: number | null },
  d: Db = db(),
): "qualified" | "rejected" {
  const priority = Math.round(q.score + ROLE_PRIORITY[q.role] + (input.nicheBoost ?? 0));
  d.update(leads)
    .set({ score: q.score, scoreReasons: q.reasons, role: q.role, niche: q.niche, priority, bestSendHour: input.bestSendHour ?? null })
    .where(eq(leads.id, lead.id))
    .run();
  recordEvent("lead.scored", { leadId: lead.id, actor: "system", payload: { ...q, priority } }, d);
  if (q.score < input.minScore) {
    transitionPipeline(lead.id, "closed", { actor: "system", reason: `score ${q.score} below ${input.minScore}` }, d);
    return "rejected";
  }
  transitionPipeline(lead.id, "qualified", { actor: "system", reason: `score ${q.score}` }, d);
  return "qualified";
}
