import { bridgeDownload } from "./bridge-download";
import { PhotoStorage } from "./photos";
import { mapAsync } from "./db";
import { resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Store, AppError, string } from "./store";
import { Intakes } from "./intake";
import { grid } from "./grid";
import { finance, financeCsv } from "./finance";
import { cents } from "./inventory";
let pending: Promise<{ store: Store; intakes: Intakes }> | undefined;
export function workspace() {
  return (pending ||= (async () => {
    const local = process.env.FOCUS_LOCAL === "1";
    const database = local
      ? resolve(
          process.env.DATA_DIR || resolve(process.cwd(), "data"),
          "focus.sqlite",
        )
      : process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
    if (!database) throw new Error("DATABASE_URL is required");
    const store = await Store.open(database);
    const intakes = await Intakes.open(
      store,
      local ? undefined : new PhotoStorage(),
    );
    await store.db.exec(
      "CREATE TABLE IF NOT EXISTS login_attempts(address TEXT PRIMARY KEY,count INTEGER NOT NULL,until_ms INTEGER NOT NULL)",
    );
    await store.db.transaction(async () => {
      if (!(await store.setting("connectorKey")))
        await store.set(
          "connectorKey",
          process.env.CONNECTOR_KEY || randomBytes(24).toString("hex"),
        );
      if (!(await store.setting("password")) && process.env.WORKSPACE_PASSWORD)
        await store.set(
          "password",
          await Bun.password.hash(process.env.WORKSPACE_PASSWORD),
        );
    })();
    if (!local && !(await store.setting("password")))
      throw new Error(
        "Workspace credentials must be migrated before deployment",
      );
    return { store, intakes };
  })().catch((error) => {
    pending = undefined;
    throw error;
  }));
}
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
const authenticated = async (req: Request, store: Store) =>
  Boolean(
    await store.db
      .query("SELECT token FROM sessions WHERE token=? AND expires>?")
      .get(token(req), Date.now()),
  );
