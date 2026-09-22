import { test, expect, afterEach } from "bun:test";
import { Store } from "./store";
const stores: Store[] = [];
const fresh = () => {
  const s = new Store(":memory:");
  stores.push(s);
  return s;
};
afterEach(() => {
  stores.forEach((s) => s.db.close());
  stores.length = 0;
});
function receive(
  s: Store,
  productId: string,
  quantity: number,
  costPrice: number | null,
  mrp: number | null,
  received = "2026-09-22",
) {
  const p = s.inventory.savePurchase({
    number: crypto.randomUUID(),
    supplier: "Test supplier",
    received,
    lines: [{ productId, quantity, costPrice, mrp }],
  });
  return s.inventory.postPurchase(p.id);
}
function sale(
  s: Store,
  productId: string,
  quantity: number,
  mrp: number | null,
  number = "S1",
  extra: any[] = [],
) {
  const { id } = s.ingest(Buffer.from(number), number, "", "Test");
  s.saveBill(id, {
    number,
    shop: "Test",
    items: [{ productId, quantity, mrp, sellingPrice: 18 }, ...extra],
  });
  return id;
}
test("multi-item receiving creates stable SKUs only on posting and posts once", () => {
  const s = fresh(),
    p = s.inventory.savePurchase({
      number: "IN1",
      supplier: "Test",
      received: "2026-09-22",
      lines: [
        {
          productId: "",
          newProduct: { sku: "", name: "New item", unit: "PKT" },
          quantity: 10,
          costPrice: 12,
          mrp: 20,
        },
        {
          productId: "",
          newProduct: { sku: "ABC", name: "Second", unit: "PKT" },
          quantity: 5,
          costPrice: null,
          mrp: 30,
        },
      ],
    });
  expect(s.products()).toHaveLength(0);
  const posted = s.inventory.postPurchase(p.id);
  s.inventory.postPurchase(p.id);
  expect(s.products().map((p) => p.stock)).toEqual([10, 5]);
  expect(posted.lines[0].productId).toBeTruthy();
  expect(s.products()[0].sku).toBe("P000001");
  expect(s.products()[1].lots[0].costPrice).toBeNull();
  expect(() =>
    s.inventory.savePurchase({ ...p, note: "Changed" }, p.id),
  ).toThrow("cannot be edited");
  expect(() => s.inventory.deletePurchase(p.id)).toThrow("cannot be deleted");
  expect(() =>
    s.inventory.savePurchase({ ...p, supplier: " test ", number: "in1" }),
  ).toThrow("already exists");
});
test("MRP matching uses oldest matching batches and retains distinct costs", () => {
  const s = fresh(),
    id = s.saveProduct({ sku: "P1", name: "Item", unit: "PKT" })!;
  receive(s, id, 100, 11, 25, "2026-09-19");
  receive(s, id, 3, 10, 20, "2026-09-20");
  receive(s, id, 4, 12, 20, "2026-09-21");
  const b = sale(s, id, 5, 20);
  expect(s.inventory.plan(s.bill(b)).issues).toHaveLength(0);
  s.decide(b, "accepted");
  s.decide(b, "accepted");
  expect(s.products()[0].stock).toBe(102);
  expect(s.inventory.lots(id).map((l) => l.remaining)).toEqual([100, 0, 2]);
  expect(
    s.db
      .query(
        "SELECT quantity,cost,mrp,selling_price FROM allocations ORDER BY rowid",
      )
      .all(),
  ).toEqual([
    { quantity: 3000, cost: 1000, mrp: 2000, selling_price: 1800 },
    { quantity: 2000, cost: 1200, mrp: 2000, selling_price: 1800 },
  ]);
  expect(() =>
    s.inventory.setLotPrices(id, s.inventory.lots(id)[1].id, {
      costPrice: 15,
      mrp: 20,
    }),
  ).toThrow("Used batches");
});
test("wrong-MRP stock cannot cover a shortage; repeated lines cannot oversell", () => {
  const s = fresh(),
    id = s.saveProduct({ sku: "P1", name: "Item", unit: "PKT" })!;
  receive(s, id, 100, 11, 25);
  receive(s, id, 7, 12, 20);
  const b = sale(s, id, 4, 20, "S1", [{ productId: id, quantity: 4, mrp: 20 }]);
  expect(s.inventory.plan(s.bill(b)).issues[0].shortage).toBe(1);
  expect(() => s.decide(b, "accepted")).toThrow("Not enough stock");
  expect(s.products()[0].stock).toBe(107);
  expect(s.inventory.lots(id).map((l) => l.remaining)).toEqual([100, 7]);
  expect(s.db.query("SELECT count(*) n FROM allocations").get()).toEqual({
    n: 0,
  });
  expect(s.bill(b).status).toBe("pending");
});
test("receiving failure rolls back newly created products, lots and movements", () => {
  const s = fresh(),
    id = s.saveProduct({ sku: "P1", name: "Existing", unit: "PKT" })!;
  const p = s.inventory.savePurchase({
    number: "X",
    supplier: "Test",
    received: "2026-09-22",
    lines: [
      {
        newProduct: { sku: "NEW", name: "New", unit: "PKT" },
        quantity: 10,
        mrp: 20,
        costPrice: 10,
      },
      { productId: id, quantity: 5, mrp: 20, costPrice: 10 },
    ],
  });
  s.archive(id);
  expect(() => s.inventory.postPurchase(p.id)).toThrow("no longer available");
  expect(s.products()).toHaveLength(0);
  expect(s.db.query("SELECT count(*) n FROM stock_lots").get()).toEqual({
    n: 0,
  });
  expect(s.inventory.purchase(p.id).status).toBe("draft");
});
test("unknown MRP needs identification and stock units cannot silently change", () => {
  const s = fresh(),
    id = s.saveProduct({ sku: "P1", name: "Item", unit: "PKT", stock: 5 })!,
    lot = s.inventory.lots(id)[0];
  const b = sale(s, id, 1, 20);
  expect(s.inventory.plan(s.bill(b)).issues[0].shortage).toBe(1);
  s.inventory.setLotPrices(id, lot.id, { costPrice: 12, mrp: 20 });
  s.decide(b, "accepted");
  expect(() =>
    s.saveProduct({ sku: "P1", name: "Item", unit: "BOX" }, id),
  ).toThrow("original unit");
  expect(() =>
    s.saveProduct({ sku: "p1", name: "Duplicate", unit: "PKT" }),
  ).toThrow("SKU already exists");
});
test("adjustments respect MRP and keep lot totals equal to stock", () => {
  const s = fresh(),
    id = s.saveProduct({ sku: "P1", name: "Item", unit: "PKT" })!;
  receive(s, id, 5, 10, 20);
  receive(s, id, 6, 15, 30);
  expect(() => s.adjust(id, { quantity: -2, reason: "Damaged" })).toThrow(
    "Choose an MRP",
  );
  s.adjust(id, { quantity: -2, reason: "Damaged", mrp: 20 });
  s.adjust(id, { quantity: 1, reason: "Count correction", mrp: 30 });
  expect(s.inventory.lots(id).reduce((sum, l) => sum + l.remaining, 0)).toBe(
    s.products()[0].stock,
  );
  expect(s.products()[0].stock).toBe(10);
});
test("manual lines need an MRP when variants coexist; draft deletion has no stock effect", () => {
  const s = fresh(),
    id = s.saveProduct({ sku: "P1", name: "Item", unit: "PKT" })!;
  receive(s, id, 3, 10, 20);
  receive(s, id, 3, 20, 30);
  const b = sale(s, id, 1, null);
  expect(s.inventory.plan(s.bill(b)).issues[0].kind).toBe("price");
  const p = s.inventory.savePurchase({
    number: "DRAFT",
    supplier: "Test",
    received: "2026-09-22",
    lines: [{ productId: id, quantity: 9, costPrice: 10, mrp: 20 }],
  });
  s.inventory.deletePurchase(p.id);
  expect(s.products()[0].stock).toBe(6);
});
