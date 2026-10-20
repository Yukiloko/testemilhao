import { db, type Db } from "@/db/client";
import { raiseAlert, recordEvent } from "./audit";
import { getSettings, updateSettings } from "./settings";

export function isPaused(d: Db = db()): boolean {
  return getSettings(d).paused;
}

/** Global kill switch. Stops every outbound action until the operator resumes. */
export function pauseSystem(reason: string, actor: "system" | "operator", d: Db = db()): void {
  if (getSettings(d).paused) return;
  updateSettings({ paused: true, pauseReason: reason }, d);
  recordEvent("system.paused", { actor, payload: { reason } }, d);
  raiseAlert(actor === "system" ? "critical" : "info", "system_paused", `Sistema pausado: ${reason}`, {}, d);
}

export function resumeSystem(d: Db = db()): void {
  updateSettings({ paused: false, pauseReason: null }, d);
  recordEvent("system.resumed", { actor: "operator" }, d);
}
