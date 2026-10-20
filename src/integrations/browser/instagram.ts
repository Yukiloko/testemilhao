import type { Page } from "playwright-core";
import type { ProfileSignals } from "@/db/schema";
import { BrowserActionError, InstagramRestrictionError, ProfileNotFoundError, SessionLostError } from "./errors";

/**
 * Instagram UI actions, written against accessible roles and names (EN + PT-BR) rather than
 * CSS classes, which Instagram regenerates on every deploy.
 */

const RESTRICTION = /(try again later|tente novamente mais tarde|we restrict certain activity|restringimos determinadas atividades|action blocked|a[cç][aã]o bloqueada|your account has been (temporarily )?(locked|restricted)|sua conta foi (temporariamente )?(bloqueada|restrita))/i;
const NOT_FOUND = /(sorry, this page isn't available|esta p[aá]gina n[aã]o est[aá] dispon[ií]vel|this page isn.t available)/i;
const MESSAGE_BUTTON = /^(message|mensagem|enviar mensagem)$/i;
const MESSAGE_BOX = /^(message|mensagem|message\.\.\.|mensagem\.\.\.)$/i;
const NOT_NOW = /^(not now|agora n[aã]o)$/i;

export type ProfileData = {
  handle: string;
  displayName: string | null;
  bio: string | null;
  category: string | null;
  externalUrl: string | null;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  signals: ProfileSignals;
};

export type HumanTiming = { charDelayMs: [number, number]; pauseBeforeSendMs: [number, number]; random?: () => number };
const between = ([min, max]: [number, number], random: () => number) => min + Math.floor(random() * (max - min + 1));

/** Throws the specific error for login wall, restriction or missing profile. */
export async function assertPageHealthy(page: Page): Promise<void> {
  if (/\/accounts\/login|\/challenge\//.test(page.url())) throw new SessionLostError(`redirected to ${page.url()}`);
  if (await page.locator("input[name='password']").count().catch(() => 0)) throw new SessionLostError(`login form at ${page.url()}`);
  const text = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (RESTRICTION.test(text)) throw new InstagramRestrictionError(text.match(RESTRICTION)?.[0] ?? "restriction");
  if (NOT_FOUND.test(text)) throw new ProfileNotFoundError(page.url());
}

async function dismissNotNow(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: NOT_NOW });
  if (await button.first().isVisible().catch(() => false)) await button.first().click();
}

/** "1,234", "1.234", "12,5 mil", "1.2M", "3 mi" -> number */
export function parseCount(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^([\d.,]+)\s*(mil|milh[oõ]es|mi|k|m)?\b/);
  if (!m?.[1]) return null;
  const suffix = m[2];
  if (!suffix) return Number(m[1].replace(/[.,]/g, ""));
  const value = Number(m[1].replace(",", "."));
  const mult = suffix === "k" || suffix === "mil" ? 1_000 : 1_000_000;
  return Math.round(value * mult);
}

/** og:description: "1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Name (@handle)" */
export function parseOgDescription(content: string): { followers: number | null; following: number | null; posts: number | null } {
  const grab = (re: RegExp) => {
    const m = content.match(re);
    return m?.[1] ? parseCount(m[1]) : null;
  };
  return {
    followers: grab(/([\d.,]+\s*(?:k|m|mil|mi)?)\s+(?:followers|seguidores)/i),
    following: grab(/([\d.,]+\s*(?:k|m|mil|mi)?)\s+(?:following|seguindo)/i),
    posts: grab(/([\d.,]+\s*(?:k|m|mil|mi)?)\s+(?:posts|publica[cç][oõ]es)/i),
  };
}

