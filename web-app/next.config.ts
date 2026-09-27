import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {"/api/*":["./node_modules/@tesseract.js-data/**/*", "./node_modules/tesseract.js/**/*", "./node_modules/tesseract.js-core/**/*"]},
  agentRules: false,
  devIndicators: false,
  serverExternalPackages: ["pg", "tesseract.js", "tesseract.js-core"],
  webpack(config) { config.externals.push("bun:sqlite"); return config; },
  async rewrites() {
    if (process.env.VERCEL) return [];
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${process.env.FOCUS_API_PORT || 4310}/api/:path*`,
      },
    ];
  },
};
export default config;
