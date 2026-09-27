import { test, expect, afterEach } from "bun:test";
import { Store } from "./store";
import { Intakes } from "./intake";
import { grid } from "./grid";
const stores: Store[] = [];
function fresh() {
  const s = new Store(":memory:");
  new Intakes(s);
  stores.push(s);
  return s;
}
afterEach(() => {
  stores.forEach((s) => s.db.close());
  stores.length = 0;
});
test("table search escapes SQL wildcards and sorting cannot inject SQL", () => {
  const s = fresh();
  const product = s.saveProduct({
    sku: "AA_01",
    name: "100% Cake",
    unit: "PKT",
    stock: 2,
  });
  s.db
    .query("INSERT INTO supplier_products VALUES (?,?,?)")
    .run("TIN1", "NEW-CODE", product!);
  s.saveProduct({ sku: "AB201", name: "1000 Cake", unit: "PKT", stock: 3 });
  expect(grid(s, "products", new URLSearchParams({ q: "100%" })).total).toBe(1);
  expect(grid(s, "products", new URLSearchParams({ q: "AA_" })).total).toBe(1);
  expect(
    grid(s, "products", new URLSearchParams({ q: "NEW-CODE" })).total,
  ).toBe(1);
  expect(
    grid(s, "products", new URLSearchParams({ q: "cake 100%" })).total,
  ).toBe(1);
  expect(
    grid(s, "products", new URLSearchParams({ q: "Cake AA_01" })).total,
  ).toBe(1);
  expect(() =>
    grid(
      s,
      "products",
      new URLSearchParams({ sort: "name; DROP TABLE products" }),
    ),
  ).toThrow("Invalid sort");
  expect(s.products()).toHaveLength(2);
});
test("server pagination is stable, bounded, and filters before counting", () => {
  const s = fresh();
  for (let i = 0; i < 23; i++)
    s.saveProduct({
      sku: `P${i}`,
      name: `Item ${String(i).padStart(2, "0")}`,
      unit: "PKT",
      stock: i,
      minimum: 5,
    });
  const first = grid(
      s,
      "products",
      new URLSearchParams({ size: "10", dir: "asc" }),
    ),
    second = grid(
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
    grid(s, "products", new URLSearchParams({ status: "low" })).total,
  ).toBe(6);
  expect(grid(s, "products", new URLSearchParams({ page: "99" })).page).toBe(3);
  expect(() =>
    grid(s, "products", new URLSearchParams({ size: "100000" })),
  ).toThrow();
});
test("bill status, dates and customer scope remain combined", () => {
  const s = fresh();
  const p = s.saveProduct({ sku: "P", name: "P", stock: 10, unit: "PKT" });
  for (let i = 0; i < 3; i++) {
    const { id } = s.ingest(
      new TextEncoder().encode(`Bill ${i}`),
      "print",
      "text/plain",
      "test",
    );
    s.saveBill(id, {
      number: `B${i}`,
      shop: "Shop",
      items: [{ productId: p, quantity: 1 }],
    });
    if (i === 0) s.decide(id, "accepted");
  }
  expect(
    grid(s, "bills", new URLSearchParams({ status: "pending" })).total,
  ).toBe(2);
  expect(
    grid(s, "bills", new URLSearchParams({ to: "2000-01-01" })).total,
  ).toBe(0);
  expect(
    grid(s, "bills", new URLSearchParams({ customer: "missing" })).total,
  ).toBe(0);
  expect(() =>
    grid(
      s,
      "bills",
      new URLSearchParams({ from: "2026-09-28", to: "2026-09-01" }),
    ),
  ).toThrow();
});
test("customer dates and counts use approved bills, excluding later pending prints", () => {
  const s = fresh();
  s.db
    .query("INSERT INTO customers VALUES (?,?,?,?,?,?,?)")
    .run("C1", "123", "Shop", "Road", "", "2026-09-27", "2026-09-27");
  const p = s.saveProduct({ sku: "ITEM", name: "Item", stock: 10, unit: "PKT" });
  for (const [number, date, accepted] of [
    ["1", "2026-09-19", true],
    ["2", "2026-09-27", false],
  ] as const) {
    const { id } = s.ingest(Buffer.from(number), number, "", "Test");
    s.saveBill(id, {
      number,
      shop: "Shop",
      items: [{ productId: p, quantity: 1 }],
    });
    s.db
      .query("UPDATE bills SET customer_id=?,receipt=? WHERE id=?")
      .run("C1", JSON.stringify({ date }), id);
    if (accepted) s.decide(id, "accepted");
  }
  const row = grid(s, "customers", new URLSearchParams()).rows[0] as any;
  expect(row.last_seen).toBe("2026-09-19");
  expect(row.bill_count).toBe(1);
  expect(
    grid(s, "customers", new URLSearchParams({ from: "2026-09-20" })).total,
  ).toBe(0);
});
test("batch and movement tables cannot cross product scope", () => {
  const s = fresh();
  const p = s.saveProduct({
    sku: "A",
    name: "Same name",
    unit: "PKT",
    stock: 12,
    mrp: 100,
    costPrice: 80,
  });
  s.saveProduct({
    sku: "B",
    name: "Same name",
    unit: "PKT",
    stock: 24,
    mrp: 120,
    costPrice: 90,
  });
  const lots = grid(s, "lots", new URLSearchParams({ product: p! }));
  expect(lots.total).toBe(1);
  expect((lots.rows[0] as any).mrp).toBe(100);
  expect(grid(s, "movements", new URLSearchParams({ product: p! })).total).toBe(
    1,
  );
  expect(() => grid(s, "lots", new URLSearchParams())).toThrow(
    "Choose an item",
  );
});
test("stock-in table combines old receipts and new photo drafts without duplicate linked receipts", () => {
  const s = fresh();
  const p = s.inventory.savePurchase({
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
  s.db
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
  const result = grid(s, "invoices", new URLSearchParams());
  expect(result.total).toBe(1);
  expect((result.rows[0] as any).kind).toBe("invoice");
});
