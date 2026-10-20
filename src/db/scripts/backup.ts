import "@/lib/load-env";
import { db } from "../client";
import { backupDatabase } from "../backup";

const file = await backupDatabase(db(), process.env.BACKUP_DIR ?? "./backups");
console.log(`Backup written: ${file}`);
