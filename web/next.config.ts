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
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
