import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "./store";
test("HTTP auth, table validation, packet lookup, CSRF and immutable capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "focus-http-"));
  const seed = await Store.open(join(dir, "focus.sqlite"));
  await seed.set("password", Bun.password.hashSync("test-password-only"));
  await seed.set("connectorKey", "test-connector");
  const product = await seed.saveProduct({
    sku: "SKU_1",
    name: "Chocolate",
    unit: "PKT",
    stock: 10,
  });
  await seed.db.close();
  const reserve = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = reserve.port;
  reserve.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const process = Bun.spawn(["bun", "server/index.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...globalThis.process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dir,
      FOCUS_LOCAL: "1",
      SECURE_COOKIES: "0",
      FRONTEND_URL: "http://127.0.0.1:4311",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) break;
      } catch {}
      await Bun.sleep(30);
    }
    expect((await fetch(base + "/api/tables/products")).status).toBe(401);
    expect(
      (
        await fetch(base + "/api/login", {
          method: "POST",
          headers: {
            Origin: "http://evil.invalid",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ password: "test-password-only" }),
        })
      ).status,
    ).toBe(403);
    const login = await fetch(base + "/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "test-password-only" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Cookie: cookie, Origin: base };
    expect(
      (await fetch(base + "/api/tables/products?size=10000", { headers }))
        .status,
    ).toBe(400);
    const table = await (
      await fetch(base + "/api/tables/products", { headers })
    ).json();
    expect(table.total).toBe(1);
    const options = await (
      await fetch(base + "/api/product-options?q=SKU_&unit=PKT", { headers })
    ).json();
    expect(options[0].id).toBe(product);
    expect(
      (
        await fetch(base + "/api/products", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(base + "/api/purchases", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(400);
    const raw = new Uint8Array([27, 64, 65, 66, 67, 10, 0, 255]);
    const ingestHeaders = {
      Authorization: "Bearer test-connector",
      "Content-Type": "application/octet-stream",
    };
    const first = await (
      await fetch(base + "/api/ingest", {
        method: "POST",
        headers: ingestHeaders,
        body: raw,
      })
    ).json();
    const retry = await (
      await fetch(base + "/api/ingest", {
        method: "POST",
        headers: ingestHeaders,
        body: raw,
      })
    ).json();
    expect(retry.id).toBe(first.id);
    expect(retry.duplicate).toBe(true);
    const saved = new Uint8Array(
      await (
        await fetch(base + `/api/bills/${first.id}/raw`, { headers })
      ).arrayBuffer(),
    );
    expect(saved).toEqual(raw);
    expect(
      (
        await fetch(base + `/api/bills/${first.id}/accept`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(409);
    const captured = await (
      await fetch(base + `/api/bills/${first.id}`, { headers })
    ).json();
    expect(captured.revision).toBe(1);
    expect(
      (
        await fetch(base + `/api/bills/${first.id}/accept`, {
          method: "POST",
          headers,
          body: JSON.stringify({ revision: captured.revision }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(base + `/api/bills/${first.id}/reject`, {
          method: "POST",
          headers: { ...headers, Origin: "http://evil.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(base + "/api/logout", { method: "POST", headers })).status,
    ).toBe(200);
    expect((await fetch(base + "/api/products", { headers })).status).toBe(401);
  } finally {
    process.kill();
    await process.exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
