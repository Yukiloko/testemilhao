import type { Page } from "playwright-core";
import type { Db } from "@/db/client";
import type { Job } from "@/db/schema";
import type { BusinessConfig } from "@/lib/business-config";
import type { PageDiagnostics } from "@/integrations/browser/session";

export type BrowserRunner = <T>(meta: { jobId: number; leadId?: number | null }, fn: (page: Page, diagnostics: PageDiagnostics) => Promise<T>) => Promise<T>;

export type HandlerContext = {
  job: Job;
  now: Date;
  d: Db;
  config: BusinessConfig;
  browser: BrowserRunner;
  baseUrl: string;
  sendEnabled: boolean;
  random: () => number;
};

export type HandlerResult = { kind: "done"; note?: string } | { kind: "reschedule"; runAt: Date; reason: string } | { kind: "cancel"; reason: string };

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

export const done = (note?: string): HandlerResult => ({ kind: "done", note });
export const later = (runAt: Date, reason: string): HandlerResult => ({ kind: "reschedule", runAt, reason });
export const cancel = (reason: string): HandlerResult => ({ kind: "cancel", reason });

export function payloadNumber(job: Job, key: string): number {
  const value = job.payload[key];
  if (typeof value !== "number") throw new Error(`job ${job.id} (${job.type}) missing numeric payload.${key}`);
  return value;
}

export function payloadString(job: Job, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string") throw new Error(`job ${job.id} (${job.type}) missing payload.${key}`);
  return value;
}
