import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { leads } from "@/db/schema";
import { freshDb, makeLead, testConfig } from "@/test/helpers";
import { registerDiscoveredProfile } from "./discovery";
import { isDoNotContact, markDoNotContact } from "./do-not-contact";
import { normalizeHandle } from "./handle";
import { canTransition, InvalidTransitionError, transitionPipeline } from "./pipeline";
import { qualify } from "./qualification";

let d: Db;
beforeEach(() => {
  d = freshDb();
});

describe("lead dedupe", () => {
  it("normalizes handles from @, URLs and case", () => {
    expect(normalizeHandle("@Moda.Da_Ju")).toBe("moda.da_ju");
    expect(normalizeHandle("https://www.instagram.com/ModaDaJu/?hl=pt")).toBe("modadaju");
  });

  it("keeps a single lead per profile across sources and funnels", () => {
    const first = registerDiscoveredProfile({ handle: "@ModaDaJu", funnel: "customer", source: "hashtag", followers: 10 }, testConfig.instagramHandle, d);
    const again = registerDiscoveredProfile({ handle: "modadaju", funnel: "affiliate", source: "related", followers: 20 }, testConfig.instagramHandle, d);
    expect(first.outcome).toBe("created");
    expect(again.outcome).toBe("updated");
    const rows = d.select().from(leads).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ funnel: "customer", followers: 20, pipelineStatus: "discovered" });
  });

  it("never registers our own account or do-not-contact profiles", () => {
    expect(registerDiscoveredProfile({ handle: "pagafacil", funnel: "customer", source: "hashtag" }, testConfig.instagramHandle, d)).toEqual({ outcome: "skipped", reason: "own_account" });
    const lead = makeLead(d, "chato");
    markDoNotContact(lead.id, "asked to stop", "ai", d);
    d.delete(leads).where(eq(leads.id, lead.id)).run();
    expect(registerDiscoveredProfile({ handle: "chato", funnel: "affiliate", source: "related" }, testConfig.instagramHandle, d)).toEqual({ outcome: "skipped", reason: "do_not_contact" });
  });
});

describe("pipeline transitions", () => {
  it("only moves forward, may skip stages, and closed is final", () => {
    expect(canTransition("customer", "contacted", "whatsapp_handoff")).toBe(true);
    expect(canTransition("customer", "interested", "replied")).toBe(false);
    expect(canTransition("customer", "replied", "joined_affiliate_group")).toBe(false);
    expect(canTransition("affiliate", "interested", "joined_affiliate_group")).toBe(true);
    expect(canTransition("customer", "closed", "qualified")).toBe(false);
  });

  it("is atomic and audited", () => {
    const lead = makeLead(d, "loja1", "customer", "discovered");
    transitionPipeline(lead.id, "qualified", { actor: "system", reason: "score" }, d);
    expect(() => transitionPipeline(lead.id, "discovered", { actor: "system", reason: "x" }, d)).toThrow(InvalidTransitionError);
    expect(d.select().from(leads).where(eq(leads.id, lead.id)).get()?.pipelineStatus).toBe("qualified");
  });
});

describe("do not contact", () => {
  it("is permanent, global and closes the lead and the channel", () => {
    const lead = makeLead(d, "naoquero", "customer", "contacted");
    markDoNotContact(lead.id, "pediu para parar", "ai", d);
    expect(isDoNotContact({ handle: "NaoQuero" }, d)).toBe(true);
    const updated = d.select().from(leads).where(eq(leads.id, lead.id)).get();
    expect(updated?.pipelineStatus).toBe("closed");
  });
});

describe("qualification", () => {
  it("scores ICP fit with explicit reasons and detects role", () => {
    const lead = makeLead(d, "boutique", "customer", "discovered");
    const q = qualify({ ...lead, bio: "Boutique de moda feminina em São Paulo. Fundadora @ana", signals: { isBusiness: true } }, testConfig);
    expect(q.score).toBeGreaterThanOrEqual(70);
    expect(q.role).toBe("owner");
    expect(q.niche).toBe("moda feminina");
    expect(q.reasons.join(" ")).toContain("keywords");
  });

  it("scores affiliates by topic, language and engagement", () => {
    const lead = makeLead(d, "criadora", "affiliate", "discovered");
    const q = qualify({ ...lead, bio: "Dicas de finanças e empreendedorismo para você. Link na bio", followers: 30_000, postsCount: 200, signals: { engagementRate: 0.04 } }, testConfig);
    expect(q.score).toBeGreaterThanOrEqual(80);
    expect(q.role).toBe("creator");
  });
});
