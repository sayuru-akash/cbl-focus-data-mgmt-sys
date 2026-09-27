import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { handleApi } from "./api";
if (process.env.FOCUS_LOCAL === "1")
  mkdirSync(process.env.DATA_DIR || resolve(process.cwd(), "data"), {
    recursive: true,
    mode: 0o700,
  });
const server = Bun.serve({
  hostname: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 4310),
  maxRequestBodySize: 64 * 1024 * 1024,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/"))
      return handleApi(
        req,
        server.requestIP(req)?.address || "",
        process.env.FOCUS_LOCAL === "1",
      );
    const frontend = process.env.FRONTEND_URL;
    if (!frontend)
      return new Response("Start Focus with bun run start.", { status: 503 });
    const headers = new Headers(req.headers);
    headers.delete("host");
    try {
      const response = await fetch(
        new URL(url.pathname + url.search, frontend),
        { method: req.method, headers, redirect: "manual" },
      );
      const outgoing = new Headers(response.headers);
      outgoing.delete("content-encoding");
      outgoing.delete("content-length");
      return new Response(response.body, {
        status: response.status,
        headers: outgoing,
      });
    } catch {
      return new Response("Workspace is starting. Refresh shortly.", {
        status: 503,
      });
    }
  },
});
console.log(`Focus is running at http://localhost:${server.port}`);
