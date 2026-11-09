/** @type {import('next').NextConfig} */

const CSP_DIRECTIVES = [
  "default-src 'self'",
  // Next.js needs inline scripts for hydration data; no remote scripts allowed.
  "script-src 'self' 'unsafe-inline'",
  // Tailwind / inline styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'"
].join("; ");

const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Content-Security-Policy", value: CSP_DIRECTIVES },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }
];

const API_CACHE_HEADERS = [
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
  { key: "Pragma", value: "no-cache" }
];

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  compress: true,
  experimental: {
    serverComponentsExternalPackages: ["mysql2", "pg", "mssql", "ioredis"]
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // NEVER set Content-Encoding here. A static header claims every /api
        // response is gzip while the body is plain JSON, so the browser tries
        // to gunzip plain text and aborts with ERR_CONTENT_DECODING_FAILED —
        // every JSON endpoint, sign-in included, dies in the browser while
        // `curl` (which ignores the header unless --compressed) looks fine.
        // Real compression is `compress: true` above: Next sets the header
        // itself, only when it actually compressed the body.
        source: "/api/:path*",
        headers: API_CACHE_HEADERS
      },
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" }
        ]
      }
    ];
  }
};

export default nextConfig;
