import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { withWorkflow } from "workflow/next";

const isProduction = process.env.NODE_ENV === "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: [
    "pg",
    // Bundling the AI SDK duplicates its module instances across bundle
    // worlds (route/flow/step); Node resolution keeps them shared where the
    // workflow plugin permits. (The plugin re-bundles the packages that
    // carry workflow serialization classes and warns about them here.)
    "ai",
    "@ai-sdk/openai",
    "@ai-sdk/gateway",
    "@ai-sdk/provider",
    "@ai-sdk/provider-utils",
  ],
  // The desktop AI mode (and local tooling) reaches the dev server via
  // 127.0.0.1 while `next dev` binds localhost; allow that origin for dev
  // assets. Production is unaffected.
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: fileURLToPath(new URL(".", import.meta.url)),
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(isProduction
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]
            : []),
        ],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
    ];
  },
};

export default withWorkflow(nextConfig);
