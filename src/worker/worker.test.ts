import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { aiCalls, aiDecisions, exceptions, jobs, leads, messages } from "@/db/schema";
import { storeWebhookEvents } from "@/features/conversations/inbound";
import { isDoNotContact } from "@/features/leads/do-not-contact";
import { getSettings, updateSettings } from "@/features/safety/settings";
import { agentContext, disconnectBrowser } from "@/integrations/browser/session";
import type { InboundEvent } from "@/integrations/instagram/webhook";
import { DAY, HOUR, MINUTE } from "@/lib/time";
import { startChrome } from "@/test/chrome";
import { AFTERNOON, conversationOf, defaultModel, freshDb, makeLead, scriptModel, testConfig } from "@/test/helpers";
import { BASE, installMockInstagram, newMockState, type MockInstagram } from "@/test/mock-instagram";
import { createBrowserRunner } from "./browser-runner";
import { claimNext, enqueue, failJob, recoverExpiredLeases } from "./queue";
import { createWorker } from "./worker";

let chrome: Awaited<ReturnType<typeof startChrome>>;
let state: MockInstagram;
let d: Db;
let now: Date;
let sentViaApi: { igsid: string; text: string }[];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bm-worker-"));
const OWN_ID = "17840000000000000";

beforeAll(async () => {
  chrome = await startChrome();
  state = newMockState();
  await installMockInstagram(await agentContext(chrome.cdpUrl), state);
});
afterAll(async () => {
  await disconnectBrowser();
  await chrome.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  d = freshDb();
  now = new Date(AFTERNOON);
  sentViaApi = [];
  state.sent.length = 0;
  state.mode = "normal";
  state.profiles.set("modadaju", { handle: "modadaju", name: "Moda da Ju", bio: "Boutique de moda feminina em São Paulo", followers: 2345 });
  updateSettings({ discoveryEnabled: false }, d);
  scriptModel(defaultModel);
});

function worker(overrides: { sendEnabled?: boolean } = {}) {
  return createWorker({
    d,
    config: testConfig,
    clock: () => now,
    random: () => 0,
    baseUrl: BASE,
    sendEnabled: overrides.sendEnabled ?? true,
    backupDir: path.join(tmp, "backups"),
    probeBrowser: async () => true,
    workerId: "test-worker",
    browser: createBrowserRunner({ cdpUrl: chrome.cdpUrl, baseUrl: BASE, artifactsDir: path.join(tmp, "artifacts"), encryptionKey: process.env.APP_ENCRYPTION_KEY!, workerId: "test-worker", d }),
    api: {
      ownAccountId: OWN_ID,
      configured: true,
      resolveUsername: async (igsid) => ({ "igsid-ju": "modadaju" })[igsid] ?? null,
      send: async (igsid, text) => {
        sentViaApi.push({ igsid, text });
        return { messageId: `mid-out-${sentViaApi.length}` };
      },
    },
  });
}

async function drain(w: ReturnType<typeof worker>, ticks = 5) {
  for (let i = 0; i < ticks; i++) await w.tick();
}

function inbound(text: string, mid: string, at = now): InboundEvent {
  return { mid, senderId: "igsid-ju", recipientId: OWN_ID, text, timestamp: at, isEcho: false };
}

function deliver(event: InboundEvent) {
  for (const id of storeWebhookEvents([event], d)) enqueue("process_inbound", { webhookEventId: id }, { idempotencyKey: `inbound:${id}`, priority: 10 }, d);
}

async function contactJu(w: ReturnType<typeof worker>) {
  const lead = makeLead(d, "modadaju");
  await drain(w, 3);
  return lead;
}

describe("first contact through the real browser", () => {
  it("sends one DM, records it, and waits for the reply", async () => {
    const w = worker();
    const lead = await contactJu(w);
    expect(state.sent).toEqual([{ handle: "modadaju", text: defaultModel.draft().message }]);
    expect(conversationOf(d, lead.id)).toMatchObject({ channelState: "waiting_inbound_reply", channelOwner: "browser" });
    expect(d.select().from(leads).where(eq(leads.id, lead.id)).get()?.pipelineStatus).toBe("contacted");
    const out = d.select().from(messages).all();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: "browser", status: "sent", kind: "opening" });
    await drain(w, 3);
    expect(state.sent).toHaveLength(1);
  });

  it("does not send when real sends are not authorised", async () => {
    const w = worker({ sendEnabled: false });
    await contactJu(w);
    expect(state.sent).toEqual([]);
    expect(d.select().from(jobs).where(eq(jobs.type, "send_first_dm")).get()?.lastError).toMatch(/BROWSER_SEND_ENABLED/);
  });

  it("pauses everything when Instagram shows a restriction", async () => {
    state.mode = "restricted";
    const w = worker();
    await contactJu(w);
    expect(getSettings(d)).toMatchObject({ paused: true });
    expect(state.sent).toEqual([]);
  });
});

