import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { log } from "@/lib/logger";
import { BrowserUnavailableError } from "./errors";

export type PageDiagnostics = { consoleErrors: string[]; networkFailures: string[] };

let browser: Browser | undefined;

/** One CDP connection per worker process, re-established when Chrome restarts. Never closes Chrome. */
export async function agentContext(cdpUrl: string): Promise<BrowserContext> {
  if (!browser?.isConnected()) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
    } catch (error) {
      browser = undefined;
      throw new BrowserUnavailableError(`connectOverCDP(${cdpUrl}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const context = browser.contexts()[0];
  if (!context) throw new BrowserUnavailableError("Chrome has no default context (is the dedicated profile open?)");
  return context;
}

export function allowedHost(url: string, allowedOrigin: string): boolean {
  try {
    const host = new URL(url).hostname;
    const allowed = new URL(allowedOrigin).hostname.replace(/^www\./, "");
    return host === allowed || host.endsWith(`.${allowed}`) || host.endsWith(".cdninstagram.com") || host.endsWith(".fbcdn.net");
  } catch {
    return url.startsWith("about:") || url.startsWith("data:");
  }
}

/**
 * Runs `fn` in a brand-new tab owned by the agent: the user's tabs are never adopted, the tab is
 * never focused, navigation outside Instagram is aborted, and the tab is closed even on error.
 */
export async function withAgentPage<T>(
  cdpUrl: string,
  allowedOrigin: string,
  fn: (page: Page, diagnostics: PageDiagnostics) => Promise<T>,
): Promise<T> {
  const context = await agentContext(cdpUrl);
  const page = await context.newPage();
  const diagnostics: PageDiagnostics = { consoleErrors: [], networkFailures: [] };
  page.on("console", (m) => {
    if (m.type() === "error") diagnostics.consoleErrors.push(m.text().slice(0, 500));
  });
  page.on("requestfailed", (r) => diagnostics.networkFailures.push(`${r.method()} ${r.url().slice(0, 200)} ${r.failure()?.errorText ?? ""}`));
  await page.route("**/*", (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && !allowedHost(request.url(), allowedOrigin)) {
      log.warn("blocked navigation outside instagram", { url: request.url() });
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });
  try {
    return await fn(page, diagnostics);
  } finally {
    await page.close({ runBeforeUnload: false }).catch((error: unknown) => log.warn("agent tab close failed", { error }));
  }
}

/** Test hook: drop the cached connection. */
export async function disconnectBrowser(): Promise<void> {
  browser = undefined;
}
