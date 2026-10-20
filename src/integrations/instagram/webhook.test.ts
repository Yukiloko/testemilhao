import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { storeWebhookEvents } from "@/features/conversations/inbound";
import { freshDb } from "@/test/helpers";
import { parseMessagingEvents, verifySignature } from "./webhook";

const secret = "s3cret";
const sign = (body: string) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

const payload = {
  object: "instagram",
  entry: [
    {
      id: "1",
      time: 1,
      messaging: [
        { sender: { id: "u1" }, recipient: { id: "me" }, timestamp: 1_700_000_000_000, message: { mid: "m1", text: "oi" } },
        { sender: { id: "me" }, recipient: { id: "u1" }, timestamp: 1_700_000_000_001, message: { mid: "m2", text: "eco", is_echo: true } },
        { sender: { id: "u1" }, recipient: { id: "me" }, timestamp: 1, read: { mid: "m1" } },
        { sender: { id: "u1" }, recipient: { id: "me" }, timestamp: 2, message: { mid: "m3", is_deleted: true } },
        { garbage: true },
      ],
    },
  ],
};

describe("webhook", () => {
  it("verifies the HMAC signature in constant time", () => {
    const body = JSON.stringify(payload);
    expect(verifySignature(body, sign(body), secret)).toBe(true);
    expect(verifySignature(body + " ", sign(body), secret)).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, "sha1=abc", secret)).toBe(false);
  });

  it("extracts text messages and echoes, ignoring reads, deletions and garbage", () => {
    const events = parseMessagingEvents(payload);
    expect(events.map((e) => [e.mid, e.isEcho])).toEqual([["m1", false], ["m2", true]]);
    expect(parseMessagingEvents({ object: "page", entry: [] })).toEqual([]);
  });

  it("stores each Meta message id once (idempotent redelivery)", () => {
    const d = freshDb();
    const events = parseMessagingEvents(payload);
    expect(storeWebhookEvents(events, d)).toHaveLength(2);
    expect(storeWebhookEvents(events, d)).toHaveLength(0);
  });
});
