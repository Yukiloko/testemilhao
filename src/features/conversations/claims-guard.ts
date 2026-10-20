import { z } from "zod";
import type { BusinessConfig } from "@/lib/business-config";
import { fold } from "@/features/leads/text-match";

export type ClaimCheck = { ok: true } | { ok: false; violations: string[] };

const STOPWORDS = new Set(["a", "o", "e", "de", "da", "do", "das", "dos", "em", "no", "na", "para", "com", "por", "que", "um", "uma", "os", "as", "seu", "sua", "voce", "nos", "nosso", "nossa"]);

const RISKY_PHRASES = [
  "garantid",
  "sem risco",
  "100%",
  "melhor do mercado",
  "melhor do brasil",
  "lider",
  "numero 1",
  "taxa zero",
  "sem taxa",
  "aprovacao imediata",
  "aprovacao garantida",
  "lucro certo",
  "renda garantida",
  "sou cliente",
  "sou seu cliente",
  "parceiro oficial",
];

function tokens(text: string): string[] {
  return fold(text)
    .replace(/[^\p{L}\p{N}%$ ]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function numericFacts(text: string): string[] {
  return fold(text).match(/(r\$\s?\d[\d.,]*|\d[\d.,]*\s?%|\d[\d.,]*\s?(dias|horas|meses|reais|x))/g) ?? [];
}

/**
 * Deterministic last line of defence before anything is sent. It cannot prove a message is
 * true, but it reliably catches the dangerous shapes: unverified claims, invented numbers,
 * guarantees/superlatives, impersonation and unknown links.
 */
const LINK = /(https?:\/\/[^\s)]+|www\.[^\s)]+|wa\.me\/[^\s)]+)/g;

export function checkClaims(message: string, config: BusinessConfig): ClaimCheck {
  const violations: string[] = [];
  const links = fold(message).match(LINK) ?? [];
  // Text checks run on the prose only; URL-encoded query strings are not claims.
  const prose = message.replace(LINK, " ");
  const folded = fold(prose);
  const verifiedText = fold(config.verifiedClaims.join(" \n "));
  const msgTokens = new Set(tokens(prose));

  for (const claim of config.unverifiedClaims) {
    const claimTokens = tokens(claim);
    if (claimTokens.length === 0) continue;
    const overlap = claimTokens.filter((t) => msgTokens.has(t)).length / claimTokens.length;
    if (overlap >= 0.6) violations.push(`unverified claim: "${claim}"`);
  }
  for (const fact of numericFacts(prose)) {
    if (!verifiedText.includes(fact.replace(/\s+/g, " ").trim())) violations.push(`unverified figure: "${fact}"`);
  }
  for (const phrase of RISKY_PHRASES) {
    if (folded.includes(phrase) && !verifiedText.includes(phrase)) violations.push(`risky phrase: "${phrase}"`);
  }
  const allowedLinks = [config.whatsappLink, config.affiliateGroupLink, config.companyWebsite].map((l) => fold(l).replace(/^https?:\/\//, "").replace(/\/$/, ""));
  for (const link of links) {
    const bare = link.replace(/^https?:\/\//, "").replace(/[.,!?]+$/, "").replace(/\/$/, "");
    if (!allowedLinks.some((a) => bare.startsWith(a) || a.startsWith(bare))) violations.push(`unknown link: ${link}`);
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}

export const claimReviewSchema = z.object({
  unsupportedClaims: z.array(z.string()).describe("Statements about the company, offer, fees, conditions or results not backed by VERIFIED_CLAIMS"),
});
