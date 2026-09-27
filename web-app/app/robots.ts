import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  // Crawlers must be able to read the site-wide noindex response headers.
  // Authentication protects workspace data; no sitemap is published.
  return { rules: { userAgent: "*", allow: "/" } };
}