export async function gotoProfile(page: Page, baseUrl: string, handle: string): Promise<void> {
  await page.goto(`${baseUrl}/${encodeURIComponent(handle)}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await assertPageHealthy(page);
  await dismissNotNow(page);
}

/** Reads only public profile information. */
export async function readProfile(page: Page, baseUrl: string, handle: string): Promise<ProfileData> {
  await gotoProfile(page, baseUrl, handle);
  const meta = async (prop: string) => page.locator(`meta[property="${prop}"]`).first().getAttribute("content", { timeout: 2_000 }).catch(() => null);
  const og = (await meta("og:description")) ?? "";
  const counts = parseOgDescription(og);
  const title = (await meta("og:title")) ?? "";
  const displayName = title.match(/^(.*?)\s*\(@/)?.[1]?.trim() || null;
  const header = page.locator("header").first();
  const bio = (await header.locator("[data-testid='bio'], h1 + span, section > div > span").first().innerText({ timeout: 2_000 }).catch(() => null))?.trim() || null;
  const category = (await header.locator("[data-testid='category']").first().innerText({ timeout: 1_000 }).catch(() => null))?.trim() || null;
  const externalUrl = await header.getByRole("link").filter({ hasNotText: /seguidores|followers|seguindo|following/i }).locator("xpath=self::a[starts-with(@href,'http')]").first().getAttribute("href", { timeout: 1_000 }).catch(() => null);
  const captions = await page.locator("article img[alt], main img[alt]").evaluateAll((imgs) => imgs.slice(0, 6).map((i) => i.getAttribute("alt") ?? "").filter(Boolean));
  const hashtags = Array.from(new Set([bio ?? "", ...captions].join(" ").match(/#[\p{L}\p{N}_]+/gu) ?? [])).slice(0, 20);
  const isPrivate = /(this account is private|esta conta [eé] privada)/i.test(await page.locator("main").innerText({ timeout: 2_000 }).catch(() => ""));
  return {
    handle,
    displayName,
    bio,
    category,
    externalUrl,
    followers: counts.followers,
    following: counts.following,
    postsCount: counts.posts,
    signals: { recentCaptions: captions, hashtags, isPrivate, isBusiness: category !== null },
  };
}

/** Collects authors of recent public posts under a hashtag. */
export async function collectHashtagAuthors(page: Page, baseUrl: string, tag: string, limit = 12): Promise<string[]> {
  await page.goto(`${baseUrl}/explore/tags/${encodeURIComponent(tag.replace(/^#/, ""))}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await assertPageHealthy(page);
  const postLinks = await page.locator("a[href*='/p/'], a[href*='/reel/']").evaluateAll((as, max) =>
    Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""))).filter(Boolean).slice(0, max as number), limit);
  const authors = new Set<string>();
  for (const href of postLinks) {
    await page.goto(new URL(href, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await assertPageHealthy(page);
    const author = await page.locator("header a[href^='/']").first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
    const handle = author?.split("/").filter(Boolean)[0];
    if (handle && !["explore", "p", "reel", "accounts"].includes(handle)) authors.add(handle);
  }
  return [...authors];
}

export type SendOutcome = { status: "sent" } | { status: "dry_run" };

/**
 * Opens the DM from the profile and types like a person. Everything before pressing Enter is
 * reversible (`delivered: "no"`); after Enter, a failed confirmation is `delivered: "unknown"`.
 * `dryRun` does everything except the final Enter.
 */
export async function sendDirectMessage(page: Page, baseUrl: string, handle: string, text: string, timing: HumanTiming, dryRun: boolean): Promise<SendOutcome> {
  const random = timing.random ?? Math.random;
  try {
    await gotoProfile(page, baseUrl, handle);
    const button = page.getByRole("button", { name: MESSAGE_BUTTON }).or(page.getByRole("link", { name: MESSAGE_BUTTON }));
    await button.first().click({ timeout: 15_000 });
    await dismissNotNow(page);
    const box = page.getByRole("textbox", { name: MESSAGE_BOX });
    await box.first().waitFor({ state: "visible", timeout: 15_000 });
    await assertPageHealthy(page);
    await box.first().click();
    for (const char of text) {
      if (char === "\n") await page.keyboard.press("Shift+Enter");
      else await page.keyboard.type(char);
      await page.waitForTimeout(between(timing.charDelayMs, random));
    }
    await page.waitForTimeout(between(timing.pauseBeforeSendMs, random));
  } catch (error) {
    if (error instanceof SessionLostError || error instanceof InstagramRestrictionError || error instanceof ProfileNotFoundError) throw error;
    throw new BrowserActionError(`before send: ${error instanceof Error ? error.message : String(error)}`, "no");
  }
  if (dryRun) return { status: "dry_run" };

  await page.keyboard.press("Enter");
  try {
    const tail = text.split("\n").pop()!.slice(-40);
    await page.getByText(tail, { exact: false }).last().waitFor({ state: "visible", timeout: 15_000 });
    await assertPageHealthy(page);
  } catch (error) {
    // Enter was pressed: whatever went wrong, the message may have been delivered.
    throw new BrowserActionError(`after send: ${error instanceof Error ? error.message : String(error)}`, "unknown", error);
  }
  return { status: "sent" };
}
