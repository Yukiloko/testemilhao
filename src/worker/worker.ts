import type { Db } from "@/db/client";
import type { Job } from "@/db/schema";
import { BudgetExceededError } from "@/features/safety/budget";
import { BROWSER_JOB_TYPES } from "@/features/safety/circuit-breaker";
import { getSettings } from "@/features/safety/settings";
import { BrowserUnavailableError, InstagramRestrictionError, SessionLostError } from "@/integrations/browser/errors";
import type { BusinessConfig } from "@/lib/business-config";
import { log } from "@/lib/logger";
import { DAY, HOUR, MINUTE, type Clock } from "@/lib/time";
import { MutexBusyError, markBrowserAvailable } from "./browser-runner";
import type { BrowserRunner, Handler, HandlerContext } from "./context";
import { circuitBreaker, createBackup, evaluateExperiments, optimizeInsights } from "./handlers/maintenance";
import { discoverHashtag, enrichProfile, ensureDailyDiscovery, planDiscovery, qualifyLead } from "./handlers/discovery";
import { createProcessInbound, createReplyInbound, expireWindows, type InstagramApi } from "./handlers/inbound";
import { planOutreach, scheduleFollowups, sendFirstDm, sendFollowup } from "./handlers/outreach";
import { cancelJob, claimNext, completeJob, enqueue, failJob, recoverExpiredLeases, rescheduleJob } from "./queue";

export type WorkerDeps = {
  d: Db;
  config: BusinessConfig;
  browser: BrowserRunner;
  api: InstagramApi;
  baseUrl: string;
  sendEnabled: boolean;
  backupDir: string;
  probeBrowser: () => Promise<boolean>;
  clock: Clock;
  random?: () => number;
  workerId?: string;
};

const PERIODIC: { type: string; everyMs: number }[] = [
  { type: "plan_outreach", everyMs: MINUTE },
  { type: "circuit_breaker", everyMs: 2 * MINUTE },
  { type: "schedule_followups", everyMs: 5 * MINUTE },
  { type: "expire_windows", everyMs: 5 * MINUTE },
  { type: "evaluate_experiments", everyMs: HOUR },
  { type: "optimize_insights", everyMs: 6 * HOUR },
  { type: "backup", everyMs: DAY },
];

const LEASE_MS = 10 * MINUTE;

export function createWorker(deps: WorkerDeps) {
  const { d } = deps;
  const workerId = deps.workerId ?? `worker-${process.pid}`;
  const handlers: Record<string, Handler> = {
    plan_discovery: planDiscovery,
    discover_hashtag: discoverHashtag,
    enrich_profile: enrichProfile,
    qualify_lead: qualifyLead,
    plan_outreach: planOutreach,
    send_first_dm: sendFirstDm,
    schedule_followups: scheduleFollowups,
    send_followup: sendFollowup,
    process_inbound: createProcessInbound(deps.api),
    reply_inbound: createReplyInbound(deps.api),
    expire_windows: expireWindows,
    evaluate_experiments: evaluateExperiments,
    optimize_insights: optimizeInsights,
    circuit_breaker: circuitBreaker,
    backup: createBackup(deps.backupDir),
  };
  let lastProbe = 0;

  function schedulePeriodic(now: Date): void {
    for (const p of PERIODIC) {
      const bucket = Math.floor(now.getTime() / p.everyMs);
      enqueue(p.type, {}, { idempotencyKey: `${p.type}:${bucket}`, maxAttempts: 1 }, d);
    }
    ensureDailyDiscovery(now, getSettings(d).operatingTimezone, d);
  }

  async function run(job: Job, now: Date): Promise<void> {
    const handler = handlers[job.type];
    if (!handler) {
      failJob({ ...job, attempts: job.maxAttempts }, `unknown job type ${job.type}`, now, d);
      return;
    }
    const ctx: HandlerContext = { job, now, d, config: deps.config, browser: deps.browser, baseUrl: deps.baseUrl, sendEnabled: deps.sendEnabled, random: deps.random ?? Math.random };
    try {
      const result = await handler(ctx);
      const finished = deps.clock();
      if (result.kind === "done") completeJob(job, finished, d);
      else if (result.kind === "cancel") cancelJob(job, result.reason, finished, d);
      else rescheduleJob(job, result.runAt, result.reason, finished, d);
      log.debug("job finished", { id: job.id, type: job.type, result });
    } catch (error) {
      const finished = deps.clock();
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MutexBusyError) return rescheduleJob(job, new Date(finished.getTime() + 30_000), message, finished, d);
      if (error instanceof BrowserUnavailableError) return rescheduleJob(job, new Date(finished.getTime() + 5 * MINUTE), message, finished, d);
      if (error instanceof BudgetExceededError) return rescheduleJob(job, new Date(finished.getTime() + HOUR), message, finished, d);
      if (error instanceof SessionLostError || error instanceof InstagramRestrictionError) {
        return rescheduleJob(job, new Date(finished.getTime() + HOUR), message, finished, d);
      }
      log.error("job failed", { id: job.id, type: job.type, error });
      failJob(job, message, finished, d);
    }
  }

  /** One scheduling step: recover, plan periodic work, run one browser job and a batch of others. */
  async function tick(): Promise<number> {
    const now = deps.clock();
    recoverExpiredLeases(now, d);
    schedulePeriodic(now);
    const s = getSettings(d);

    if (!s.browserAvailable && now.getTime() - lastProbe > 2 * MINUTE) {
      lastProbe = now.getTime();
      if (await deps.probeBrowser()) markBrowserAvailable(d);
    }

    let ran = 0;
    const browserLane = async () => {
      if (!getSettings(d).browserAvailable) return;
      const job = claimNext(workerId, BROWSER_JOB_TYPES, deps.clock(), LEASE_MS, d);
      if (job) {
        ran++;
        await run(job, deps.clock());
      }
    };
    const generalLane = async () => {
      const others = Object.keys(handlers).filter((t) => !(BROWSER_JOB_TYPES as readonly string[]).includes(t));
      for (let i = 0; i < 20; i++) {
        const job = claimNext(workerId, others, deps.clock(), LEASE_MS, d);
        if (!job) break;
        ran++;
        await run(job, deps.clock());
      }
    };
    await Promise.all([browserLane(), generalLane()]);
    return ran;
  }

  return { tick, handlers };
}
