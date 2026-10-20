import type { Lead } from "@/db/schema";
import type { BusinessConfig } from "@/lib/business-config";
import type { Qualification } from "@/features/leads/qualification";
import { profileText } from "@/features/leads/profile-text";
import { fold, matches } from "@/features/leads/text-match";

const PT_MARKERS = [" voce ", " nao ", " para ", " com ", " meu ", " minha ", " dicas ", " link na bio "];

function looksPortuguese(text: string): boolean {
  const t = ` ${fold(text)} `;
  return PT_MARKERS.filter((m) => t.includes(m)).length >= 2;
}

/**
 * Creator fit: topic relevance, language, real engagement and audience size.
 * The optimizer later re-weights by which affiliates actually generate active customers.
 */
export function scoreAffiliate(lead: Lead, config: BusinessConfig): Qualification {
  const text = profileText(lead);
  const reasons: string[] = [];
  let score = 0;

  const topicHits = matches(text, config.affiliateTopics);
  if (topicHits.length) {
    score += Math.min(35, 20 + topicHits.length * 8);
    reasons.push(`topics: ${topicHits.join(", ")}`);
  }
  if (lead.signals.language === "pt" || looksPortuguese(text)) {
    score += 10;
    reasons.push("portuguese content");
  }
  if (matches(text, [config.geography]).length) {
    score += 10;
    reasons.push("geography match");
  }
  const engagement = lead.signals.engagementRate ?? 0;
  if (engagement >= 0.03) {
    score += 20;
    reasons.push(`engagement ${(engagement * 100).toFixed(1)}%`);
  } else if (engagement >= 0.01) {
    score += 10;
    reasons.push(`engagement ${(engagement * 100).toFixed(1)}%`);
  }
  if ((lead.postsCount ?? 0) >= 30) {
    score += 10;
    reasons.push("consistent posting");
  }
  const followers = lead.followers ?? 0;
  if (followers >= 2_000 && followers <= 500_000) {
    score += 15;
    reasons.push("audience size in range");
  }
  if (lead.signals.isPrivate) {
    score = Math.min(score, 20);
    reasons.push("private profile (capped)");
  }
  return { score: Math.min(100, score), reasons, role: "creator", niche: topicHits[0] ?? null };
}
