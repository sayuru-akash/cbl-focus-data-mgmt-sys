import { test, expect, describe, afterEach } from "bun:test";
import { Store } from "./store";
const stores: Store[] = [];
function fresh() {
  const s = new Store(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores) s.db.close();
  stores.length = 0;
});
function item(s: Store, sku: string, stock = 10) {
  return s.saveProduct({ sku, name: sku, stock, unit: "pcs" })!;
}
function bill(s: Store, items: any[], number = "B1") {
  const { id } = s.ingest(
    new TextEncoder().encode("Original " + number),
    number,
    "text/plain",
    "Test",
  );
  s.saveBill(id, { number, shop: "Test shop", items });
  return id;
}

describe("Stock ledger", () => {
  test("acceptance deducts once, duplicate print does not create another bill", () => {
    const s = fresh(),
      p = item(s, "A"),
      b = bill(s, [{ productId: p, quantity: 3 }]);
    expect(s.products()[0].stock).toBe(10);
    s.decide(b, "accepted");
    s.decide(b, "accepted");
    expect(s.products()[0].stock).toBe(7);
    expect(s.history(p)).toHaveLength(2);
    expect(
      s.ingest(
        new TextEncoder().encode("Original B1"),
        "reprint",
        "text/plain",
        "Tablet",
      ),
    ).toEqual({ id: b, duplicate: true });
    expect(s.bills()).toHaveLength(1);
  });
  test("shortage leaves every item and bill unchanged", () => {
    const s = fresh(),
      p = item(s, "A"),
      q = item(s, "B", 2),
      b = bill(s, [
        { productId: p, quantity: 4 },
        { productId: q, quantity: 3 },
      ]);
    expect(() => s.decide(b, "accepted")).toThrow("Not enough stock");
    expect(s.products().map((p) => p.stock)).toEqual([10, 2]);
    expect(s.bill(b).status).toBe("pending");
    expect(s.history(p)).toHaveLength(1);
  });
  test("repeated product lines are combined before checking stock", () => {
    const s = fresh(),
      p = item(s, "A", 5),
      b = bill(s, [
        { productId: p, quantity: 3 },
        { productId: p, quantity: 3 },
      ]);
    expect(() => s.decide(b, "accepted")).toThrow("Not enough stock");
    expect(s.products()[0].stock).toBe(5);
  });
  test("rejecting never changes stock; closed bills cannot change", () => {
    const s = fresh(),
      p = item(s, "A"),
      b = bill(s, [{ productId: p, quantity: 2 }]);
    s.decide(b, "rejected");
    expect(s.products()[0].stock).toBe(10);
    expect(() => s.decide(b, "accepted")).toThrow("already closed");
    expect(() => s.saveBill(b, { number: "X", shop: "X", items: [] })).toThrow(
      "already closed",
    );
  });
  test("raw binary bytes survive ingestion unchanged", () => {
    const s = fresh(),
      bytes = new Uint8Array([0, 27, 64, 255, 128, 10, 13]);
    const b = s.ingest(bytes, "raw", "application/octet-stream", "Tablet");
    expect(new Uint8Array(s.bill(b.id).raw)).toEqual(bytes);
  });
  test("fractional quantities use integer ledger units", () => {
    const s = fresh(),
      p = item(s, "A", 0.3),
      b = bill(s, [{ productId: p, quantity: 0.1 }]);
    s.decide(b, "accepted");
    expect(s.products()[0].stock).toBe(0.2);
  });
  test("duplicate invoice numbers are rejected", () => {
    const s = fresh(),
      p = item(s, "A");
    bill(s, [{ productId: p, quantity: 1 }]);
    const b = s.ingest(
      new TextEncoder().encode("Different bytes"),
      "b2",
      "text/plain",
      "Test",
    );
    expect(() =>
      s.saveBill(b.id, { number: "B1", shop: "Other shop", items: [] }),
    ).toThrow();
  });
  test("archiving preserves audit and prevents pending acceptance", () => {
    const s = fresh(),
      p = item(s, "A"),
      b = bill(s, [{ productId: p, quantity: 1 }]);
    s.archive(p);
    expect(s.products()).toHaveLength(0);
    expect(s.history(p)).toHaveLength(1);
    expect(() => s.decide(b, "accepted")).toThrow("no longer available");
  });
  test("adjustments are audited and cannot overdraw", () => {
    const s = fresh(),
      p = item(s, "A", 3);
    s.adjust(p, { quantity: 2, reason: "Delivery" });
    s.adjust(p, { quantity: -1, reason: "Damaged" });
    expect(s.products()[0].stock).toBe(4);
    expect(s.history(p)).toHaveLength(3);
    expect(() => s.adjust(p, { quantity: -5, reason: "Bad" })).toThrow(
      "Not enough stock",
    );
    expect(s.products()[0].stock).toBe(4);
  });
  test("editing item metadata cannot overwrite stock", () => {
    const s = fresh(),
      p = item(s, "A", 8);
    s.saveProduct(
      { sku: "AA", name: "Renamed", unit: "pcs", minimum: 2, stock: 99 },
      p,
    );
    expect(s.products()[0].stock).toBe(8);
  });
  test("unreviewed bills cannot be accepted", () => {
    const s = fresh(),
      b = s.ingest(
        new TextEncoder().encode("New"),
        "new",
        "text/plain",
        "Tablet",
      );
    expect(() => s.decide(b.id, "accepted")).toThrow("Add bill number");
  });
});
