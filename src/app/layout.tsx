import type { Metadata } from "next";
import { sql, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { alerts, exceptions } from "@/db/schema";
import { getSettings } from "@/features/safety/settings";
import { businessConfig, businessConfigExists } from "@/lib/business-config";
import { pauseAction, resumeAction } from "./actions";
import { Nav } from "./components/nav";
import "./globals.css";

export const metadata: Metadata = { title: "Prospecção autônoma", description: "CRM e painel do agente de prospecção no Instagram" };
export const dynamic = "force-dynamic";

function SetupNeeded({ error }: { error: string }) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Configuração necessária</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Copie <code>config/business.example.json</code> para <code>config/business.json</code> e preencha os dados do seu negócio. Veja o <code>SETUP.md</code>.
      </p>
      <pre className="card mt-4 overflow-auto text-xs whitespace-pre-wrap">{error}</pre>
    </main>
  );
}

function loadShell() {
  try {
    if (!businessConfigExists()) throw new Error("config/business.json não encontrado.");
    const config = businessConfig();
    const d = db();
    return {
      ok: true as const,
      config,
      settings: getSettings(d),
      openExceptions: d.select({ n: sql<number>`count(*)` }).from(exceptions).where(eq(exceptions.status, "open")).get()?.n ?? 0,
      openAlerts: d.select({ n: sql<number>`count(*)` }).from(alerts).where(isNull(alerts.resolvedAt)).get()?.n ?? 0,
      sendEnabled: process.env.BROWSER_SEND_ENABLED === "true",
    };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const shell = loadShell();
  if (!shell.ok) {
    return (
      <html lang="pt-BR">
        <body><SetupNeeded error={shell.error} /></body>
      </html>
    );
  }
  const { config, settings: s, sendEnabled } = shell;
  return (
    <html lang="pt-BR">
      <body>
        <div className="flex min-h-screen">
          <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-zinc-200 p-4 md:flex dark:border-zinc-800">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{config.companyName}</div>
              <div className="text-sm font-medium">Prospecção autônoma</div>
            </div>
            <Nav counts={{ "/excecoes": shell.openExceptions, "/alertas": shell.openAlerts }} />
            <div className="mt-auto flex flex-col gap-1 text-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Atalhos</span>
              <a className="hover:underline" href={`https://www.instagram.com/${config.instagramHandle.replace(/^@/, "")}/`} target="_blank" rel="noreferrer">Instagram ↗</a>
              <a className="hover:underline" href={config.whatsappLink} target="_blank" rel="noreferrer">WhatsApp comercial ↗</a>
              <a className="hover:underline" href={config.affiliateGroupLink} target="_blank" rel="noreferrer">Grupo de afiliados ↗</a>
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-6 py-3 text-sm dark:border-zinc-800" role="status">
              <details className="md:hidden">
                <summary className="btn">Menu</summary>
                <div className="absolute z-10 mt-2 w-64 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  <Nav counts={{ "/excecoes": shell.openExceptions, "/alertas": shell.openAlerts }} />
                </div>
              </details>
              {s.paused ? (
                <span className="font-semibold text-bad">⏸ Sistema pausado{s.pauseReason ? `: ${s.pauseReason}` : ""}</span>
              ) : (
                <span className="font-semibold text-ok">● Operando</span>
              )}
              {!s.browserAvailable && <span className="text-bad">Chrome indisponível</span>}
              {!sendEnabled && <span className="text-warn">Envio real desativado (BROWSER_SEND_ENABLED=false)</span>}
              <div className="ml-auto">
                {s.paused ? (
                  <form action={resumeAction}>
                    <button className="btn btn-primary" type="submit">Retomar operação</button>
                  </form>
                ) : (
                  <form action={pauseAction}>
                    <button className="btn btn-danger" type="submit">Pausa geral</button>
                  </form>
                )}
              </div>
            </header>
            <main className="flex-1 p-6">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
