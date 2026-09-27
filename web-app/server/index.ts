import { mkdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Store, AppError, string } from "./store";
import { Intakes } from "./intake";
import { grid } from "./grid";
import { cents } from "./inventory";
const root = resolve(import.meta.dir, "..");
const data = process.env.DATA_DIR || resolve(root, "data");
mkdirSync(data, { recursive: true, mode: 0o700 });
const store = new Store(resolve(data, "focus.sqlite"));
const intakes = new Intakes(store);
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
  maxRequestBodySize: 64 * 1024 * 1024,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url),
      path = url.pathname;
    const method = req.method;
    const address = server.requestIP(req)?.address || "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
    try {
      if (
        path.startsWith("/api/") &&
        path !== "/api/ingest" &&
        !["GET", "HEAD"].includes(method)
      ) {
        const origin = req.headers.get("origin");
        if (
          origin &&
          new URL(origin).host !== url.host &&
          !(loopback && process.env.DEV_UI_ORIGIN === origin)
        )
          throw new AppError("Invalid request origin", 403);
      }
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
          if (
            origin &&
            new URL(origin).host !== url.host &&
            !(loopback && process.env.DEV_UI_ORIGIN === origin)
          )
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
        if (path === "/api/product-options" && method === "GET") {
          const words = string(url.searchParams.get("q") || "", 200)
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 12);
          const unit = url.searchParams.get("unit")
            ? string(url.searchParams.get("unit"), 30).toUpperCase()
            : null;
          const mrp = url.searchParams.has("mrp")
            ? cents(Number(url.searchParams.get("mrp")))
            : null;
          const where = words.map(
            () =>
              "(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM supplier_products sp WHERE sp.product_id=p.id AND sp.code LIKE ? ESCAPE '\\'))",
          );
          const args = words.flatMap((word) => {
            const term = "%" + word.replace(/[\\%_]/g, "\\$&") + "%";
            return [term, term, term];
          });
          return json(
            store.db
              .query(
                `SELECT p.id,p.name,p.sku,p.unit,p.stock/1000.0 stock,COALESCE((SELECT SUM(l.remaining)/1000.0 FROM stock_lots l WHERE l.product_id=p.id AND (? IS NULL OR l.mrp=?)),0) matchingStock FROM products p WHERE p.archived=0 AND (? IS NULL OR upper(p.unit)=?) ${where.length ? "AND " + where.join(" AND ") : ""} ORDER BY p.name COLLATE NOCASE,p.id LIMIT 30`,
              )
              .all(mrp, mrp, unit, unit, ...args),
          );
        }

        const option = path.match(/^\/api\/product-options\/([^/]+)$/);
        if (option && method === "GET") {
          const row = store.db
            .query(
              "SELECT id,name,sku,unit,archived,stock/1000.0 stock FROM products WHERE id=?",
            )
            .get(option[1]!);
          if (!row) throw new AppError("Item not found", 404);
          return json({
            ...row,
            lots: store.inventory
              .lots(option[1]!)
              .filter((lot) => lot.remaining > 0)
              .map((lot) => ({ mrp: lot.mrp, remaining: lot.remaining })),
          });
        }
        const table = path.match(
          /^\/api\/tables\/(products|bills|invoices|customers|lots|movements)$/,
        );
        if (table && method === "GET")
          return json(grid(store, table[1]!, url.searchParams));
        const customer = path.match(/^\/api\/customers\/([^/]+)$/);
        if (customer && method === "GET") {
          const row = store.db
            .query("SELECT * FROM customers WHERE id=?")
            .get(customer[1]!);
          if (!row) throw new AppError("Customer not found", 404);
          return json(row);
        }
        if (path === "/api/intakes" && method === "GET")
          return json(intakes.list());
        if (path === "/api/intakes" && method === "POST") {
          const form = await req.formData();
          const files = form.getAll("pages");
          if (files.some((f) => !(f instanceof File)))
            throw new AppError("Choose invoice photos");
          return json(await intakes.create(files as File[]), 201);
        }
        const intake = path.match(
          /^\/api\/intakes\/([^/]+)(?:\/(process|receive|pages)(?:\/([^/]+)(?:\/(original))?)?)?$/,
        );
        if (intake) {
          const [, id, action, page, original] = intake;
          if (action === "pages" && page && method === "GET") {
            const file = intakes.page(id!, page, Boolean(original));
            return new Response(file.bytes, {
              headers: {
                "Content-Type": file.mime,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
              },
            });
          }
          if (!action && method === "GET") return json(intakes.get(id!));
          if (!action && method === "PUT")
            return json(intakes.save(id!, await req.json()));
          if (action === "process" && method === "POST")
            return json(await intakes.process(id!));
          if (action === "receive" && method === "POST")
            return json(intakes.receive(id!, (await req.json()).revision));
        }
        if (path === "/api/products" && method === "GET")
          return json(store.products());
        if (path === "/api/purchases" && method === "GET")
          return json(store.inventory.purchases());
        if (path === "/api/purchases" && method === "POST")
          throw new AppError("Upload supplier invoice photos to receive stock");
        const purchase = path.match(
          /^\/api\/purchases\/([^/]+)(?:\/(receive))?$/,
        );
        if (purchase) {
          const [, id, action] = purchase;
          if (!action && method === "GET") {
            const purchase = store.inventory.purchase(id);
            return json({
              ...purchase,
              lines: purchase.lines.map((line: any) => ({
                ...line,
                product: store.db
                  .query("SELECT id,name,sku,unit FROM products WHERE id=?")
                  .get(line.productId),
              })),
            });
          }
          if (!action && method === "PUT")
            throw new AppError(
              "Review the supplier invoice draft to update it",
            );
          if (!action && method === "DELETE") {
            store.inventory.deletePurchase(id);
            return json({ ok: true });
          }
          if (action === "receive" && method === "POST")
            throw new AppError(
              "Confirm the reviewed supplier invoice to add stock",
            );
        }
        const lot = path.match(/^\/api\/products\/([^/]+)\/lots\/([^/]+)$/);
        if (lot && method === "PUT") {
          store.inventory.setLotPrices(lot[1], lot[2], await req.json());
          return json({ ok: true });
        }
        if (path === "/api/products" && method === "POST")
          throw new AppError(
            "New products are created from reviewed supplier invoices",
          );
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
          if (!action && method === "GET") {
            const p = store.db
              .query("SELECT * FROM products WHERE id=?")
              .get(id) as any;
            if (!p) throw new AppError("Item not found", 404);
            return json({
              ...p,
              stock: p.stock / 1000,
              minimum: p.minimum / 1000,
              supplierCodes: store.db
                .query(
                  "SELECT tin,code FROM supplier_products WHERE product_id=? ORDER BY tin,code",
                )
                .all(id),
              lots: store.inventory.lots(id),
            });
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
            const { raw, hash, ...b } = store.reviewBill(id);
            return json(b);
          }
          if (!action && method === "PUT") {
            const input = await req.json();
            if (!Number.isInteger(input.revision))
              throw new AppError("Reload this bill before saving.", 409);
            return json(store.saveBill(id, input));
          }
          if (
            (action === "accept" || action === "reject") &&
            method === "POST"
          ) {
            const input = await req.json().catch(() => ({}));
            if (!Number.isInteger(input.revision))
              throw new AppError("Reload this bill before continuing.", 409);
            return json(
              store.decide(
                id,
                action === "accept" ? "accepted" : "rejected",
                input.revision,
              ),
            );
          }
        }
        throw new AppError("Not found", 404);
      }
      if (!["GET", "HEAD"].includes(method))
        throw new AppError("Not found", 404);
      // Bun remains the public API boundary, retaining real client IP and origin checks.
      // Next.js serves every page and asset from an internal loopback listener.
      const frontend = process.env.FRONTEND_URL;
      if (!frontend)
        return new Response(
          "Start Focus with bun run start or bun run sample.",
          { status: 503 },
        );
      const headers = new Headers(req.headers);
      headers.delete("host");
      try {
        const response = await fetch(new URL(path + url.search, frontend), {
          method,
          headers,
          redirect: "manual",
        });
        const outgoing = new Headers(response.headers);
        outgoing.delete("content-encoding");
        outgoing.delete("content-length");
        outgoing.set("X-Content-Type-Options", "nosniff");
        return new Response(response.body, {
          status: response.status,
          headers: outgoing,
        });
      } catch {
        return new Response("Workspace is starting. Refresh shortly.", {
          status: 503,
          headers: { "Retry-After": "3" },
        });
      }
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
