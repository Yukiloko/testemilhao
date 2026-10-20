import "@/lib/load-env";
import path from "node:path";
import { listBackups, restoreDatabase } from "../backup";

const dir = process.env.BACKUP_DIR ?? "./backups";
const target = process.env.DATABASE_URL ?? "./data/app.db";
const chosen = process.argv[2] ?? listBackups(dir)[0];

if (!chosen) {
  console.error(`No backups found in ${dir}.`);
  process.exit(1);
}

const file = path.isAbsolute(chosen) || chosen.includes("/") ? chosen : path.join(dir, chosen);
restoreDatabase(file, target);
console.log(`Restored ${file} -> ${target}. Start the app again.`);
