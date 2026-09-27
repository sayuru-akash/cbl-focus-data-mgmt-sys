import { openTestStore } from "./test-store";
import { mapAsync } from "./db";
import { test, expect, afterEach } from "bun:test";
import { Store } from "./store";
import { Intakes } from "./intake";
import { grid } from "./grid";
const stores: Store[] = [];
async function fresh() {
  const s = await openTestStore();
  await Intakes.open(s);
  stores.push(s);
  return s;
}
afterEach(async () => {
  await mapAsync(stores, async (s) => await s.db.close());
  stores.length = 0;
});
test("table search escapes SQL wildcards and sorting cannot inject SQL", async () => {
  const s = await fresh();
  const product = await s.saveProduct({
    sku: "AA_01",
    name: "100% Cake",
    unit: "PKT",
    stock: 2,
  });
  await s.db
    .query("INSERT INTO supplier_products VALUES (?,?,?)")
    .run("TIN1", "NEW-CODE", product!);
  await s.saveProduct({
    sku: "AB201",
    name: "1000 Cake",
    unit: "PKT",
    stock: 3,
  });
  expect(
    (await grid(s, "products", new URLSearchParams({ q: "100%" }))).total,
  ).toBe(1);
  expect(
    (await grid(s, "products", new URLSearchParams({ q: "AA_" }))).total,
  ).toBe(1);
  expect(
    (await grid(s, "products", new URLSearchParams({ q: "NEW-CODE" }))).total,
  ).toBe(1);
  expect(
    (await grid(s, "products", new URLSearchParams({ q: "cake 100%" }))).total,
  ).toBe(1);
  expect(
    (await grid(s, "products", new URLSearchParams({ q: "Cake AA_01" }))).total,
  ).toBe(1);
  await expect(
    grid(
      s,
      "products",
      new URLSearchParams({ sort: "name; DROP TABLE products" }),
    ),
  ).rejects.toThrow("Invalid sort");
  expect(await s.products()).toHaveLength(2);
});
test("server pagination is stable, bounded, and filters before counting", async () => {
  const s = await fresh();
  for (let i = 0; i < 23; i++)
    await s.saveProduct({
      sku: `P${i}`,
      name: `Item ${String(i).padStart(2, "0")}`,
      unit: "PKT",
      stock: i,
      minimum: 5,
    });
  const first = await grid(
      s,
      "products",
      new URLSearchParams({ size: "10", dir: "asc" }),
    ),
    second = await grid(
      s,
      "products",
      new URLSearchParams({ page: "2", size: "10", dir: "asc" }),
    );
  expect(first.rows).toHaveLength(10);
  expect(first.total).toBe(23);
  expect(
    new Set([...first.rows, ...second.rows].map((r: any) => r.id)).size,
  ).toBe(20);
  expect(
    (await grid(s, "products", new URLSearchParams({ status: "low" }))).total,
  ).toBe(6);
  expect(
    (await grid(s, "products", new URLSearchParams({ page: "99" }))).page,
  ).toBe(3);
  await expect(
    grid(s, "products", new URLSearchParams({ size: "100000" })),
  ).rejects.toThrow();
});
test("bill status, dates and customer scope remain combined", async () => {
  const s = await fresh();
  const p = await s.saveProduct({
    sku: "P",
    name: "P",
    stock: 10,
    unit: "PKT",
  });
  for (let i = 0; i < 3; i++) {
    const { id } = await s.ingest(
      new TextEncoder().encode(`Bill ${i}`),
      "print",
      "text/plain",
      "test",
    );
    await s.saveBill(id, {
      number: `B${i}`,
      shop: "Shop",
      items: [{ productId: p, quantity: 1 }],
    });
    if (i === 0) await s.decide(id, "accepted");
  }
  expect(
    (await grid(s, "bills", new URLSearchParams({ status: "pending" }))).total,
  ).toBe(2);
  expect(
    (await grid(s, "bills", new URLSearchParams({ to: "2000-01-01" }))).total,
  ).toBe(0);
  expect(
    (await grid(s, "bills", new URLSearchParams({ customer: "missing" })))
      .total,
  ).toBe(0);
  await expect(
    grid(
      s,
      "bills",
      new URLSearchParams({ from: "2026-09-28", to: "2026-09-01" }),
    ),
  ).rejects.toThrow();
});
test("customer dates and counts use approved bills, excluding later pending prints", async () => {
  const s = await fresh();
  await s.db
    .query("INSERT INTO customers VALUES (?,?,?,?,?,?,?)")
    .run("C1", "123", "Shop", "Road", "", "2026-09-27", "2026-09-27");
  const p = await s.saveProduct({
    sku: "ITEM",
    name: "Item",
    stock: 10,
    unit: "PKT",
  });
  for (const [number, date, accepted] of [
    ["1", "2026-09-19", true],
    ["2", "2026-09-27", false],
  ] as const) {
    const { id } = await s.ingest(Buffer.from(number), number, "", "Test");
    await s.saveBill(id, {
      number,
      shop: "Shop",
      items: [{ productId: p, quantity: 1 }],
    });
    await s.db
      .query("UPDATE bills SET customer_id=?,receipt=? WHERE id=?")
      .run("C1", JSON.stringify({ date }), id);
    if (accepted) await s.decide(id, "accepted");
  }
  const row = (await grid(s, "customers", new URLSearchParams()))
    .rows[0] as any;
  expect(row.last_seen).toBe("2026-09-19");
  expect(row.bill_count).toBe(1);
  expect(
    (await grid(s, "customers", new URLSearchParams({ from: "2026-09-20" })))
      .total,
  ).toBe(0);
});
test("batch and movement tables cannot cross product scope", async () => {
  const s = await fresh();
  const p = await s.saveProduct({
    sku: "A",
    name: "Same name",
    unit: "PKT",
    stock: 12,
    mrp: 100,
    costPrice: 80,
  });
  await s.saveProduct({
    sku: "B",
    name: "Same name",
    unit: "PKT",
    stock: 24,
    mrp: 120,
    costPrice: 90,
  });
  const lots = await grid(s, "lots", new URLSearchParams({ product: p! }));
  expect(lots.total).toBe(1);
  expect((lots.rows[0] as any).mrp).toBe(100);
  expect(
    (await grid(s, "movements", new URLSearchParams({ product: p! }))).total,
  ).toBe(1);
  await expect(grid(s, "lots", new URLSearchParams())).rejects.toThrow(
    "Choose an item",
  );
});
test("stock-in table combines old receipts and new photo drafts without duplicate linked receipts", async () => {
  const s = await fresh();
  const p = await s.inventory.savePurchase({
    number: "R1",
    supplier: "Supplier",
    received: "2026-09-01",
    note: "",
    lines: [
      {
        newProduct: { sku: "A", name: "A", unit: "PKT" },
        quantity: 12,
        mrp: 100,
        costPrice: 60,
      },
    ],
  });
  await s.db
    .query(
      "INSERT INTO intakes(id,status,draft,created,purchase_id) VALUES (?,?,?,?,?)",
    )
    .run(
      "I1",
      "draft",
      JSON.stringify({
        number: "R1",
        supplier: "Supplier",
        date: "2026-09-01",
        total: 720,
      }),
      "2026-09-01",
      p.id,
    );
  const result = await grid(s, "invoices", new URLSearchParams());
  expect(result.total).toBe(1);
  expect((result.rows[0] as any).kind).toBe("invoice");
});
