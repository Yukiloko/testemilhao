import { gte, sql } from "drizzle-orm";
import { db, type Db } from "@/db/client";
import { aiCalls } from "@/db/schema";
import { trip } from "./circuit-breaker";

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`OpenAI monthly budget reached: ${spent.toFixed(2)} / ${budget.toFixed(2)} USD`);
  }
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function monthlySpendUsd(now: Date, d: Db = db()): number {
  const row = d
    .select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)` })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, monthStartUtc(now)))
    .get();
  return row?.total ?? 0;
}

/** Called before every OpenAI request. Reaching the ceiling pauses the whole system. */
export function assertWithinBudget(budgetUsd: number, now: Date, d: Db = db()): void {
  const spent = monthlySpendUsd(now, d);
  if (spent >= budgetUsd) {
    trip("budget", d);
    throw new BudgetExceededError(spent, budgetUsd);
  }
}
