import { mkdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Store, AppError, string } from "./store";
const root = resolve(import.meta.dir, "..");
const data = process.env.DATA_DIR || resolve(root, "data");
mkdirSync(data, { recursive: true, mode: 0o700 });
const store = new Store(resolve(data, "focus.sqlite"));
if (!store.setting("connectorKey"))
  store.set("connectorKey", randomBytes(24).toString("hex"));
const port = Number(process.env.PORT || 4310);
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const token = (req: Request) =>
  req.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)focus_session=([a-f0-9]+)/)?.[1] || "";
const authenticated = (req: Request) =>
  Boolean(
    store.db
      .query("SELECT token FROM sessions WHERE token=? AND expires>?")
      .get(token(req), Date.now()),
  );
const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const attempts = new Map<string, { count: number; until: number }>();
const server = Bun.serve({
  hostname: process.env.HOST || "0.0.0.0",
  port,
  maxRequestBodySize: 11 * 1024 * 1024,
  async fetch(req, server) {
    const url = new URL(req.url),
      path = url.pathname;
    const method = req.method;
    const address = server.requestIP(req)?.address || "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
    try {
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/session" && method === "GET")
        return json({
          authenticated: authenticated(req),
          setup: !store.setting("password"),
          canSetup: loopback,
        });
      if (path === "/api/login" && method === "POST") {
        const attempt = attempts.get(address);
        if (attempt && attempt.until > Date.now() && attempt.count >= 8)
          throw new AppError("Try again in 10 minutes", 429);
        const body = await req.json();
        const password = string(body.password, 200);
        if (password.length < 10)
          throw new AppError("Use at least 10 characters");
        if (!store.setting("password")) {
          if (!loopback)
            throw new AppError(
              "Set up the workspace on this computer first",
              403,
            );
          store.set("password", Bun.password.hashSync(password));
        }
        if (
          !(await Bun.password.verify(password, store.setting("password")!))
        ) {
          attempts.set(address, {
            count:
              attempt && attempt.until > Date.now() ? attempt.count + 1 : 1,
            until: Date.now() + 600000,
          });
          throw new AppError("Incorrect password", 401);
        }
        attempts.delete(address);
        const session = randomBytes(32).toString("hex");
        store.db.query("DELETE FROM sessions WHERE expires<?").run(Date.now());
        store.db
          .query("INSERT INTO sessions VALUES (?,?)")
          .run(session, Date.now() + 86400000);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `focus_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.SECURE_COOKIES === "1" ? "; Secure" : ""}`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (path === "/api/ingest" && method === "POST") {
        if (
          !safeEqual(
            req.headers.get("authorization") || "",
            `Bearer ${store.setting("connectorKey")}`,
          )
        )
          throw new AppError("Invalid connector key", 401);
        return json(
          store.ingest(
            new Uint8Array(await req.arrayBuffer()),
            decodeURIComponent(req.headers.get("x-filename") || "Print job"),
            req.headers.get("content-type") || "",
            req.headers.get("x-device-name") || "Tablet",
          ),
        );
      }
      if (path.startsWith("/api/")) {
        if (!authenticated(req)) throw new AppError("Sign in to continue", 401);
        // Same-site cookies and origin checks protect browser mutations on LAN and behind HTTPS.
        if (!["GET", "HEAD"].includes(method)) {
          const origin = req.headers.get("origin");
          if (origin && new URL(origin).host !== url.host)
            throw new AppError("Invalid request origin", 403);
        }
        if (path === "/api/logout" && method === "POST") {
          store.db.query("DELETE FROM sessions WHERE token=?").run(token(req));
          return json({ ok: true });
        }
        if (path === "/api/connection" && method === "GET")
          return json({
            key: store.setting("connectorKey"),
            urls: Object.values(networkInterfaces())
              .flat()
              .filter((i) => i?.family === "IPv4" && !i.internal)
              .map((i) => `http://${i!.address}:${port}`),
            mode: "Local Wi-Fi",
            maxFileMB: 10,
          });
        if (path === "/api/products" && method === "GET")
          return json(store.products());
        if (path === "/api/purchases" && method === "GET")
          return json(store.inventory.purchases());
        if (path === "/api/purchases" && method === "POST")
          return json(store.inventory.savePurchase(await req.json()), 201);
        const purchase = path.match(
          /^\/api\/purchases\/([^/]+)(?:\/(receive))?$/,
        );
        if (purchase) {
          const [, id, action] = purchase;
          if (!action && method === "GET")
            return json(store.inventory.purchase(id));
          if (!action && method === "PUT")
            return json(store.inventory.savePurchase(await req.json(), id));
          if (!action && method === "DELETE") {
            store.inventory.deletePurchase(id);
            return json({ ok: true });
          }
          if (action === "receive" && method === "POST")
            return json(store.inventory.postPurchase(id));
        }
        const lot = path.match(/^\/api\/products\/([^/]+)\/lots\/([^/]+)$/);
        if (lot && method === "PUT") {
          store.inventory.setLotPrices(lot[1], lot[2], await req.json());
          return json({ ok: true });
        }
        if (path === "/api/products" && method === "POST")
          return json({ id: store.saveProduct(await req.json()) }, 201);
        const product = path.match(
          /^\/api\/products\/([^/]+)(?:\/(adjust|history))?$/,
        );
        if (product) {
          const [, id, action] = product;
          if (action === "history" && method === "GET")
            return json(store.history(id));
          if (action === "adjust" && method === "POST") {
            store.adjust(id, await req.json());
            return json({ ok: true });
          }
          if (!action && method === "PUT") {
            store.saveProduct(await req.json(), id);
            return json({ ok: true });
          }
          if (!action && method === "DELETE") {
            store.archive(id);
            return json({ ok: true });
          }
        }
        if (path === "/api/bills" && method === "GET")
          return json(store.bills());
        if (path === "/api/upload" && method === "POST") {
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof File)) throw new AppError("Choose a file");
          return json(
            store.ingest(
              new Uint8Array(await file.arrayBuffer()),
              file.name,
              file.type,
              "Manual upload",
            ),
            201,
          );
        }
        const bill = path.match(
          /^\/api\/bills\/([^/]+)(?:\/(raw|accept|reject|availability))?$/,
        );
        if (bill) {
          const [, id, action] = bill;
          if (action === "availability" && method === "GET")
            return json({
              issues: store.inventory.plan(store.bill(id)).issues,
            });
          if (action === "raw" && method === "GET") {
            const b = store.bill(id);
            return new Response(b.raw, {
              headers: {
                "Content-Type": b.mime,
                "Content-Disposition": `inline; filename="bill-${id}.${b.mime === "application/pdf" ? "pdf" : "bin"}"`,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox",
              },
            });
          }
          if (!action && method === "GET") {
            const { raw, hash, ...b } = store.bill(id);
            return json(b);
          }
          if (!action && method === "PUT") {
            store.saveBill(id, await req.json());
            return json({ ok: true });
          }
          if (action === "accept" && method === "POST")
            return json(store.decide(id, "accepted"));
          if (action === "reject" && method === "POST")
            return json(store.decide(id, "rejected"));
        }
        throw new AppError("Not found", 404);
      }
      if (!["GET", "HEAD"].includes(method))
        throw new AppError("Not found", 404);
      const relative = decodeURIComponent(path).replace(/^\/+/, "");
      const target = resolve(root, "dist", relative);
      if (
        !target.startsWith(resolve(root, "dist") + "/") &&
        target !== resolve(root, "dist")
      )
        throw new AppError("Not found", 404);
      const file = Bun.file(target);
      if (relative && (await file.exists()))
        return new Response(file, {
          headers: { "X-Content-Type-Options": "nosniff" },
        });
      if (extname(relative)) throw new AppError("Not found", 404);
      const index = Bun.file(resolve(root, "dist/index.html"));
      if (!(await index.exists()))
        return new Response("Build the web app with bun run build.", {
          status: 503,
        });
      return new Response(index, {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof AppError)
        return json({ error: error.message }, error.status);
      if (error instanceof SyntaxError)
        return json({ error: "Invalid request" }, 400);
      if (String(error).includes("UNIQUE constraint"))
        return json({ error: "This SKU or bill number already exists" }, 409);
      console.error(error);
      return json({ error: "Unable to complete this request" }, 500);
    }
  },
});
console.log(`Focus is running at http://localhost:${server.port}`);
