/**
 * End-to-end run of the real system: production Next.js server + worker as separate processes,
 * a real headless Chromium over CDP, and local stand-ins for Instagram web, the Meta Graph API
 * and the OpenAI Responses API. Exercises: import -> profile read -> qualification -> first DM
 * in the browser -> worker crash -> signed webhook -> restart recovery -> AI reply via the
 * official API -> WhatsApp handoff -> panel pages in PT-BR (with screenshots).
 *
 * Run `pnpm build` first. Usage: pnpm e2e
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client";
import { aiCalls, conversations, leads, messages } from "../src/db/schema";
import { startChrome } from "../src/test/chrome";
import { newMockState, renderMock } from "../src/test/mock-instagram";

const root = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "bm-e2e-"));
const evidence = path.resolve(process.env.E2E_OUTPUT_DIR ?? path.join(root, "artifacts/e2e"));
fs.mkdirSync(evidence, { recursive: true });
const children: ChildProcess[] = [];
const cleanups: (() => Promise<void>)[] = [];
const servers: http.Server[] = [];
const log = (msg: string) => console.log(`[e2e] ${msg}`);

function listen(handler: http.RequestListener): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}` });
    });
  });
}

const body = (req: http.IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 90_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  log(`✓ ${msg}`);
}

async function main() {
  // --- Instagram web stand-in -------------------------------------------------
  const ig = newMockState();
  ig.profiles.set("boutiquedalu", { handle: "boutiquedalu", name: "Boutique da Lu", bio: "Loja de moda feminina em São Paulo. Fundadora: Lu. #moda #boutique", category: "Loja de roupas", followers: 4_820, captions: ["Coleção de inverno chegando na loja #moda"] });
  const igServer = await listen(async (req, res) => {
    const r = renderMock(new URL(req.url ?? "/", "http://x").pathname, ig, req.method === "POST" ? await body(req) : undefined);
    res.writeHead(r.status, { "Content-Type": "text/html; charset=utf-8" }).end(r.html);
  });

  // --- Meta Graph API stand-in --------------------------------------------------
  const graphSent: { recipient: string; text: string }[] = [];
  const graph = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && url.pathname.endsWith("/me/messages")) {
      const b = JSON.parse(await body(req)) as { recipient: { id: string }; message: { text: string } };
      graphSent.push({ recipient: b.recipient.id, text: b.message.text });
      return res.end(JSON.stringify({ recipient_id: b.recipient.id, message_id: `mid.api.${graphSent.length}` }));
    }
    if (req.method === "GET" && url.pathname.endsWith("/igsid-lu")) return res.end(JSON.stringify({ id: "igsid-lu", username: "boutiquedalu" }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "unknown", code: 100 } }));
  });

  // --- OpenAI Responses API stand-in ------------------------------------------------
  const openaiCalls: string[] = [];
  const replies: Record<string, unknown> = {
    draft: { message: "Oi, Lu! Vi a coleção de inverno chegando na loja, ficou linda. Hoje vocês vendem mais pelo direct ou no balcão?", personalHook: "coleção de inverno" },
    claim_review: { unsupportedClaims: [] },
    intent: { intent: "interested", confidence: 0.92, summary: "quer entender como funciona" },
    decision: { action: "send_whatsapp", reply: "Que bom, Lu! Sem mensalidade, e quem te explica tudo é a Ana, nossa fundadora. Chama ela aqui:", reasoning: "interesse claro, encaminhar" },
  };
  const openai = await listen(async (req, res) => {
    const b = JSON.parse(await body(req)) as { model: string; text: { format: { name: string } } };
    const name = b.text.format.name;
    openaiCalls.push(name);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: `resp_${openaiCalls.length}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: b.model,
      output: [{ type: "message", id: `msg_${openaiCalls.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(replies[name] ?? {}), annotations: [] }] }],
      usage: { input_tokens: 900, output_tokens: 150, total_tokens: 1050 },
    }));
  });

  const chrome = await startChrome();
  cleanups.push(chrome.stop);
  log(`chromium CDP at ${chrome.cdpUrl}`);

  const configPath = path.join(work, "business.json");
  fs.writeFileSync(configPath, JSON.stringify({
    ownerName: "Ana", ownerRole: "Fundadora", companyName: "PagaFácil", companyWebsite: "https://pagafacil.example", instagramHandle: "@pagafacil",
    whatsappLink: "https://wa.me/5511999999999", affiliateGroupLink: "https://chat.whatsapp.com/AFILIADOS", oneLinePitch: "Pagamentos simples para lojas pequenas",
    howItWorks: ["Cadastro", "Análise", "Venda"], revenueModel: "Taxa por transação", marketJargon: [{ term: "MDR", meaning: "taxa por transação" }],
    verifiedClaims: ["Sem mensalidade"], unverifiedClaims: ["Menor taxa do mercado"], icpSegments: ["moda feminina"], icpKeywords: ["loja", "moda", "boutique"],
    affiliateTopics: ["empreendedorismo"], geography: "São Paulo",
  }));

  const appSecret = "e2e-app-secret";
  const port = 3400 + Math.floor(Math.random() * 400);
  const dbFile = path.join(work, "app.db");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    BUSINESS_CONFIG_PATH: configPath,
    OPENAI_API_KEY: "sk-e2e-not-a-real-key",
    OPENAI_BASE_URL: `${openai.url}/v1`,
    OPENAI_MODEL: "gpt-e2e-main-2025-01-01",
    OPENAI_MODEL_FAST: "gpt-e2e-fast-2025-01-01",
    OPENAI_MONTHLY_BUDGET_USD: "10",
    OPENAI_MODEL_INPUT_USD_PER_1M: "1.25",
    OPENAI_MODEL_OUTPUT_USD_PER_1M: "10",
    OPENAI_MODEL_FAST_INPUT_USD_PER_1M: "0.25",
    OPENAI_MODEL_FAST_OUTPUT_USD_PER_1M: "2",
    CHROME_CDP_URL: chrome.cdpUrl,
    CHROME_PROFILE_DIR: path.join(work, "profile"),
    INSTAGRAM_WEB_URL: igServer.url,
    INSTAGRAM_APP_SECRET: appSecret,
    INSTAGRAM_PAGE_ACCESS_TOKEN: "EAAe2etoken",
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: "e2e-verify",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "17841400000000001",
    INSTAGRAM_GRAPH_API_URL: graph.url,
    DATABASE_URL: dbFile,
    BACKUP_DIR: path.join(work, "backups"),
    ARTIFACTS_DIR: path.join(work, "artifacts"),
    APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    MAX_DMS_PER_DAY: "30",
    MIN_SECONDS_BETWEEN_DMS: "90",
    MAX_SECONDS_BETWEEN_DMS: "240",
    OPERATING_HOURS: "00:00-23:59",
    OPERATING_TIMEZONE: "America/Sao_Paulo",
    BROWSER_SEND_ENABLED: "true",
    LOG_SILENT: "true",
  };
  const startWorker = () => {
    // Run node directly (not the tsx wrapper) so killing this PID really kills the worker.
    const w = spawn(process.execPath, ["--import", "tsx", "--conditions=react-server", "src/worker/main.ts"], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
    children.push(w);
    return w;
  };
  const web = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });
  children.push(web);
  let worker = startWorker();
  const app = `http://127.0.0.1:${port}`;
  await waitFor("panel up", () => fs.existsSync(dbFile) && true, 30_000);
  await (async () => { for (let i = 0; i < 60; i++) { if (await fetch(app).then((r) => r.ok).catch(() => false)) return; await new Promise((r) => setTimeout(r, 500)); } throw new Error("panel did not start"); })();
  log(`panel at ${app}`);

  const d = openDatabase(dbFile);
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true }).catch(() => chromium.connectOverCDP(chrome.cdpUrl));
  const ui = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 1. Operator imports a lead through the panel.
  await ui.goto(`${app}/leads/importar`);
  await ui.getByLabel("Perfis").fill("@BoutiqueDaLu\nhttps://www.instagram.com/boutiquedalu/");
  await ui.getByRole("button", { name: "Importar" }).click();
  await ui.getByRole("status").filter({ hasText: "novos" }).waitFor();
  assert((await ui.getByRole("status").filter({ hasText: "novos" }).innerText()).includes("1 novos, 1 já existiam"), "import dedupes the same profile given twice");

  // 2. Worker reads the profile, qualifies, sends the first DM through Chrome.
  await waitFor("first DM in the browser", () => ig.sent.length === 1);
  assert(ig.sent[0]!.text === (replies.draft as { message: string }).message, "first DM typed and sent in the real browser");
  const lead = await waitFor("lead contacted", () => {
    const l = d.select().from(leads).where(eq(leads.handle, "boutiquedalu")).get();
    return l?.pipelineStatus === "contacted" ? l : undefined;
  });
  assert((lead.score ?? 0) >= 55 && lead.role === "owner", `lead qualified (score ${lead.score}, role ${lead.role})`);
  assert(d.select().from(conversations).where(eq(conversations.leadId, lead.id)).get()?.channelState === "waiting_inbound_reply", "channel waiting_inbound_reply after browser send");

  // 3. Worker crashes. The lead replies meanwhile; the webhook is still accepted by the panel.
  worker.kill("SIGKILL");
  await new Promise<void>((r) => worker.once("exit", () => r()));
  log("worker killed with SIGKILL (simulated crash)");
  const verify = await fetch(`${app}/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=e2e-verify&hub.challenge=abc123`);
  assert((await verify.text()) === "abc123", "webhook GET verification handshake");
  const payload = JSON.stringify({ object: "instagram", entry: [{ id: "17841400000000001", time: Date.now(), messaging: [{ sender: { id: "igsid-lu" }, recipient: { id: "17841400000000001" }, timestamp: Date.now(), message: { mid: "mid.in.1", text: "Oi! Quero saber como funciona" } }] }] });
  const sign = (p: string) => `sha256=${crypto.createHmac("sha256", appSecret).update(p).digest("hex")}`;
  const bad = await fetch(`${app}/api/webhooks/instagram`, { method: "POST", body: payload, headers: { "x-hub-signature-256": "sha256=deadbeef" } });
  assert(bad.status === 401, "unsigned webhook rejected");
  for (let i = 0; i < 2; i++) {
    const ok = await fetch(`${app}/api/webhooks/instagram`, { method: "POST", body: payload, headers: { "x-hub-signature-256": sign(payload) } });
    assert(ok.status === 200, `signed webhook accepted (delivery ${i + 1})`);
  }

  // 4. Worker restarts, recovers the queue, hands the thread to the API and replies.
  worker = startWorker();
  log("worker restarted");
  await waitFor("API reply", () => graphSent.length >= 1, 120_000);
  await new Promise((r) => setTimeout(r, 3_000));
  assert(graphSent.length === 1, "exactly one reply through the official API despite duplicate webhook");
  assert(graphSent[0]!.recipient === "igsid-lu" && graphSent[0]!.text.includes("https://wa.me/5511999999999"), "reply addressed by IGSID and forwards to WhatsApp");
  assert(ig.sent.length === 1, "browser did not write to the thread after handoff");
  const conv = d.select().from(conversations).where(eq(conversations.leadId, lead.id)).get()!;
  assert(conv.channelState === "api_active" && conv.channelOwner === "api", "channel owned by the API");
  assert(d.select().from(leads).where(eq(leads.id, lead.id)).get()?.pipelineStatus === "whatsapp_handoff", "pipeline at whatsapp_handoff");
  assert(d.select().from(messages).where(eq(messages.leadId, lead.id)).all().length === 3, "CRM history: 1 browser DM + 1 inbound + 1 API reply");
  const calls = d.select().from(aiCalls).all();
  assert(calls.length > 0 && calls.every((c) => c.costUsd > 0), `${calls.length} AI calls recorded with tokens and cost`);

  // 5. Panel pages render in PT-BR.
  const pages: [string, string][] = [["/", "Painel geral"], ["/leads", "Kanban — Clientes"], [`/leads/${lead.id}`, "Conversa"], ["/decisoes", "Log de decisões da IA"], ["/metricas", "Métricas — Clientes"], ["/fila", "Fila de jobs"], ["/experimentos", "Experimentos"], ["/configuracoes", "Configurações e limites"], ["/excecoes", "Fila de exceções"], ["/alertas", "Alertas de integração"]];
  for (const [route, heading] of pages) {
    await ui.goto(`${app}${route}`);
    await ui.getByRole("heading", { name: heading }).first().waitFor();
    assert((await ui.locator("html").getAttribute("lang")) === "pt-BR", `${route} renders "${heading}" (pt-BR)`);
    await ui.screenshot({ path: path.join(evidence, `${route === "/" ? "painel" : route.slice(1).replace(/\//g, "-")}.png`), fullPage: true });
  }

  // 6. Global pause from the panel stops the worker from acting.
  await ui.goto(app);
  await ui.getByRole("button", { name: "Pausa geral" }).click();
  await ui.getByText("Sistema pausado").first().waitFor();
  assert(true, "global pause button works");

  await browser.close();
  log(`evidence screenshots: ${evidence}`);
}

main()
  .then(() => log("END-TO-END PASSED"))
  .catch((error) => {
    console.error("[e2e] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const c of children) c.kill("SIGKILL");
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
    for (const s of servers) s.close();
    fs.rmSync(work, { recursive: true, force: true });
    setTimeout(() => process.exit(), 500);
  });
