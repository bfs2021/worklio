import type { NextConfig } from "next";

// Dev only: extra hostnames allowed to load dev assets, e.g. "127.0.0.1,192.168.1.20" so a second
// account can sign in from another origin (auth is per-origin) when testing calls and realtime.
const devOrigins = (process.env.NEXT_DEV_ALLOWED_ORIGINS ?? "127.0.0.1")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Calls, voice/video messages and screen recording need these; nothing else does.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
  // Self-contained server bundle for the production Docker image (frontend/Dockerfile).
  output: "standalone",
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
