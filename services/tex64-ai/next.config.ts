import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const isProduction = process.env.NODE_ENV === "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  // blob: is how the page hands the desktop build's PDF to the viewer:
  // the bytes arrive over the host bridge, not the network, and pdf.js
  // reads them back through a blob URL of our own making.
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The dev overlay renders a floating "N" badge over the app. Inside the
  // TeX64 desktop AI mode it reads as a product control that leads nowhere,
  // so it is off by default; set TEX64_NEXT_DEV_INDICATORS=1 when a developer
  // wants the Next.js dev tools in a normal browser.
  devIndicators: process.env.TEX64_NEXT_DEV_INDICATORS === "1" ? undefined : false,
  serverExternalPackages: ["pg"],
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

export default nextConfig;
