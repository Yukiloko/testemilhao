import type { BusinessConfig } from "@/lib/business-config";
import type { Funnel } from "@/db/schema";

/** Where an interested lead is sent: the sales WhatsApp for stores, the affiliate group for creators. */
export function handoffLink(funnel: Funnel, config: BusinessConfig, handle?: string): string {
  if (funnel === "affiliate") return config.affiliateGroupLink;
  const url = new URL(config.whatsappLink);
  if (handle && url.hostname === "wa.me" && !url.searchParams.has("text")) {
    url.searchParams.set("text", `Oi! Vim pelo Instagram (@${handle}) e quero saber mais sobre a ${config.companyName}.`);
  }
  return url.toString();
}
