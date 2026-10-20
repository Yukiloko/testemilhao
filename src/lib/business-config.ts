import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const placeholder = /\{\{.*\}\}/;
const filled = z.string().min(1).refine((v) => !placeholder.test(v), "still contains a {{PLACEHOLDER}}");

export const businessConfigSchema = z.object({
  ownerName: filled,
  ownerRole: filled,
  companyName: filled,
  companyWebsite: filled,
  instagramHandle: filled,
  whatsappLink: z.url(),
  affiliateGroupLink: z.url(),
  oneLinePitch: filled,
  howItWorks: z.array(filled).min(1),
  revenueModel: filled,
  marketJargon: z.array(z.object({ term: filled, meaning: filled })),
  verifiedClaims: z.array(filled),
  unverifiedClaims: z.array(z.string()),
  icpSegments: z.array(filled).min(1),
  icpKeywords: z.array(filled).min(1),
  affiliateTopics: z.array(filled),
  geography: filled,
});

export type BusinessConfig = z.infer<typeof businessConfigSchema>;

const CONFIG_PATH = path.resolve(process.cwd(), process.env.BUSINESS_CONFIG_PATH ?? "config/business.json");

let cached: BusinessConfig | undefined;
let override: BusinessConfig | undefined;

/** Single source of every real business value. Nothing else in the code may hardcode them. */
export function businessConfig(): BusinessConfig {
  if (override) return override;
  if (cached) return cached;
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error("config/business.json not found. Copy config/business.example.json and fill it in.");
  }
  const raw: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const parsed = businessConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config/business.json:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function businessConfigExists(): boolean {
  return override !== undefined || fs.existsSync(CONFIG_PATH);
}

/** Test hook: replaces the file-based config. */
export function setBusinessConfigForTests(config: BusinessConfig | undefined): void {
  override = config;
}
