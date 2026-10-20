const TZ = process.env.OPERATING_TIMEZONE ?? "America/Sao_Paulo";

export const formatDateTime = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: TZ }).format(d) : "—";

export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined ? "—" : new Intl.NumberFormat("pt-BR").format(n));

export const formatPercent = (part: number, total: number) =>
  total === 0 ? "—" : new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 }).format(part / total);

export const formatUsd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n);

export const formatBrl = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
