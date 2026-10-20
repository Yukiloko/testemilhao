import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Db } from "./client";

const KEEP = 14;

/** Online backup through SQLite's backup API (safe while the app is writing). Keeps the newest KEEP files. */
export async function backupDatabase(d: Db, dir: string, now = new Date()): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `app-${now.toISOString().replace(/[:.]/g, "-")}.db`);
  await d.$client.backup(file);
  const backups = listBackups(dir);
  for (const old of backups.slice(KEEP)) fs.rmSync(path.join(dir, old));
  return file;
}

export function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith("app-") && f.endsWith(".db")).sort().reverse();
}

/** Verifies the backup is a readable, consistent SQLite database before restoring it over target. */
export function restoreDatabase(backupFile: string, targetFile: string): void {
  const check = new Database(backupFile, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`Backup failed integrity check: ${String(result)}`);
  } finally {
    check.close();
  }
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(targetFile + suffix, { force: true });
  fs.mkdirSync(path.dirname(path.resolve(targetFile)), { recursive: true });
  fs.copyFileSync(backupFile, targetFile);
}
