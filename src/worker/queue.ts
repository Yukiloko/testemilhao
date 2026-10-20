import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { db, tx, type Db } from "@/db/client";
import { jobs, locks, type Job } from "@/db/schema";
import { raiseAlert, recordEvent } from "@/features/safety/audit";
import { MINUTE } from "@/lib/time";

export type EnqueueOptions = { runAt?: Date; priority?: number; idempotencyKey?: string; maxAttempts?: number };

/** Idempotent when an idempotency key is given: enqueuing the same work twice is a no-op. */
export function enqueue(type: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}, d: Db = db()): Job | undefined {
  return d
    .insert(jobs)
    .values({
      type,
      payload,
      runAt: opts.runAt ?? new Date(),
      priority: opts.priority ?? 0,
      idempotencyKey: opts.idempotencyKey ?? null,
      maxAttempts: opts.maxAttempts ?? 3,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning()
    .get();
}

export function hasOpenJob(type: string, d: Db = db()): boolean {
  return d.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.type, type), inArray(jobs.status, ["queued", "running"]))).get() !== undefined;
}

/** Atomically leases the next due job. `types` lets the browser lane and the general lane run separately. */
export function claimNext(workerId: string, types: readonly string[] | null, now: Date, leaseMs: number, d: Db = db()): Job | undefined {
  return tx((t) => {
    const conds = [eq(jobs.status, "queued"), lte(jobs.runAt, now)];
    if (types) conds.push(inArray(jobs.type, [...types]));
    const next = t.select().from(jobs).where(and(...conds)).orderBy(desc(jobs.priority), asc(jobs.runAt), asc(jobs.id)).get();
    if (!next) return undefined;
    return t
      .update(jobs)
      .set({ status: "running", attempts: next.attempts + 1, leaseUntil: new Date(now.getTime() + leaseMs), lockedBy: workerId, updatedAt: now })
      .where(and(eq(jobs.id, next.id), eq(jobs.status, "queued")))
      .returning()
      .get();
  }, d);
}

export function completeJob(job: Job, now: Date, d: Db = db()): void {
  d.update(jobs).set({ status: "succeeded", finishedAt: now, leaseUntil: null, updatedAt: now }).where(eq(jobs.id, job.id)).run();
}

/** Waiting for a condition (pacing, window, pause) is not a failure: the attempt is given back. */
export function rescheduleJob(job: Job, runAt: Date, reason: string, now: Date, d: Db = db()): void {
  d.update(jobs)
    .set({ status: "queued", runAt, attempts: Math.max(0, job.attempts - 1), leaseUntil: null, lastError: `waiting: ${reason}`, updatedAt: now })
    .where(eq(jobs.id, job.id))
    .run();
}

export function cancelJob(job: Job, reason: string, now: Date, d: Db = db()): void {
  d.update(jobs).set({ status: "cancelled", lastError: reason, finishedAt: now, leaseUntil: null, updatedAt: now }).where(eq(jobs.id, job.id)).run();
}

/** Exponential backoff; after maxAttempts the job is dead-lettered and the operator is alerted. */
export function failJob(job: Job, error: string, now: Date, d: Db = db()): "retry" | "dead" {
  if (job.attempts >= job.maxAttempts) {
    d.update(jobs).set({ status: "dead", lastError: error, finishedAt: now, leaseUntil: null, updatedAt: now }).where(eq(jobs.id, job.id)).run();
    raiseAlert("warning", "job_dead", `Job ${job.type} #${job.id} falhou ${job.attempts}x e foi para a dead-letter`, { error }, d);
    recordEvent("job.dead", { jobId: job.id, actor: "system", payload: { type: job.type, error } }, d);
    return "dead";
  }
  const backoff = Math.min(60, 2 ** job.attempts) * MINUTE;
  d.update(jobs)
    .set({ status: "queued", lastError: error, runAt: new Date(now.getTime() + backoff), leaseUntil: null, updatedAt: now })
    .where(eq(jobs.id, job.id))
    .run();
  return "retry";
}

/** Recovery after a crash/restart: jobs whose lease expired go back to the queue (or dead-letter). */
export function recoverExpiredLeases(now: Date, d: Db = db()): number {
  const stale = d.select().from(jobs).where(and(eq(jobs.status, "running"), lt(jobs.leaseUntil, now))).all();
  for (const job of stale) failJob(job, "lease expired (worker restarted or hung)", now, d);
  return stale.length;
}

/** Cross-process mutex with a lease, so a crashed holder never blocks forever. */
export function acquireLock(name: string, owner: string, ttlMs: number, now: Date, d: Db = db()): boolean {
  return tx((t) => {
    const current = t.select().from(locks).where(eq(locks.name, name)).get();
    if (current && current.owner !== owner && current.expiresAt.getTime() > now.getTime()) return false;
    t.insert(locks)
      .values({ name, owner, expiresAt: new Date(now.getTime() + ttlMs) })
      .onConflictDoUpdate({ target: locks.name, set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } })
      .run();
    return true;
  }, d);
}

export function releaseLock(name: string, owner: string, d: Db = db()): void {
  d.delete(locks).where(and(eq(locks.name, name), eq(locks.owner, owner))).run();
}

export function queueStats(d: Db = db()): Record<string, number> {
  const rows = d.select({ status: jobs.status, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.status).all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