const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function handleApi(
  req: Request,
  address = "",
  allowLocalSetup = false,
) {
  const response = await handleApiResponse(req, address, allowLocalSetup);
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}
async function handleApiResponse(
  req: Request,
  address: string,
  allowLocalSetup: boolean,
) {
  const url = new URL(req.url),
    path = url.pathname;
  const method = req.method;
  // Vercel can preserve the public URL on requests routed through a rewrite.
  if (
    path === "/downloads/focus-bridge.apk" ||
    path === "/api/downloads/focus-bridge.apk"
  )
    return bridgeDownload(req);
  const loopback =
    allowLocalSetup &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
  try {
    const { store, intakes } = await workspace();
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
    if (path === "/api/health") {
      await store.db.query("SELECT 1 AS ok").get();
      return json({ ok: true });
    }
    if (path === "/api/maintenance" && method === "GET") {
      if (
        !process.env.CRON_SECRET ||
        !safeEqual(
          req.headers.get("authorization") || "",
          `Bearer ${process.env.CRON_SECRET}`,
        )
      )
        throw new AppError("Unauthorized", 401);
      await intakes.cleanupPhotos();
      return json({ ok: true });
    }
    if (path === "/api/session" && method === "GET")
      return json({
        authenticated: await authenticated(req, store),
        setup: !(await store.setting("password")),
        canSetup: loopback,
      });
    if (path === "/api/login" && method === "POST") {
      const attempt = await store.db
        .query(
          "SELECT count,until_ms AS until FROM login_attempts WHERE address=?",
        )
        .get(address);
      if (attempt && attempt.until > Date.now() && attempt.count >= 8)
        throw new AppError("Try again in 10 minutes", 429);
      const body = await req.json();
      const password = string(body.password, 200);
      if (password.length < 10)
        throw new AppError("Use at least 10 characters");
      if (!(await store.setting("password"))) {
        if (!loopback)
          throw new AppError(
            "Set up the workspace on this computer first",
            403,
          );
        await store.set("password", Bun.password.hashSync(password));
      }
      if (
        !(await Bun.password.verify(
          password,
          (await store.setting("password"))!,
        ))
      ) {
        await store.db
          .query(
            "INSERT INTO login_attempts(address,count,until_ms) VALUES (?,1,?) ON CONFLICT(address) DO UPDATE SET count=CASE WHEN login_attempts.until_ms>? THEN login_attempts.count+1 ELSE 1 END,until_ms=excluded.until_ms",
          )
          .run(address, Date.now() + 600000, Date.now());
        throw new AppError("Incorrect password", 401);
      }
      await store.db
        .query("DELETE FROM login_attempts WHERE address=?")
        .run(address);
      const session = randomBytes(32).toString("hex");
      await store.db
        .query("DELETE FROM sessions WHERE expires<?")
        .run(Date.now());
      await store.db
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
          `Bearer ${await store.setting("connectorKey")}`,
        )
      )
        throw new AppError("Invalid connector key", 401);
      return json(
        await store.ingest(
          new Uint8Array(await req.arrayBuffer()),
          decodeURIComponent(req.headers.get("x-filename") || "Print job"),
          req.headers.get("content-type") || "",
          req.headers.get("x-device-name") || "Tablet",
        ),
      );
    }
    if (path.startsWith("/api/")) {
      if (!(await authenticated(req, store)))
        throw new AppError("Sign in to continue", 401);
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
        await store.db
          .query("DELETE FROM sessions WHERE token=?")
          .run(token(req));
        return json({ ok: true });
      }
      if (path === "/api/connection" && method === "GET")
        return json({
          key: await store.setting("connectorKey"),
          urls:
            process.env.FOCUS_LOCAL !== "1"
              ? [process.env.APP_URL || "https://cbf.amsonline.lk"]
              : Object.values(networkInterfaces())
                  .flat()
                  .filter((i) => i?.family === "IPv4" && !i.internal)
                  .map((i) => `http://${i!.address}:${port}`),
          mode: process.env.FOCUS_LOCAL === "1" ? "Local Wi-Fi" : "Cloud",
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
          await store.db
            .query(
              `SELECT p.id,p.name,p.sku,p.unit,p.stock/1000.0 stock,COALESCE((SELECT SUM(l.remaining)/1000.0 FROM stock_lots l WHERE l.product_id=p.id AND (? IS NULL OR l.mrp=?)),0) matchingStock FROM products p WHERE p.archived=0 AND (? IS NULL OR upper(p.unit)=?) ${where.length ? "AND " + where.join(" AND ") : ""} ORDER BY p.name COLLATE NOCASE,p.id LIMIT 30`,
            )
            .all(mrp, mrp, unit, unit, ...args),
        );
      }
      const option = path.match(/^\/api\/product-options\/([^/]+)$/);
      if (option && method === "GET") {
        const row = await store.db
          .query(
            "SELECT id,name,sku,unit,archived,stock/1000.0 stock FROM products WHERE id=?",
          )
          .get(option[1]!);
        if (!row) throw new AppError("Item not found", 404);
        return json({
          ...row,
          lots: (await store.inventory.lots(option[1]!))
            .filter((lot) => lot.remaining > 0)
            .map((lot) => ({ mrp: lot.mrp, remaining: lot.remaining })),
        });
      }
      if (path === "/api/finance/export" && method === "GET") {
        const report = await finance(store, url.searchParams, new Date(), true);
        return new Response(financeCsv(report), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="finance-${report.filters.from}-${report.filters.to}.csv"`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (path === "/api/finance" && method === "GET")
        return json(await finance(store, url.searchParams));
      const table = path.match(
        /^\/api\/tables\/(products|bills|invoices|customers|lots|movements)$/,
      );
      if (table && method === "GET")
        return json(await grid(store, table[1]!, url.searchParams));
      const customer = path.match(/^\/api\/customers\/([^/]+)$/);
      if (customer && method === "GET") {
        const row = await store.db
          .query("SELECT * FROM customers WHERE id=?")
          .get(customer[1]!);
        if (!row) throw new AppError("Customer not found", 404);
        return json(row);
      }
      if (path === "/api/intake-uploads" && method === "POST")
        return json(await intakes.prepareUpload(await req.json()));
      const upload = path.match(
        /^\/api\/intake-uploads\/([a-f0-9-]+)\/complete$/,
      );
      if (upload && method === "POST")
        return json(await intakes.completeUpload(upload[1]!));
      if (path === "/api/intakes" && method === "GET")
        return json(await intakes.list());
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
          const file = await intakes.page(id!, page, Boolean(original));
          if (file.url)
            return new Response(null, {
              status: 302,
              headers: {
                Location: file.url,
                "Cache-Control": "private, no-store",
              },
            });
          return new Response(file.bytes, {
            headers: {
              "Content-Type": file.mime,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        if (!action && method === "GET") return json(await intakes.get(id!));
        if (!action && method === "PUT")
          return json(await intakes.save(id!, await req.json()));
        if (action === "process" && method === "POST")
          return json(await intakes.process(id!));
        if (action === "receive" && method === "POST") {
          const input = await req.json();
          return json(
            await intakes.receive(id!, input.revision, input.acceptedWarnings),
          );
        }
      }
      if (path === "/api/products" && method === "GET")
        return json(await store.products());
      if (path === "/api/purchases" && method === "GET")
        return json(await store.inventory.purchases());
      if (path === "/api/purchases" && method === "POST")
        throw new AppError("Upload supplier invoice photos to receive stock");
      const purchase = path.match(
        /^\/api\/purchases\/([^/]+)(?:\/(receive))?$/,
      );
      if (purchase) {
        const [, id, action] = purchase;
        if (!action && method === "GET") {
          const purchase = await store.inventory.purchase(id);
          return json({
            ...purchase,
            lines: await mapAsync(purchase.lines, async (line: any) => ({
              ...line,
              product: await store.db
                .query("SELECT id,name,sku,unit FROM products WHERE id=?")
                .get(line.productId),
            })),
          });
        }
        if (!action && method === "PUT")
          throw new AppError("Review the supplier invoice draft to update it");
        if (!action && method === "DELETE") {
          await store.inventory.deletePurchase(id);
          return json({ ok: true });
        }
        if (action === "receive" && method === "POST")
          throw new AppError(
            "Confirm the reviewed supplier invoice to add stock",
          );
      }
      const lot = path.match(/^\/api\/products\/([^/]+)\/lots\/([^/]+)$/);
      if (lot && method === "PUT") {
        await store.inventory.setLotPrices(lot[1], lot[2], await req.json());
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
          return json(await store.history(id));
        if (action === "adjust" && method === "POST") {
          await store.adjust(id, await req.json());
          return json({ ok: true });
        }
        if (!action && method === "GET") {
          const p = (await store.db
            .query("SELECT * FROM products WHERE id=?")
            .get(id)) as any;
          if (!p) throw new AppError("Item not found", 404);
          return json({
            ...p,
            stock: p.stock / 1000,
            minimum: p.minimum / 1000,
            supplierCodes: await store.db
              .query(
                "SELECT tin,code FROM supplier_products WHERE product_id=? ORDER BY tin,code",
              )
              .all(id),
            lots: await store.inventory.lots(id),
          });
        }
        if (!action && method === "DELETE") {
          const input = await req.json();
          return json(
            await store.deleteBill(id, input.revision, input.confirmation),
          );
        }
        if (!action && method === "PUT") {
          await store.saveProduct(await req.json(), id);
          return json({ ok: true });
        }
        if (!action && method === "DELETE") {
          await store.archive(id);
          return json({ ok: true });
        }
      }
      if (path === "/api/bills" && method === "GET")
        return json(await store.bills());
      if (path === "/api/upload" && method === "POST") {
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File)) throw new AppError("Choose a file");
        return json(
          await store.ingest(
            new Uint8Array(await file.arrayBuffer()),
            file.name,
            file.type,
            "Manual upload",
          ),
          201,
        );
      }
      const bill = path.match(
        /^\/api\/bills\/([^/]+)(?:\/(raw|accept|reject|availability|restore))?$/,
      );
      if (bill) {
        const [, id, action] = bill;
        if (action === "restore" && method === "POST") {
          const input = await req.json();
          if (!Number.isInteger(input.revision))
            throw new AppError("Reload this bill before continuing.", 409);
          return json(await store.restoreBillPrint(id, input.revision));
        }
        if (action === "availability" && method === "GET")
          return json({
            issues: (await store.inventory.plan(await store.bill(id))).issues,
          });
        if (action === "raw" && method === "GET") {
          const b = await store.bill(id);
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
          const { raw, hash, ...b } = await store.reviewBill(id);
          return json(b);
        }
        if (!action && method === "DELETE") {
          const input = await req.json();
          return json(
            await store.deleteBill(id, input.revision, input.confirmation),
          );
        }
        if (!action && method === "PUT") {
          const input = await req.json();
          if (!Number.isInteger(input.revision))
            throw new AppError("Reload this bill before saving.", 409);
          return json(await store.saveBill(id, input));
        }
        if ((action === "accept" || action === "reject") && method === "POST") {
          const input = await req.json().catch(() => ({}));
          if (!Number.isInteger(input.revision))
            throw new AppError("Reload this bill before continuing.", 409);
          return json(
            await store.decide(
              id,
              action === "accept" ? "accepted" : "rejected",
              input.revision,
            ),
          );
        }
      }
      throw new AppError("Not found", 404);
    }
    throw new AppError("Not found", 404);
  } catch (error) {
    if (error instanceof AppError)
      return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError)
      return json({ error: "Invalid request" }, 400);
    if (
      String(error).includes("UNIQUE constraint") ||
      (error as any)?.code === "23505"
    )
      return json({ error: "This SKU or bill number already exists" }, 409);
    console.error("API request failed", {
      path,
      code: (error as any)?.code || "internal",
    });
    return json({ error: "Unable to complete this request" }, 500);
  }
}
