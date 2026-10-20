import type { Lead } from "@/db/schema";

export function profileText(lead: Lead): string {
  return [lead.displayName, lead.bio, lead.category, lead.location, ...(lead.signals.recentCaptions ?? []), ...(lead.signals.hashtags ?? [])]
    .filter(Boolean)
    .join(" \n ");
}
