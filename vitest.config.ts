import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "src/test/server-only-stub.ts") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
