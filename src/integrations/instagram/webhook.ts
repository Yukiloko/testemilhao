import { z } from "zod";
import { hmacSha256Hex, safeEqual } from "@/lib/crypto";

/** Meta signs the raw body with the app secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7), hmacSha256Hex(appSecret, rawBody));
}

const messagingSchema = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: z
    .object({
      mid: z.string(),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      is_deleted: z.boolean().optional(),
      attachments: z.array(z.object({ type: z.string() })).optional(),
    })
    .optional(),
});

const payloadSchema = z.object({
  object: z.string(),
  entry: z.array(z.object({ id: z.string(), time: z.number(), messaging: z.array(z.unknown()).optional() })),
});

export type InboundEvent = {
  mid: string;
  senderId: string;
  recipientId: string;
  text: string;
  timestamp: Date;
  isEcho: boolean;
};

/** Extracts text messages and echoes; ignores reads, reactions, deletions and malformed entries. */
export function parseMessagingEvents(body: unknown): InboundEvent[] {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== "instagram") return [];
  const out: InboundEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const raw of entry.messaging ?? []) {
      const m = messagingSchema.safeParse(raw);
      if (!m.success || !m.data.message || m.data.message.is_deleted) continue;
      const text = m.data.message.text ?? (m.data.message.attachments?.length ? `[${m.data.message.attachments.map((a) => a.type).join(", ")}]` : "");
      if (!text) continue;
      out.push({
        mid: m.data.message.mid,
        senderId: m.data.sender.id,
        recipientId: m.data.recipient.id,
        text,
        timestamp: new Date(m.data.timestamp),
        isEcho: m.data.message.is_echo === true,
      });
    }
  }
  return out;
}
