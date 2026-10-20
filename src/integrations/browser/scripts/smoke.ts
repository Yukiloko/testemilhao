/**
 * Level 3 test: sends ONE real DM. Only run after the operator explicitly authorises it, and
 * preferably to a second account the operator controls.
 *
 *   pnpm browser:smoke <handle> "<mensagem>" --confirm
 */
import readline from "node:readline/promises";
import "@/lib/load-env";
import { env } from "@/lib/env";
import { HUMAN_TIMING } from "@/worker/handlers/outreach";
import { disconnectBrowser, withAgentPage } from "../session";
import { sendDirectMessage } from "../instagram";

const [handleArg, text] = process.argv.slice(2);
const handle = handleArg?.replace(/^@/, "");
if (!handle || !text || !process.argv.includes("--confirm")) {
  console.error('Uso: pnpm browser:smoke <@perfil> "<mensagem>" --confirm');
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Isto vai ENVIAR de verdade para @${handle}:\n\n  ${text}\n\nDigite ENVIAR para confirmar: `);
rl.close();
if (answer.trim() !== "ENVIAR") {
  console.log("Cancelado.");
  process.exit(0);
}
const e = env();
const result = await withAgentPage(e.CHROME_CDP_URL, e.INSTAGRAM_WEB_URL, (page) => sendDirectMessage(page, e.INSTAGRAM_WEB_URL, handle, text, HUMAN_TIMING, false));
console.log("Resultado:", result.status);
await disconnectBrowser();
process.exit(0);
