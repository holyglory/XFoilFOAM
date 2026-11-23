import type { NextConfig } from "next";
import { resolve } from "node:path";
import { webSourceIdentity } from "./source-identity.mjs";

const config: NextConfig = {
  // @aerodb/core ships raw TS (internal package) — let Next transpile it.
  transpilePackages: ["@aerodb/core"],
  generateBuildId: async () =>
    webSourceIdentity(resolve(process.cwd(), "../..")),
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: {
    ignoreBuildErrors: false,
    tsconfigPath: process.env.NEXT_TSCONFIG_PATH ?? "tsconfig.json",
  },
  async rewrites() {
    const apiUrl =
      process.env.API_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      "http://localhost:4000";
    return {
      beforeFiles: [
        {
          source: "/",
          missing: [{ type: "query", key: "condition" }],
          destination: "/catalog-page/default",
        },
      ],
      afterFiles: [
        {
          source: "/api/:path*",
          destination: `${apiUrl.replace(/\/$/, "")}/api/:path*`,
        },
      ],
      fallback: [],
    };
  },
};

export default config;
