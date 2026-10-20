import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { messages } from "@/db/schema";
import { updateSettings, getSettings } from "@/features/safety/settings";
import { AFTERNOON, freshDb, makeLead } from "@/test/helpers";
import { DAY } from "@/lib/time";
import { checkBrowserPacing, warmupCap } from "./pacing";

let d: Db;
beforeEach(() => {
  d = freshDb();
});

function sentAt(leadId: number, at: Date, i: number) {
  d.insert(messages).values({ leadId, direction: "outbound", channel: "browser", kind: "opening", body: "x", status: "sent", dedupeKey: `k${i}`, createdAt: at, sentAt: at }).run();
}

describe("browser pacing", () => {
  it("only sends inside the operating window", () => {
    const night = new Date("2027-03-10T02:00:00Z"); // 23:00 in São Paulo
    const r = checkBrowserPacing(night, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAt.toISOString()).toBe("2027-03-10T12:00:00.000Z");
  });

  it("warms up: 5/day in week one, +5 per week, capped by the daily max", () => {
    const s = getSettings(d);
    expect(warmupCap({ ...s, warmupStartedAt: null }, AFTERNOON)).toBe(5);
    expect(warmupCap({ ...s, warmupStartedAt: new Date(AFTERNOON.getTime() - 15 * DAY).toISOString() }, AFTERNOON)).toBe(15);
    expect(warmupCap({ ...s, warmupStartedAt: new Date(AFTERNOON.getTime() - 300 * DAY).toISOString() }, AFTERNOON)).toBe(30);
  });

  it("enforces the daily cap and a randomised interval", () => {
    const lead = makeLead(d, "loja");
    updateSettings({ warmupStartedAt: AFTERNOON.toISOString() }, d);
    sentAt(lead.id, new Date(AFTERNOON.getTime() - 60_000), 0);
    const tooSoon = checkBrowserPacing(AFTERNOON, d, () => 0);
    expect(tooSoon).toMatchObject({ ok: false, reason: "interval" });
    expect(checkBrowserPacing(new Date(AFTERNOON.getTime() + 60_000), d, () => 0)).toEqual({ ok: true });
    for (let i = 1; i < 5; i++) sentAt(lead.id, new Date(AFTERNOON.getTime() - i * 3_600_000), i);
    expect(checkBrowserPacing(new Date(AFTERNOON.getTime() + 600_000), d, () => 0)).toMatchObject({ ok: false, reason: "daily_cap_5" });
  });
});