describe("handoff browser -> webhook -> official API", () => {
  it("moves ownership to the API, replies there, forwards to WhatsApp, and never double-sends", async () => {
    const w = worker();
    const lead = await contactJu(w);

    deliver(inbound("Oi! Quero saber mais, como funciona?", "mid-in-1"));
    deliver(inbound("Oi! Quero saber mais, como funciona?", "mid-in-1")); // Meta redelivery
    await drain(w, 2);
    expect(conversationOf(d, lead.id)).toMatchObject({ channelState: "api_eligible", channelOwner: "api", metaIgsid: "igsid-ju" });

    now = new Date(now.getTime() + MINUTE);
    await drain(w, 2);
    expect(sentViaApi).toHaveLength(1);
    expect(sentViaApi[0]!.igsid).toBe("igsid-ju");
    expect(sentViaApi[0]!.text).toContain("https://wa.me/5511999999999");
    expect(conversationOf(d, lead.id).channelState).toBe("api_active");
    expect(d.select().from(leads).where(eq(leads.id, lead.id)).get()?.pipelineStatus).toBe("whatsapp_handoff");
    expect(d.select().from(aiDecisions).all()).toMatchObject([{ intent: "interested", action: "send_whatsapp", outcome: "sent" }]);

    // The browser is locked out of this thread from now on, even when follow-ups come due.
    now = new Date(now.getTime() + 4 * DAY);
    await drain(w, 3);
    expect(state.sent).toHaveLength(1);
    expect(d.select().from(messages).where(eq(messages.direction, "inbound")).all()).toHaveLength(1);
  });

  it("honours an opt-out immediately and permanently", async () => {
    const w = worker();
    const lead = await contactJu(w);
    deliver(inbound("Por favor não me mande mais mensagens", "mid-in-2"));
    await drain(w, 2);
    now = new Date(now.getTime() + MINUTE);
    await drain(w, 2);
    expect(sentViaApi).toEqual([]);
    expect(isDoNotContact({ handle: "modadaju" }, d)).toBe(true);
    expect(conversationOf(d, lead.id).channelState).toBe("do_not_contact");
  });

  it("does not answer after the 24h window and never falls back to the browser", async () => {
    const w = worker();
    const lead = await contactJu(w);
    deliver(inbound("me conta mais", "mid-in-3"));
    await drain(w, 1);
    now = new Date(now.getTime() + 25 * HOUR);
    await drain(w, 3);
    expect(sentViaApi).toEqual([]);
    expect(state.sent).toHaveLength(1);
    expect(conversationOf(d, lead.id).channelState).toBe("api_window_closed");
    expect(d.select().from(exceptions).where(eq(exceptions.kind, "api_window_closed")).get()).toBeDefined();
  });

  it("escalates to a human when the reply would make an unverified claim", async () => {
    scriptModel({ ...defaultModel, decision: () => ({ action: "present", reply: "Temos a menor taxa do mercado para lojistas!", reasoning: "x" }) });
    const w = worker();
    const lead = await contactJu(w);
    deliver(inbound("qual a taxa?", "mid-in-4"));
    await drain(w, 1);
    now = new Date(now.getTime() + MINUTE);
    await drain(w, 2);
    expect(sentViaApi).toEqual([]);
    expect(conversationOf(d, lead.id).channelState).toBe("human_review_required");
  });
});

describe("follow-ups", () => {
  it("sends a follow-up through the browser when the lead stays silent", async () => {
    const w = worker();
    await contactJu(w);
    now = new Date(now.getTime() + 3 * DAY + MINUTE);
    await drain(w, 4);
    expect(state.sent).toHaveLength(2);
    expect(d.select().from(messages).where(eq(messages.kind, "followup")).get()).toMatchObject({ status: "sent", dedupeKey: expect.stringMatching(/^followup:/) });
  });
});

describe("budget and recovery", () => {
  it("pauses the system when the monthly OpenAI budget is reached", async () => {
    d.insert(aiCalls).values({ purpose: "seed", model: "x", costUsd: 6, ok: true, createdAt: now }).run();
    const w = worker();
    makeLead(d, "modadaju");
    await drain(w, 3);
    expect(getSettings(d)).toMatchObject({ paused: true });
    expect(state.sent).toEqual([]);
  });

  it("recovers jobs left running by a crashed worker", () => {
    enqueue("expire_windows", {}, { idempotencyKey: "x" }, d);
    const job = claimNext("crashed", null, now, 10 * MINUTE, d)!;
    expect(recoverExpiredLeases(new Date(now.getTime() + 5 * MINUTE), d)).toBe(0);
    expect(recoverExpiredLeases(new Date(now.getTime() + 11 * MINUTE), d)).toBe(1);
    expect(d.select().from(jobs).where(eq(jobs.id, job.id)).get()?.status).toBe("queued");
  });

  it("dead-letters a job after max attempts", () => {
    const job = enqueue("expire_windows", {}, { maxAttempts: 1 }, d)!;
    const claimed = claimNext("w", null, now, MINUTE, d)!;
    expect(claimed.id).toBe(job.id);
    expect(failJob(claimed, "boom", now, d)).toBe("dead");
  });

  it("escalates a send interrupted by a restart instead of sending again", async () => {
    const w = worker();
    const lead = makeLead(d, "modadaju");
    await w.tick(); // plan_outreach enqueues the send
    // Simulate a crash right after the reservation: channel marked sent, message pending.
    d.$client.prepare("update conversations set channel_state = 'browser_contact_sent', channel_owner = 'browser' where lead_id = ?").run(lead.id);
    d.$client.prepare("insert into messages (lead_id, direction, channel, kind, body, status, dedupe_key) values (?, 'outbound', 'browser', 'opening', 'x', 'pending', ?)").run(lead.id, `opening:${lead.id}`);
    await drain(w, 2);
    expect(state.sent).toEqual([]);
    expect(conversationOf(d, lead.id).channelState).toBe("human_review_required");
    expect(d.select().from(exceptions).where(and(eq(exceptions.kind, "delivery_unknown"), eq(exceptions.leadId, lead.id))).get()).toBeDefined();
  });
});
