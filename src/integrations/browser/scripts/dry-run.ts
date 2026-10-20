/**
 * Level 2 test on the operator's machine: real Chrome, real Instagram session, final send blocked.
 * Reads a profile and types a message into the DM box, then erases it without pressing Enter.
 *
 *   pnpm browser:dry-run <handle-you-control>
 */
import "@/lib/load-env";
import { env } from "@/lib/env";
import { HUMAN_TIMING } from "@/worker/handlers/outreach";
import { disconnectBrowser, withAgentPage } from "../session";
import { readProfile, sendDirectMessage } from "../instagram";

const handle = process.argv[2]?.replace(/^@/, "");
if (!handle) {
  console.error("Uso: pnpm browser:dry-run <@perfil>");
  process.exit(1);
}
const e = env();
const result = await withAgentPage(e.CHROME_CDP_URL, e.INSTAGRAM_WEB_URL, async (page) => {
  const profile = await readProfile(page, e.INSTAGRAM_WEB_URL, handle);
  console.log("Perfil lido:", JSON.stringify(profile, null, 2));
  return sendDirectMessage(page, e.INSTAGRAM_WEB_URL, handle, "Teste de dry-run — esta mensagem NÃO será enviada.", HUMAN_TIMING, true);
});
console.log("Resultado:", result.status === "dry_run" ? "OK — digitou e apagou sem enviar." : result.status);
await disconnectBrowser();
process.exit(0);
