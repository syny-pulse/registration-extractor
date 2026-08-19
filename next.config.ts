import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // exceljs reaches for a few Node built-ins that the bundler would otherwise
  // try to trace into the serverless bundle. Keeping it external leaves it as a
  // plain require at runtime, which is what the Node runtime wants anyway.
  serverExternalPackages: ["exceljs"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // Nothing here is meant to be indexed, cached by a proxy, or embedded.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
