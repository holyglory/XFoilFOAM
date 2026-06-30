import type { NextConfig } from "next";

const config: NextConfig = {
  // @aerodb/core ships raw TS (internal package) — let Next transpile it.
  transpilePackages: ["@aerodb/core"],
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? "http://localhost:4000";
    return [{ source: "/api/sync/:path*", destination: `${apiUrl.replace(/\/$/, "")}/api/sync/:path*` }];
  },
};

export default config;
