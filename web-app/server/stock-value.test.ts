import { test, expect } from "bun:test";
import { openTestStore } from "./test-store";
import { stockValue, stockValueCsv, rdPriceCents } from "./stock-value";
import type { Store } from "./store";
const report = (s: Store, query = "") =>
  stockValue(s, new URLSearchParams(query));
async function receive(
  s: Store,
  productId: string,
  quantity: number,
  costPrice: number | null,
  mrp: number | null = 100,
) {
  const p = await s.inventory.savePurchase({
    supplier: "Test supplier",
    number: crypto.randomUUID(),
    received: "2026-10-01",
    lines: [{ productId, quantity, costPrice, mrp }],
  });
  await s.inventory.postPurchase(p.id);
  return p;
}
async function bill(s: Store, productId: string) {
  const raw = Buffer.from(
    "INVOICE\nDistributor\n................\nBill date : 2026-10-15\nSerial No : 95001\nOUTLET ID : 99\nCustomer :\nExample shop\n................\nSKU UNIT QTY RATE AMOUNT\n 1  SAMPLE MRP 100.00\n PKT 2 90.00 180.00\nGross : 180.00\nNet(Rs) : 180.00\n",
  );
  const { id } = await s.ingest(raw, "sample", "", "Test"),
    b = await s.bill(id);
  await s.saveBill(id, {
    ...b,
    payment_type: "cash",
    items: [
      { productId, quantity: 2, mrp: 100, sellingPrice: 90, sourceLine: 0 },
    ],
  });
  return id;
}
test("RD uses the confirmed gross margin with half-up unit cents, never MRP or selling-rate markup", () => {
  expect(rdPriceCents(40306)).toBe(43200n);
  expect(rdPriceCents(9330)).toBe(10000n);
  expect(rdPriceCents(0)).toBe(0n);
  expect(rdPriceCents(1)).toBe(1n);
  expect(rdPriceCents(10000)).toBe(10718n);
});
test("available stock is valued at each remaining batch cost; different MRPs and costs stay distinct", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({ sku: "A", name: "Sample", unit: "PKT" });
    await receive(s, p, 3, 403.06, 500);
    await receive(s, p, 2, 93.3, 150);
    const r = await report(s);
    expect(r.total).toBe(1);
    expect(r.rows[0]).toMatchObject({
      id: p,
      stock: 5,
      direct: 1395.78,
      rd: 1496,
      unpricedLots: 0,
      balanceMismatch: false,
    });
    expect(r.summary).toMatchObject({
      items: 1,
      direct: 1395.78,
      rd: 1496,
      unpricedLots: 0,
      balanceIssues: 0,
    });
    const zero = await s.saveProduct({
      sku: "ZERO",
      name: "Zero cost",
      unit: "BTL",
    });
    await receive(s, zero, 2, 0, 1000);
    const free = (await report(s, "q=ZERO")).rows[0]!;
    expect(free.direct).toBe(0);
    expect(free.rd).toBe(0);
    const archived = await s.saveProduct({
      sku: "ARCHIVED",
      name: "Archived",
      unit: "BOX",
      stock: 3,
      costPrice: 100,
      mrp: 200,
    });
    await s.db.query("UPDATE products SET archived=1 WHERE id=?").run(archived);
    await s.saveProduct({ sku: "EMPTY", name: "Empty", unit: "PKT" });
    expect((await report(s)).total).toBe(2);
  } finally {
    await s.db.close();
  }
});
test("missing batch costs stay unknown, partial totals and unpriced filters reconcile", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({ name: "Partial", unit: "PKT", sku: "P" });
    await receive(s, p, 2, 93.3);
    await receive(s, p, 3, null);
    const u = await s.saveProduct({
      name: "Unknown",
      unit: "BOX",
      sku: "U",
      stock: 4,
      mrp: 800,
    });
    const r = await report(s);
    expect(r.rows.find((v) => v.id === p)).toMatchObject({
      stock: 5,
      direct: 186.6,
      rd: 200,
      unpricedStock: 3,
      unpricedLots: 1,
    });
    expect(r.rows.find((v) => v.id === u)).toMatchObject({
      direct: null,
      rd: null,
      unpricedStock: 4,
    });
    expect(r.summary).toMatchObject({
      direct: 186.6,
      rd: 200,
      unpricedLots: 2,
      unpricedItems: 2,
    });
    expect((await report(s, "status=priced")).summary).toMatchObject({
      items: 0,
      direct: 0,
      rd: 0,
    });
    expect((await report(s, "status=unpriced")).summary).toEqual(r.summary);
    expect((await report(s, "q=Unknown")).summary).toMatchObject({
      direct: null,
      rd: null,
    });
    await s.db.query("UPDATE products SET stock=stock+1000 WHERE id=?").run(p);
    expect((await report(s, "q=Partial")).summary.balanceIssues).toBe(1);
  } finally {
    await s.db.close();
  }
});
test("search, sorting, pagination and full CSV keep whole-report totals with safe filters", async () => {
  const s = await openTestStore();
  try {
    for (let i = 0; i < 7; i++) {
      const p = await s.saveProduct({
        name: `Sample ${i}`,
        sku: `S${i}`,
        unit: "PKT",
      });
      await receive(s, p, 1, 93.3);
    }
    const r = await report(s, "page=2&size=5&sort=direct&dir=desc");
    expect(r.rows).toHaveLength(2);
    expect(r.summary).toMatchObject({ items: 7, direct: 653.1, rd: 700 });
    const exported = await stockValue(
      s,
      new URLSearchParams("page=2&size=5"),
      new Date(),
      true,
    );
    expect(exported.rows).toHaveLength(7);
    expect(stockValueCsv(exported)).toContain(
      '"TOTAL","","","","653.10","700.00"',
    );
    expect((await report(s, "q=Sample%203")).total).toBe(1);
    expect((await report(s, "q=%25")).total).toBe(0);
    expect((await report(s, "q=Sample%20S3")).rows[0]!.sku).toBe("S3");
    expect((await report(s, "page=99&size=5")).page).toBe(2);
    for (const q of [
      "sort=bad",
      "status=accepted",
      "dir=bad",
      "page=0",
      "size=500",
    ])
      await expect(report(s, q)).rejects.toMatchObject({ status: 400 });
    await s.db
      .query("UPDATE products SET name=? WHERE sku=?")
      .run("=UNSAFE", "S0");
    expect(
      stockValueCsv(
        await stockValue(s, new URLSearchParams("q=S0"), new Date(), true),
      ),
    ).toContain("'=UNSAFE");
  } finally {
    await s.db.close();
  }
});
test("pending bills do not change valuation; acceptance, deletion, receipt and price correction refresh exact batch balances", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({
      sku: "SAMPLE",
      name: "Sample",
      unit: "PKT",
      stock: 10,
      costPrice: 93.3,
      mrp: 100,
    });
    const before = await report(s),
      id = await bill(s, p);
    expect((await report(s)).summary).toEqual(before.summary);
    await s.decide(id, "accepted");
    expect((await report(s)).rows[0]).toMatchObject({
      stock: 8,
      direct: 746.4,
      rd: 800,
    });
    const b = await s.bill(id);
    await s.deleteBill(id, b.revision, "DELETE");
    expect((await report(s)).summary).toEqual(before.summary);
    await receive(s, p, 2, 186.6, 300);
    expect((await report(s)).rows[0]).toMatchObject({
      stock: 12,
      direct: 1306.2,
      rd: 1400,
    });
    const fresh = await s.saveProduct({
      sku: "EDIT",
      name: "Edit price",
      unit: "PKT",
      stock: 1,
      costPrice: 93.3,
      mrp: 100,
    });
    const lot = (await s.inventory.lots(fresh))[0];
    await s.inventory.setLotPrices(fresh, lot.id, {
      costPrice: 186.6,
      mrp: 300,
    });
    expect((await report(s, "q=EDIT")).rows[0]).toMatchObject({
      direct: 186.6,
      rd: 200,
    });
    const movements = await s.db
      .query("SELECT COUNT(*) n FROM movements")
      .get();
    await report(s);
    expect(await s.db.query("SELECT COUNT(*) n FROM movements").get()).toEqual(
      movements,
    );
  } finally {
    await s.db.close();
  }
});
