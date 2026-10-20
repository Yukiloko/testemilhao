import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { db, type Db } from "@/db/client";
import { browserArtifacts } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { log } from "@/lib/logger";
import type { PageDiagnostics } from "./session";

/**
 * On failure keep everything needed to debug without re-running: screenshot, accessibility
 * snapshot, URL, console errors, network failures and the job id. Screenshots of DMs contain
 * personal data, so files are AES-256-GCM encrypted at rest.
 */
export async function captureFailure(
  page: Page,
  diagnostics: PageDiagnostics,
  input: { jobId?: number | null; leadId?: number | null; error: string; dir: string; key: string },
  d: Db = db(),
): Promise<void> {
  const stamp = `${Date.now()}-${input.jobId ?? "nojob"}`;
  fs.mkdirSync(input.dir, { recursive: true });
  let screenshotPath: string | null = null;
  let snapshotPath: string | null = null;
  try {
    screenshotPath = path.join(input.dir, `${stamp}.png.enc`);
    fs.writeFileSync(screenshotPath, encrypt(await page.screenshot({ fullPage: false, timeout: 5_000 }), input.key));
  } catch (error) {
    screenshotPath = null;
    log.warn("screenshot capture failed", { error });
  }
  try {
    snapshotPath = path.join(input.dir, `${stamp}.aria.txt.enc`);
    fs.writeFileSync(snapshotPath, encrypt(Buffer.from(await page.locator("body").ariaSnapshot({ timeout: 5_000 })), input.key));
  } catch (error) {
    snapshotPath = null;
    log.warn("aria snapshot capture failed", { error });
  }
  d.insert(browserArtifacts)
    .values({
      jobId: input.jobId ?? null,
      leadId: input.leadId ?? null,
      url: page.url(),
      error: input.error,
      screenshotPath,
      snapshotPath,
      consoleErrors: diagnostics.consoleErrors.slice(-20),
      networkFailures: diagnostics.networkFailures.slice(-20),
    })
    .run();
}
