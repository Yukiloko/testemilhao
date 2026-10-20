import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentContext, disconnectBrowser, withAgentPage } from "./session";
import { collectHashtagAuthors, parseCount, parseOgDescription, readProfile, sendDirectMessage } from "./instagram";
import { BrowserActionError, InstagramRestrictionError, SessionLostError } from "./errors";
import { startChrome } from "@/test/chrome";
import { BASE, installMockInstagram, newMockState, type MockInstagram } from "@/test/mock-instagram";

const FAST = { charDelayMs: [0, 1] as [number, number], pauseBeforeSendMs: [0, 1] as [number, number] };

describe("count parsing", () => {
  it("parses EN and PT-BR formats", () => {
    expect(parseCount("1,234")).toBe(1234);
    expect(parseCount("12,5 mil")).toBe(12500);
    expect(parseCount("1.2M")).toBe(1_200_000);
    expect(parseOgDescription("1,234 Followers, 56 Following, 78 Posts - See")).toEqual({ followers: 1234, following: 56, posts: 78 });
  });
});

describe("browser layer over real CDP", () => {
  let chrome: Awaited<ReturnType<typeof startChrome>>;
  let state: MockInstagram;

  beforeAll(async () => {
    chrome = await startChrome();
    state = newMockState();
    const ctx = await agentContext(chrome.cdpUrl);
    await installMockInstagram(ctx, state);
  });
  afterAll(async () => {
    await disconnectBrowser();
    await chrome.stop();
  });
  beforeEach(() => {
    state.sent.length = 0;
    state.mode = "normal";
    state.profiles.set("modadaju", { handle: "modadaju", name: "Moda da Ju", bio: "Boutique de moda feminina em São Paulo #moda", category: "Loja de roupas", followers: 2345, captions: ["Coleção nova chegando #boutique"] });
  });

  it("reads a public profile", async () => {
    const profile = await withAgentPage(chrome.cdpUrl, BASE, (page) => readProfile(page, BASE, "modadaju"));
    expect(profile).toMatchObject({ displayName: "Moda da Ju", followers: 2345, category: "Loja de roupas" });
    expect(profile.bio).toContain("moda feminina");
    expect(profile.signals.hashtags).toEqual(expect.arrayContaining(["#moda", "#boutique"]));
  });

  it("sends a DM in its own tab, closes it, and never touches the user's tab", async () => {
    const ctx = await agentContext(chrome.cdpUrl);
    const userTab = await ctx.newPage();
    await userTab.goto("about:blank#user-tab");
    const before = ctx.pages().length;

    const result = await withAgentPage(chrome.cdpUrl, BASE, (page) => sendDirectMessage(page, BASE, "modadaju", "Oi Ju! Linha 1\nLinha 2", FAST, false));

    expect(result).toEqual({ status: "sent" });
    expect(state.sent).toEqual([{ handle: "modadaju", text: "Oi Ju! Linha 1\nLinha 2" }]);
    expect(ctx.pages().length).toBe(before);
    expect(userTab.url()).toBe("about:blank#user-tab");
    await userTab.close();
  });

  it("dry-run does everything except pressing send", async () => {
    const result = await withAgentPage(chrome.cdpUrl, BASE, (page) => sendDirectMessage(page, BASE, "modadaju", "teste", FAST, true));
    expect(result).toEqual({ status: "dry_run" });
    expect(state.sent).toEqual([]);
  });

  it("detects restriction and lost session", async () => {
    state.mode = "restricted";
    await expect(withAgentPage(chrome.cdpUrl, BASE, (page) => readProfile(page, BASE, "modadaju"))).rejects.toBeInstanceOf(InstagramRestrictionError);
    state.mode = "logged_out";
    await expect(withAgentPage(chrome.cdpUrl, BASE, (page) => readProfile(page, BASE, "modadaju"))).rejects.toBeInstanceOf(SessionLostError);
  });

  it("reports unknown delivery when the sent message cannot be confirmed", async () => {
    state.mode = "no_confirmation";
    const error = await withAgentPage(chrome.cdpUrl, BASE, (page) => sendDirectMessage(page, BASE, "modadaju", "sem confirmação", FAST, false)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserActionError);
    expect((error as BrowserActionError).delivered).toBe("unknown");
    expect(state.sent).toHaveLength(1);
  });

  it("aborts navigation outside Instagram", async () => {
    const error = await withAgentPage(chrome.cdpUrl, BASE, (page) => page.goto("https://example.com/")).catch((e: unknown) => e);
    expect(String(error)).toMatch(/ERR_BLOCKED_BY_CLIENT/);
  });

  it("collects hashtag authors", async () => {
    state.hashtags.set("boutique", ["modadaju", "lojadaana", "modadaju"]);
    const authors = await withAgentPage(chrome.cdpUrl, BASE, (page) => collectHashtagAuthors(page, BASE, "#boutique"));
    expect(authors.sort()).toEqual(["lojadaana", "modadaju"]);
  });
});
