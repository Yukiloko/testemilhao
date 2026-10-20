import { describe, expect, it } from "vitest";
import { aiCalls, jobs } from "@/db/schema";
import { AFTERNOON, freshDb, makeLead } from "@/test/helpers";
import { recordEvent } from "./audit";
import { assertWithinBudget, BudgetExceededError } from "./budget";
import { evaluateCircuitBreaker } from "./circuit-breaker";
import { getSettings } from "./settings";

describe("circuit breaker", () => {
  it("trips on an abnormal browser error rate", () => {
    const d = freshDb();
    for (const status of ["failed", "dead", "dead", "succeeded"] as const) {
      d.insert(jobs).values({ type: "send_first_dm", status, runAt: AFTERNOON, updatedAt: AFTERNOON }).run();
    }
    expect(evaluateCircuitBreaker(AFTERNOON, d)).toBe("browserErrors");
    expect(getSettings(d).paused).toBe(true);
  });

  it("trips when opt-outs spike relative to replies", () => {
    const d = freshDb();
    const lead = makeLead(d, "x");
    for (let i = 0; i < 6; i++) recordEvent("message.inbound", { leadId: lead.id, actor: "webhook" }, d);
    for (let i = 0; i < 3; i++) recordEvent("lead.opted_out", { leadId: lead.id, actor: "ai" }, d);
    expect(evaluateCircuitBreaker(new Date(), d)).toBe("optOutSpike");
  });

  it("stays closed in normal operation", () => {
    const d = freshDb();
    expect(evaluateCircuitBreaker(AFTERNOON, d)).toBeNull();
    expect(getSettings(d).paused).toBe(false);
  });
});

describe("budget", () => {
  it("cuts off and pauses at the monthly ceiling, counting only this month", () => {
    const d = freshDb();
    d.insert(aiCalls).values({ purpose: "x", model: "m", costUsd: 100, ok: true, createdAt: new Date("2027-02-15T00:00:00Z") }).run();
    expect(() => assertWithinBudget(5, AFTERNOON, d)).not.toThrow();
    d.insert(aiCalls).values({ purpose: "x", model: "m", costUsd: 5, ok: true, createdAt: AFTERNOON }).run();
    expect(() => assertWithinBudget(5, AFTERNOON, d)).toThrow(BudgetExceededError);
    expect(getSettings(d).paused).toBe(true);
  });
});
