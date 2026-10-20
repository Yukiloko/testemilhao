import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

/** Opens SQLite with the pragmas the system relies on and applies pending migrations. */
export function openDatabase(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

const globalForDb = globalThis as unknown as { __db?: Db };

export function db(): Db {
  if (!globalForDb.__db) globalForDb.__db = openDatabase(process.env.DATABASE_URL ?? "./data/app.db");
  return globalForDb.__db;
}

/** Test hook: swaps the process-wide connection. */
export function setDb(next: Db | undefined): void {
  globalForDb.__db = next;
}

/** Runs fn inside an IMMEDIATE transaction so concurrent writers serialize on the write lock. */
export function tx<T>(fn: (d: Db) => T, d: Db = db()): T {
  return d.$client.transaction(() => fn(d)).immediate();
}
