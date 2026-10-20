import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { messages } from "@/db/schema";
import { getSettings } from "@/features/safety/settings";
import { AFTERNOON, conversationOf, freshDb, makeLead } from "@/test/helpers";
import { assertCanWrite, ChannelLockError, closeExpiredWindow, transitionChannel } from "./channel";
import { DuplicateSendError, markFailed, markSent, reserveOutbound } from "./outbound";
import { HOUR } from "@/lib/time";

let d: Db;
beforeEach(() => {
  d = freshDb();
});

describe("channel ownership lock", () => {
  it("refuses transitions from unexpected states", () => {
    const lead = makeLead(d, "loja");
    expect(() => transitionChannel(lead.id, { from: ["waiting_inbound_reply"], to: "api_eligible", actor: "webhook", reason: "x" }, d)).toThrow(ChannelLockError);
  });

  it("after handoff the browser can no longer write to the thread", () => {
    const lead = makeLead(d, "loja");
    transitionChannel(lead.id, { from: ["browser_contact_pending"], to: "waiting_inbound_reply", owner: "browser", actor: "browser", reason: "sent" }, d);
    expect(() => assertCanWrite(conversationOf(d, lead.id), "browser", AFTERNOON)).not.toThrow();
    transitionChannel(lead.id, { from: ["waiting_inbound_reply"], to: "api_eligible", owner: "api", actor: "webhook", reason: "reply", set: { windowExpiresAt: new Date(AFTERNOON.getTime() + 24 * HOUR) } }, d);
    expect(() => assertCanWrite(conversationOf(d, lead.id), "browser", AFTERNOON)).toThrow(ChannelLockError);
    expect(() => assertCanWrite(conversationOf(d, lead.id), "api", AFTERNOON)).not.toThrow();
  });

  it("closes the 24h API window when it expires", () => {
    const lead = makeLead(d, "loja");
    transitionChannel(lead.id, { from: ["browser_contact_pending"], to: "api_eligible", owner: "api", actor: "webhook", reason: "reply", set: { windowExpiresAt: new Date(AFTERNOON.getTime() + HOUR) } }, d);
    expect(closeExpiredWindow(lead.id, AFTERNOON, d)).toBe(false);
    expect(closeExpiredWindow(lead.id, new Date(AFTERNOON.getTime() + 2 * HOUR), d)).toBe(true);
    expect(conversationOf(d, lead.id).channelState).toBe("api_window_closed");
    expect(() => assertCanWrite(conversationOf(d, lead.id), "api", new Date(AFTERNOON.getTime() + 2 * HOUR))).toThrow(/channel is api_window_closed|may not write/);
  });
});

describe("duplicate-send lock", () => {
  const base = { channel: "browser" as const, kind: "opening" as const, body: "oi", dedupeKey: "opening:1" };

  it("refuses a second send after success", () => {
    const lead = makeLead(d, "loja");
    const m = reserveOutbound({ ...base, leadId: lead.id }, d);
    markSent(m.id, null, AFTERNOON, d);
    expect(() => reserveOutbound({ ...base, leadId: lead.id }, d)).toThrow(DuplicateSendError);
    expect(d.select().from(messages).all()).toHaveLength(1);
  });

  it("allows a retry when the first attempt certainly failed", () => {
    const lead = makeLead(d, "loja");
    const m = reserveOutbound({ ...base, leadId: lead.id }, d);
    markFailed(m.id, "button not found", d);
    expect(reserveOutbound({ ...base, leadId: lead.id }, d).id).toBe(m.id);
  });

  it("refuses and pauses the system when a previous send may have gone out", () => {
    const lead = makeLead(d, "loja");
    reserveOutbound({ ...base, leadId: lead.id }, d);
    expect(() => reserveOutbound({ ...base, leadId: lead.id }, d)).toThrow(DuplicateSendError);
    expect(getSettings(d)).toMatchObject({ paused: true });
  });
});
