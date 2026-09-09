import type { NextConfig } from "next";

const config: NextConfig = {
  // @aerodb/core ships raw TS (internal package) — let Next transpile it.
  transpilePackages: ["@aerodb/core"],
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
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl.replace(/\/$/, "")}/api/:path*`,
      },
    ];
  },
};

export default config;
