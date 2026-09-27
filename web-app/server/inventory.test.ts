import { openTestStore } from "./test-store";
import { mapAsync } from "./db";
import { test, expect, afterEach } from "bun:test";
import { Store } from "./store";
const stores: Store[] = [];
const fresh = async () => {
  const s = await openTestStore();
  stores.push(s);
  return s;
};
afterEach(async () => {
  await mapAsync(stores, async (s) => await s.db.close());
  stores.length = 0;
});
async function receive(
  s: Store,
  productId: string,
  quantity: number,
  costPrice: number | null,
  mrp: number | null,
  received = "2026-09-22",
) {
  const p = await s.inventory.savePurchase({
    number: crypto.randomUUID(),
    supplier: "Test supplier",
    received,
    lines: [{ productId, quantity, costPrice, mrp }],
  });
  return await s.inventory.postPurchase(p.id);
}
async function sale(
  s: Store,
  productId: string,
  quantity: number,
  mrp: number | null,
  number = "S1",
  extra: any[] = [],
) {
  const { id } = await s.ingest(Buffer.from(number), number, "", "Test");
  await s.saveBill(id, {
    number,
    shop: "Test",
    items: [{ productId, quantity, mrp, sellingPrice: 18 }, ...extra],
  });
  return id;
}
test("automatic matching keeps flavour, weight, unit and ambiguous SKUs distinct", async () => {
  const s = await fresh();
  const p = await s.saveProduct({
    sku: "C1",
    name: "Vanilla Cake 30G X 18 X12EA",
    unit: "PKT",
  });
  await s.saveProduct({ sku: "C2", name: "Vanilla Cake 310G", unit: "PKT" });
  await s.saveProduct({ sku: "C3", name: "Chocolate Cake 30G", unit: "PKT" });
  expect(await s.inventory.match(" vanilla   cake 30 g ", "pkt")).toBe(p);
  expect(await s.inventory.match("Vanilla Cake 30G", "DZ")).toBe("");
  expect(await s.inventory.match("Vanilla Cake 300G", "PKT")).toBe("");
  const duplicate = await s.saveProduct({
    sku: "C4",
    name: "VANILLA CAKE 30G",
    unit: "PKT",
    stock: 100,
    mrp: 50,
  });
  expect(await s.inventory.match("Vanilla Cake 30G", "PKT")).toBe("");
  await s.db
    .query("INSERT INTO product_aliases VALUES (?,?,?)")
    .run("VANILLA CAKE 30G", "PKT", duplicate!);
  expect(await s.inventory.match("Vanilla Cake 30G", "PKT")).toBe(duplicate);
  await s.archive(duplicate!);
  expect(await s.inventory.match("Vanilla Cake 30G", "PKT")).toBe(p);
});
test("multi-item receiving creates stable SKUs only on posting and posts once", async () => {
  const s = await fresh(),
    p = await s.inventory.savePurchase({
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
  expect(await s.products()).toHaveLength(0);
  const posted = await s.inventory.postPurchase(p.id);
  await s.inventory.postPurchase(p.id);
  expect((await s.products()).map((p) => p.stock)).toEqual([10, 5]);
  expect(posted.lines[0].productId).toBeTruthy();
  expect((await s.products())[0].sku).toBe("P000001");
  expect((await s.products())[1].lots[0].costPrice).toBeNull();
  await expect(
    s.inventory.savePurchase({ ...p, note: "Changed" }, p.id),
  ).rejects.toThrow("cannot be edited");
  await expect(s.inventory.deletePurchase(p.id)).rejects.toThrow(
    "cannot be deleted",
  );
  await expect(
    s.inventory.savePurchase({ ...p, supplier: " test ", number: "in1" }),
  ).rejects.toThrow("already exists");
});
test("MRP matching uses oldest matching batches and retains distinct costs", async () => {
  const s = await fresh(),
    id = (await s.saveProduct({ sku: "P1", name: "Item", unit: "PKT" }))!;
  await receive(s, id, 100, 11, 25, "2026-09-19");
  await receive(s, id, 3, 10, 20, "2026-09-20");
  await receive(s, id, 4, 12, 20, "2026-09-21");
  const b = await sale(s, id, 5, 20);
  expect((await s.inventory.plan(await s.bill(b))).issues).toHaveLength(0);
  await s.decide(b, "accepted");
  await s.decide(b, "accepted");
  expect((await s.products())[0].stock).toBe(102);
  expect((await s.inventory.lots(id)).map((l) => l.remaining)).toEqual([
    100, 0, 2,
  ]);
  expect(
    await s.db
      .query(
        "SELECT quantity,cost,mrp,selling_price FROM allocations ORDER BY rowid",
      )
      .all(),
  ).toEqual([
    { quantity: 3000, cost: 1000, mrp: 2000, selling_price: 1800 },
    { quantity: 2000, cost: 1200, mrp: 2000, selling_price: 1800 },
  ]);
  await expect(
    s.inventory.setLotPrices(id, (await s.inventory.lots(id))[1].id, {
      costPrice: 15,
      mrp: 20,
    }),
  ).rejects.toThrow("Used batches");
});
test("wrong-MRP stock cannot cover a shortage; repeated lines cannot oversell", async () => {
  const s = await fresh(),
    id = (await s.saveProduct({ sku: "P1", name: "Item", unit: "PKT" }))!;
  await receive(s, id, 100, 11, 25);
  await receive(s, id, 7, 12, 20);
  const b = await sale(s, id, 4, 20, "S1", [
    { productId: id, quantity: 4, mrp: 20 },
  ]);
  expect((await s.inventory.plan(await s.bill(b))).issues[0].shortage).toBe(1);
  await expect(s.decide(b, "accepted")).rejects.toThrow("Not enough stock");
  expect((await s.products())[0].stock).toBe(107);
  expect((await s.inventory.lots(id)).map((l) => l.remaining)).toEqual([
    100, 7,
  ]);
  expect(await s.db.query("SELECT count(*) n FROM allocations").get()).toEqual({
    n: 0,
  });
  expect((await s.bill(b)).status).toBe("pending");
});
test("receiving failure rolls back newly created products, lots and movements", async () => {
  const s = await fresh(),
    id = (await s.saveProduct({ sku: "P1", name: "Existing", unit: "PKT" }))!;
  const p = await s.inventory.savePurchase({
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
  await s.archive(id);
  await expect(s.inventory.postPurchase(p.id)).rejects.toThrow(
    "no longer available",
  );
  expect(await s.products()).toHaveLength(0);
  expect(await s.db.query("SELECT count(*) n FROM stock_lots").get()).toEqual({
    n: 0,
  });
  expect((await s.inventory.purchase(p.id)).status).toBe("draft");
});
test("unknown MRP needs identification and stock units cannot silently change", async () => {
  const s = await fresh(),
    id = (await s.saveProduct({
      sku: "P1",
      name: "Item",
      unit: "PKT",
      stock: 5,
    }))!,
    lot = (await s.inventory.lots(id))[0];
  const b = await sale(s, id, 1, 20);
  expect((await s.inventory.plan(await s.bill(b))).issues[0].shortage).toBe(1);
  await s.inventory.setLotPrices(id, lot.id, { costPrice: 12, mrp: 20 });
  await s.decide(b, "accepted");
  await expect(
    s.saveProduct({ sku: "P1", name: "Item", unit: "BOX" }, id),
  ).rejects.toThrow("original unit");
  await expect(
    s.saveProduct({ sku: "p1", name: "Duplicate", unit: "PKT" }),
  ).rejects.toThrow("SKU already exists");
});
test("adjustments respect MRP and keep lot totals equal to stock", async () => {
  const s = await fresh(),
    id = (await s.saveProduct({ sku: "P1", name: "Item", unit: "PKT" }))!;
  await receive(s, id, 5, 10, 20);
  await receive(s, id, 6, 15, 30);
  await expect(
    s.adjust(id, { quantity: -2, reason: "Damaged" }),
  ).rejects.toThrow("Choose an MRP");
  await s.adjust(id, { quantity: -2, reason: "Damaged", mrp: 20 });
  await s.adjust(id, { quantity: 1, reason: "Count correction", mrp: 30 });
  expect(
    (await s.inventory.lots(id)).reduce((sum, l) => sum + l.remaining, 0),
  ).toBe((await s.products())[0].stock);
  expect((await s.products())[0].stock).toBe(10);
});
test("manual lines need an MRP when variants coexist; draft deletion has no stock effect", async () => {
  const s = await fresh(),
    id = (await s.saveProduct({ sku: "P1", name: "Item", unit: "PKT" }))!;
  await receive(s, id, 3, 10, 20);
  await receive(s, id, 3, 20, 30);
  const b = await sale(s, id, 1, null);
  expect((await s.inventory.plan(await s.bill(b))).issues[0].kind).toBe(
    "price",
  );
  const p = await s.inventory.savePurchase({
    number: "DRAFT",
    supplier: "Test",
    received: "2026-09-22",
    lines: [{ productId: id, quantity: 9, costPrice: 10, mrp: 20 }],
  });
  await s.inventory.deletePurchase(p.id);
  expect((await s.products())[0].stock).toBe(6);
});
