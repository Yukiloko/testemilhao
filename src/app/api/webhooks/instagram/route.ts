import { NextResponse, type NextRequest } from "next/server";
import { storeWebhookEvents } from "@/features/conversations/inbound";
import { parseMessagingEvents, verifySignature } from "@/integrations/instagram/webhook";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/crypto";
import { enqueue } from "@/worker/queue";

export const dynamic = "force-dynamic";

/** Meta's subscription handshake. */
export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const token = p.get("hub.verify_token") ?? "";
  if (p.get("hub.mode") === "subscribe" && safeEqual(token, env().INSTAGRAM_WEBHOOK_VERIFY_TOKEN)) {
    return new NextResponse(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("forbidden", { status: 403 });
}

/**
 * Verifies the signature, stores each message once (idempotent on Meta's mid) and hands it to
 * the worker. Answers fast; all processing happens in durable jobs.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), env().INSTAGRAM_APP_SECRET)) {
    log.warn("webhook signature rejected");
    return new NextResponse("invalid signature", { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }
  const ids = storeWebhookEvents(parseMessagingEvents(body));
  for (const id of ids) enqueue("process_inbound", { webhookEventId: id }, { idempotencyKey: `inbound:${id}`, priority: 10, maxAttempts: 5 });
  return NextResponse.json({ received: ids.length });
}
