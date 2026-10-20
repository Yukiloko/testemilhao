export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Minutes since local midnight in the given IANA timezone. */
export function localMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function localHour(date: Date, timeZone: string): number {
  return Math.floor(localMinutes(date, timeZone) / 60);
}

/** YYYY-MM-DD of the date in the given timezone; used to bucket daily send quotas. */
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function parseWindow(window: string): { start: number; end: number } {
  const [start = "00:00", end = "23:59"] = window.split("-");
  const toMin = (v: string) => {
    const [h = "0", m = "0"] = v.split(":");
    return Number(h) * 60 + Number(m);
  };
  return { start: toMin(start), end: toMin(end) };
}

export function isWithinWindow(date: Date, window: string, timeZone: string): boolean {
  const { start, end } = parseWindow(window);
  const now = localMinutes(date, timeZone);
  return now >= start && now < end;
}

/** Next instant (at minute resolution) that falls inside the operating window. */
export function nextWindowOpening(date: Date, window: string, timeZone: string): Date {
  if (isWithinWindow(date, window, timeZone)) return date;
  const { start } = parseWindow(window);
  const now = localMinutes(date, timeZone);
  const minutesUntil = now < start ? start - now : 24 * 60 - now + start;
  const next = new Date(date.getTime() + minutesUntil * MINUTE);
  next.setUTCSeconds(0, 0);
  return next;
}

export function randomBetween(min: number, max: number, random: () => number = Math.random): number {
  return min + Math.floor(random() * (max - min + 1));
}
