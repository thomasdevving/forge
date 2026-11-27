import type { NextConfig } from "next";

// Services are reached through same-origin /api/* rewrites so their URLs stay server-side.
// FORGE_API_URL is the hosted gateway; per-service overrides exist for local development.
const base = process.env.FORGE_API_URL ?? "";
const svc = (name: string, local: string) =>
  process.env[`FORGE_${name.toUpperCase()}_URL`] ?? (base ? `${base}/${name}` : local);

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/api/compiler/:path*", destination: `${svc("compiler", "http://127.0.0.1:8000")}/:path*` },
      { source: "/api/indexer/:path*", destination: `${svc("indexer", "http://127.0.0.1:8787")}/:path*` },
      { source: "/api/tx/:path*", destination: `${svc("tx", "http://127.0.0.1:8788")}/:path*` },
      { source: "/api/control/:path*", destination: `${svc("control", "http://127.0.0.1:8791")}/:path*` },
      { source: "/api/agent/:path*", destination: `${svc("agent", "http://127.0.0.1:8792")}/:path*` },
    ];
  },
};

export default config;
