import { openTestStore } from "./test-store";
import { test, expect, describe, afterEach } from "bun:test";
import { Store } from "./store";
const stores: Store[] = [];
async function fresh() {
  const s = await openTestStore();
  stores.push(s);
  return s;
}
afterEach(async () => {
  for (const s of stores) await s.db.close();
  stores.length = 0;
});
async function item(s: Store, sku: string, stock = 10) {
  return (await s.saveProduct({ sku, name: sku, stock, unit: "pcs" }))!;
}
async function bill(s: Store, items: any[], number = "B1") {
  const { id } = await s.ingest(
    new TextEncoder().encode("Original " + number),
    number,
    "text/plain",
    "Test",
  );
  await s.saveBill(id, { number, shop: "Test shop", items });
  return id;
}
describe("Stock ledger", () => {
  test("stale bill saves and decisions cannot overwrite another review", async () => {
    const s = await fresh(),
      p = await item(s, "REV"),
      b = await bill(s, [{ productId: p, quantity: 2 }]);
    const original = await s.bill(b);
    const saved = await s.saveBill(b, { ...original, shop: "Updated shop" });
    expect(saved.revision).toBe(original.revision + 1);
    await expect(
      s.saveBill(b, { ...original, shop: "Stale shop" }),
    ).rejects.toThrow("another window");
    await expect(s.decide(b, "accepted", original.revision)).rejects.toThrow(
      "another window",
    );
    await expect(s.decide(b, "rejected", original.revision)).rejects.toThrow(
      "another window",
    );
    expect((await s.bill(b)).shop).toBe("Updated shop");
    expect((await s.products())[0].stock).toBe(10);
    await s.decide(b, "accepted", saved.revision);
    expect((await s.bill(b)).revision).toBe(saved.revision + 1);
    expect(await s.decide(b, "accepted", saved.revision)).toEqual({
      unchanged: true,
    });
    expect((await s.products())[0].stock).toBe(8);
  });
  test("acceptance deducts once, duplicate print does not create another bill", async () => {
    const s = await fresh(),
      p = await item(s, "A"),
      b = await bill(s, [{ productId: p, quantity: 3 }]);
    expect((await s.products())[0].stock).toBe(10);
    await s.decide(b, "accepted");
    await s.decide(b, "accepted");
    expect((await s.products())[0].stock).toBe(7);
    expect(await s.history(p)).toHaveLength(2);
    expect(
      await s.ingest(
        new TextEncoder().encode("Original B1"),
        "reprint",
        "text/plain",
        "Tablet",
      ),
    ).toEqual({ id: b, duplicate: true });
    expect(await s.bills()).toHaveLength(1);
  });
  test("shortage leaves every item and bill unchanged", async () => {
    const s = await fresh(),
      p = await item(s, "A"),
      q = await item(s, "B", 2),
      b = await bill(s, [
        { productId: p, quantity: 4 },
        { productId: q, quantity: 3 },
      ]);
    await expect(s.decide(b, "accepted")).rejects.toThrow("Not enough stock");
    expect((await s.products()).map((p) => p.stock)).toEqual([10, 2]);
    expect((await s.bill(b)).status).toBe("pending");
    expect(await s.history(p)).toHaveLength(1);
  });
  test("repeated product lines are combined before checking stock", async () => {
    const s = await fresh(),
      p = await item(s, "A", 5),
      b = await bill(s, [
        { productId: p, quantity: 3 },
        { productId: p, quantity: 3 },
      ]);
    await expect(s.decide(b, "accepted")).rejects.toThrow("Not enough stock");
    expect((await s.products())[0].stock).toBe(5);
  });
  test("rejecting never changes stock; closed bills cannot change", async () => {
    const s = await fresh(),
      p = await item(s, "A"),
      b = await bill(s, [{ productId: p, quantity: 2 }]);
    await s.decide(b, "rejected");
    expect((await s.products())[0].stock).toBe(10);
    await expect(s.decide(b, "accepted")).rejects.toThrow("already closed");
    await expect(
      s.saveBill(b, { number: "X", shop: "X", items: [] }),
    ).rejects.toThrow("already closed");
  });
  test("raw binary bytes survive ingestion unchanged", async () => {
    const s = await fresh(),
      bytes = new Uint8Array([0, 27, 64, 255, 128, 10, 13]);
    const b = await s.ingest(
      bytes,
      "raw",
      "application/octet-stream",
      "Tablet",
    );
    expect(new Uint8Array((await s.bill(b.id)).raw)).toEqual(bytes);
  });
  test("fractional stock, adjustments and bill quantities are rejected without ledger changes", async () => {
    const s = await fresh(),
      p = await item(s, "A", 3);
    await expect(item(s, "B", 0.3)).rejects.toThrow("whole-number");
    await expect(
      s.adjust(p, { quantity: 0.5, reason: "Count" }),
    ).rejects.toThrow("whole-number");
    await expect(
      s.adjust(p, { quantity: -0.5, reason: "Count" }),
    ).rejects.toThrow("whole-number");
    await expect(bill(s, [{ productId: p, quantity: 0.1 }])).rejects.toThrow(
      "whole-number",
    );
    expect((await s.products())[0].stock).toBe(3);
  });
  test("duplicate invoice numbers are rejected", async () => {
    const s = await fresh(),
      p = await item(s, "A");
    await bill(s, [{ productId: p, quantity: 1 }]);
    const b = await s.ingest(
      new TextEncoder().encode("Different bytes"),
      "b2",
      "text/plain",
      "Test",
    );
    await expect(
      s.saveBill(b.id, { number: "B1", shop: "Other shop", items: [] }),
    ).rejects.toThrow();
  });
  test("archiving preserves audit and prevents pending acceptance", async () => {
    const s = await fresh(),
      p = await item(s, "A"),
      b = await bill(s, [{ productId: p, quantity: 1 }]);
    await s.archive(p);
    expect(await s.products()).toHaveLength(0);
    expect(await s.history(p)).toHaveLength(1);
    await expect(s.decide(b, "accepted")).rejects.toThrow(
      "no longer available",
    );
  });
  test("adjustments are audited and cannot overdraw", async () => {
    const s = await fresh(),
      p = await item(s, "A", 3);
    await s.adjust(p, { quantity: 2, reason: "Delivery" });
    await s.adjust(p, { quantity: -1, reason: "Damaged" });
    expect((await s.products())[0].stock).toBe(4);
    expect(await s.history(p)).toHaveLength(3);
    await expect(s.adjust(p, { quantity: -5, reason: "Bad" })).rejects.toThrow(
      "Not enough stock",
    );
    expect((await s.products())[0].stock).toBe(4);
  });
  test("editing item metadata cannot overwrite stock", async () => {
    const s = await fresh(),
      p = await item(s, "A", 8);
    await s.saveProduct(
      { sku: "AA", name: "Renamed", unit: "pcs", minimum: 2, stock: 99 },
      p,
    );
    expect((await s.products())[0].stock).toBe(8);
  });
  test("unreviewed bills cannot be accepted", async () => {
    const s = await fresh(),
      b = await s.ingest(
        new TextEncoder().encode("New"),
        "new",
        "text/plain",
        "Tablet",
      );
    await expect(s.decide(b.id, "accepted")).rejects.toThrow("Add bill number");
  });
});

test("concurrent duplicate prints and competing approvals cannot double deduct stock", async () => {
  const s = await fresh();
  const productId = await item(s, "PARALLEL", 5);
  const raw = new TextEncoder().encode("same captured print");
  const [a, b] = await Promise.all([
    s.ingest(raw, "a", "", "phone"),
    s.ingest(raw, "b", "", "phone"),
  ]);
  expect(a.id).toBe(b.id);
  expect([a, b].filter((r) => r.duplicate)).toHaveLength(1);
  const first = await bill(s, [{ productId, quantity: 4 }], "CONCURRENT1");
  const second = await bill(s, [{ productId, quantity: 4 }], "CONCURRENT2");
  const result = await Promise.allSettled([
    s.decide(first, "accepted"),
    s.decide(second, "accepted"),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await s.product(productId)).stock).toBe(1000);
  expect((await s.inventory.lots(productId))[0].remaining).toBe(1);
});
