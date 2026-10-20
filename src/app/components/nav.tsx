"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Painel" },
  { href: "/leads", label: "Leads (Kanban)" },
  { href: "/leads/importar", label: "Importar leads" },
  { href: "/excecoes", label: "Exceções" },
  { href: "/alertas", label: "Alertas" },
  { href: "/fila", label: "Fila de jobs" },
  { href: "/experimentos", label: "Experimentos" },
  { href: "/metricas", label: "Métricas e custos" },
  { href: "/decisoes", label: "Decisões da IA" },
  { href: "/configuracoes", label: "Configurações" },
];

export function Nav({ counts }: { counts: Record<string, number> }) {
  const path = usePathname();
  return (
    <nav aria-label="Navegação principal" className="flex flex-col gap-0.5">
      {ITEMS.map((item) => {
        const active = item.href === "/" ? path === "/" : path === item.href || (path.startsWith(item.href + "/") && item.href !== "/leads") || (item.href === "/leads" && /^\/leads(\/\d+)?$/.test(path));
        const count = counts[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"}`}
          >
            {item.label}
            {count ? <span className="rounded-full bg-brand px-1.5 text-xs font-semibold text-white" aria-label={`${count} pendentes`}>{count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
