import { join } from "node:path";
import type { NextConfig } from "next";

// Baseline security headers on every response. Kept conservative so they can't
// break the app: `frame-ancestors 'none'` (+ legacy X-Frame-Options) stops
// clickjacking without touching how pages load, and the asset routes still set
// their own stricter per-response CSP on top. No page-level default-src here —
// that would need Next's nonce plumbing and is out of scope.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // cube ships TS/TSX source with "use client" directives (workspace package).
  transpilePackages: ["cube"],
  // Keep file tracing rooted at the workspace, not misdetected via lockfiles.
  outputFileTracingRoot: join(__dirname, ".."),
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
