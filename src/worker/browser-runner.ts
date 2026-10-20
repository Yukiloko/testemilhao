import type { Db } from "@/db/client";
import { raiseAlert, recordEvent } from "@/features/safety/audit";
import { trip } from "@/features/safety/circuit-breaker";
import { getSettings, updateSettings } from "@/features/safety/settings";
import { captureFailure } from "@/integrations/browser/artifacts";
import { BrowserActionError, BrowserUnavailableError, InstagramRestrictionError, SessionLostError } from "@/integrations/browser/errors";
import { withAgentPage } from "@/integrations/browser/session";
import { MINUTE } from "@/lib/time";
import type { BrowserRunner } from "./context";
import { acquireLock, releaseLock } from "./queue";

const MUTEX = "browser";

export class MutexBusyError extends Error {}

/**
 * Wraps every browser job: one at a time (DB mutex), failures captured as encrypted artifacts,
 * and account-level dangers (restriction, lost session) trip the circuit breaker immediately.
 */
export function createBrowserRunner(input: { cdpUrl: string; baseUrl: string; artifactsDir: string; encryptionKey: string; workerId: string; d: Db }): BrowserRunner {
  const { d } = input;
  return async (meta, fn) => {
    if (!acquireLock(MUTEX, input.workerId, 10 * MINUTE, new Date(), d)) {
      throw new MutexBusyError("browser mutex held by another worker");
    }
    try {
      const result = await withAgentPage(input.cdpUrl, input.baseUrl, async (page, diagnostics) => {
        try {
          return await fn(page, diagnostics);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await captureFailure(page, diagnostics, { jobId: meta.jobId, leadId: meta.leadId, error: message, dir: input.artifactsDir, key: input.encryptionKey }, d);
          throw error;
        }
      });
      if (!getSettings(d).browserAvailable) markBrowserAvailable(d);
      return result;
    } catch (error) {
      const root = error instanceof BrowserActionError && error.cause ? error.cause : error;
      if (root instanceof InstagramRestrictionError) trip("instagramRestriction", d);
      if (root instanceof SessionLostError) trip("sessionLost", d);
      if (error instanceof BrowserUnavailableError) markBrowserUnavailable(error.message, d);
      throw error;
    } finally {
      releaseLock(MUTEX, input.workerId, d);
    }
  };
}

export function markBrowserUnavailable(reason: string, d: Db): void {
  if (!getSettings(d).browserAvailable) return;
  updateSettings({ browserAvailable: false }, d);
  recordEvent("browser_unavailable", { actor: "system", payload: { reason } }, d);
  raiseAlert("critical", "browser_unavailable", "Chrome indisponível via CDP. Fila do navegador pausada até a conexão voltar.", { reason }, d);
}

export function markBrowserAvailable(d: Db): void {
  updateSettings({ browserAvailable: true }, d);
  recordEvent("browser_available", { actor: "system" }, d);
}
