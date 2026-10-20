import fs from "node:fs";

/** CLI entrypoints (worker, scripts) load .env the same way Next.js does for the panel. */
if (fs.existsSync(".env")) process.loadEnvFile(".env");
