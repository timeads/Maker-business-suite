import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
