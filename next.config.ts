import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "playwright-core"],
  typedRoutes: false,
};

export default nextConfig;
