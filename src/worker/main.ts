import "@/lib/load-env";
import { db } from "@/db/client";
import { businessConfig } from "@/lib/business-config";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { systemClock } from "@/lib/time";
import { fetchUsername, isApiConfigured, sendInstagramMessage } from "@/integrations/instagram/api";
import { createBrowserRunner } from "./browser-runner";
import { createWorker } from "./worker";

const e = env();
const config = businessConfig();
const d = db();
const workerId = `worker-${process.pid}`;

const worker = createWorker({
  d,
  config,
  workerId,
  clock: systemClock,
  baseUrl: e.INSTAGRAM_WEB_URL,
  sendEnabled: e.BROWSER_SEND_ENABLED,
  backupDir: e.BACKUP_DIR,
  browser: createBrowserRunner({ cdpUrl: e.CHROME_CDP_URL, baseUrl: e.INSTAGRAM_WEB_URL, artifactsDir: e.ARTIFACTS_DIR, encryptionKey: e.APP_ENCRYPTION_KEY, workerId, d }),
  probeBrowser: async () => {
    const res = await fetch(new URL("/json/version", e.CHROME_CDP_URL), { signal: AbortSignal.timeout(3_000) }).catch(() => null);
    return res?.ok ?? false;
  },
  api: {
    ownAccountId: e.INSTAGRAM_BUSINESS_ACCOUNT_ID,
    configured: isApiConfigured(),
    resolveUsername: fetchUsername,
    send: sendInstagramMessage,
  },
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("worker stopping", { signal });
    stopping = true;
  });
}

log.info("worker started", { workerId, sendEnabled: e.BROWSER_SEND_ENABLED });
while (!stopping) {
  try {
    const ran = await worker.tick();
    await new Promise((r) => setTimeout(r, ran > 0 ? 250 : 2_000));
  } catch (error) {
    log.error("worker tick failed", { error });
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
d.$client.close();
log.info("worker stopped");
