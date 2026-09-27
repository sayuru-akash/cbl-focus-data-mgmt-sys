import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/*": [
      "./node_modules/@tesseract.js-data/**/*",
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*",
    ],
  },
  agentRules: false,
  devIndicators: false,
  serverExternalPackages: [
    "pg",
    "tesseract.js",
    "tesseract.js-core",
    "@tesseract.js-data/eng",
    "@tesseract.js-data/osd",
  ],
  webpack(config) {
    config.externals.push("bun:sqlite");
    return config;
  },
  async rewrites() {
    const download = {
      source: "/downloads/focus-bridge.apk",
      destination: "/api/downloads/focus-bridge.apk",
    };
    if (process.env.VERCEL) return { beforeFiles: [download] };
    return {
      beforeFiles: [
        download,
        {
          source: "/api/:path*",
          destination: `http://127.0.0.1:${process.env.FOCUS_API_PORT || 4310}/api/:path*`,
        },
      ],
    };
  },
};
export default config;
