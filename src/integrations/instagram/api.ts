import "server-only";
import { env } from "@/lib/env";

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
  ) {
    super(message);
  }

  /** Errors that retrying cannot fix: permission, recipient eligibility, closed messaging window. */
  get isPermanent(): boolean {
    return this.status === 400 || this.status === 403 || this.code === 10 || this.code === 200 || this.code === 551;
  }
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);

export function setGraphFetch(next: Fetch | undefined): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

async function graph<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
  const e = env();
  const res = await fetchImpl(`${e.INSTAGRAM_GRAPH_API_URL}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${e.INSTAGRAM_PAGE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } } & T;
  if (!res.ok || json.error) {
    throw new GraphApiError(json.error?.message ?? `Graph API ${res.status}`, res.status, json.error?.code ?? null, json.error?.error_subcode ?? null);
  }
  return json;
}

/** Official Send API. Only valid inside the 24h window opened by the lead's own message. */
export async function sendInstagramMessage(recipientIgsid: string, text: string): Promise<{ messageId: string }> {
  const result = await graph<{ message_id: string }>("/me/messages", {
    method: "POST",
    body: { recipient: { id: recipientIgsid }, message: { text }, messaging_type: "RESPONSE" },
  });
  return { messageId: result.message_id };
}

/** Resolves the Instagram-scoped ID of someone who messaged us to their @handle. */
export async function fetchUsername(igsid: string): Promise<string | null> {
  const result = await graph<{ username?: string }>(`/${encodeURIComponent(igsid)}?fields=username,name`, { method: "GET" });
  return result.username ?? null;
}

export function isApiConfigured(): boolean {
  const e = env();
  return !e.INSTAGRAM_PAGE_ACCESS_TOKEN.startsWith("replace") && !e.INSTAGRAM_BUSINESS_ACCOUNT_ID.startsWith("replace");
}
