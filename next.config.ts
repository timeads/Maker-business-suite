import type { NextConfig } from "next";

/** Where uploaded pictures are served from: the one other origin a public help page may load from. */
function storageOrigin(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
  } catch {
    return "";
  }
}

/**
 * The public help centre is read by strangers and shows words a workspace
 * typed, so its pages carry the tightest headers the app's own scripts allow:
 * nothing framed, nothing loaded from anywhere but us and our storage,
 * no plugins, no forms posting elsewhere. (Next's own inline scripts need
 * 'unsafe-inline'; no markup from a workspace or a visitor is ever rendered.)
 */
const helpCentreHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: ${storageOrigin()}`.trim(),
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/help-centre/:path*", headers: helpCentreHeaders }];
  },
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // The font a purchase order falls back on for names its own font can't
  // draw is read from disk when a PDF is made, so it has to travel with the app.
  outputFileTracingIncludes: {
    "/*": ["src/lib/stock/po/fonts/*"],
  },
  experimental: {
    // Social posts carry a photo of up to 5 MB.
    serverActions: { bodySizeLimit: "6mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
