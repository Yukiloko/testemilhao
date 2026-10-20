import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { leads } from "./schema";
import { openDatabase } from "./client";
import { backupDatabase, listBackups, restoreDatabase } from "./backup";

describe("backup and restore", () => {
  it("restores a consistent snapshot over a damaged database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bm-backup-"));
    const file = path.join(dir, "app.db");
    const d = openDatabase(file);
    d.insert(leads).values({ handle: "antes", funnel: "customer", source: "import" }).run();
    const backup = await backupDatabase(d, path.join(dir, "backups"), new Date("2027-01-01T00:00:00Z"));
    d.insert(leads).values({ handle: "depois", funnel: "customer", source: "import" }).run();
    d.$client.close();

    restoreDatabase(backup, file);
    const restored = openDatabase(file);
    expect(restored.select({ handle: leads.handle }).from(leads).all()).toEqual([{ handle: "antes" }]);
    restored.$client.close();

    fs.writeFileSync(path.join(dir, "backups", "app-corrupt.db"), "not a database");
    expect(() => restoreDatabase(path.join(dir, "backups", "app-corrupt.db"), file)).toThrow();
    expect(listBackups(path.join(dir, "backups"))).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
