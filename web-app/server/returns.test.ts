import { test, expect } from "bun:test";
import { parseReceipt, RECEIPT_VERSION } from "./receipt";
import { openTestStore } from "./test-store";
import type { Store } from "./store";
const fixture = (number: string) =>
  Bun.file(`${import.meta.dir}/fixtures/cbl-${number}.txt`).text();
const prints = [
  { number: "73374", counts: [36, 0, 1, 0], net: 39571.7 },
  { number: "73354", counts: [4, 1, 0, 0], net: 10344 },
  { number: "73364", counts: [10, 1, 0, 2], net: 8532 },
  { number: "73351", counts: [19, 1, 0, 0], net: 10282.55 },
];
for (const example of prints)
  test(`real CBL format ${example.number}: all sections and net reconcile`, async () => {
    const r = parseReceipt(await fixture(example.number))!;
    expect(
      ["sale", "free", "fresh_return", "market_return"].map(
        (k) => r.items.filter((i) => i.kind === k).length,
      ),
    ).toEqual(example.counts);
    expect(r.accounting.calculatedNet).toBe(example.net);
    expect(r.accounting.difference).toBe(0);
    expect(r.warnings).toEqual([]);
    if (example.number === "73374")
      expect(r.accounting).toMatchObject({
        gross: 44177,
        discount: 2531.7,
        skuDiscount: 226.8,
        returnGross: 1944,
        returnReversal: 97.2,
        returns: 1846.8,
      });
  });
async function prepare(s: Store, text: string, opening = 1000) {
  const { id } = await s.ingest(Buffer.from(text), "print.bin", "", "Test");
  const b = await s.bill(id);
  for (const item of b.items) {
    const src = b.receipt.items[item.sourceLine];
    if (src.kind === "market_return") continue;
    if (src.kind === "fresh_return") {
      item.createReturnProduct = true;
      continue;
    }
    item.productId =
      (await s.inventory.match(src.name, src.unit)) ||
      (await s.saveProduct({
        name: src.name,
        unit: src.unit,
        stock: opening,
        mrp: src.mrp,
        costPrice: 1,
      }));
  }
  await s.saveBill(id, b);
  return await s.bill(id);
}
test("all observed bills post correct sale/free/return movements and retries change nothing", async () => {
  const s = await openTestStore();
  try {
    await s.db.transaction(async () => {
      for (const example of prints) {
        const b = await prepare(s, await fixture(example.number));
        const before = new Map(
          (await s.products()).map((p) => [p.id, p.stock]),
        );
        expect((await s.inventory.plan(b)).issues).toEqual([]);
        await s.decide(b.id, "accepted");
        const posted = await s.bill(b.id),
          expected = new Map(before);
        for (const i of posted.items) {
          const src = posted.receipt.items[i.sourceLine];
          if (src.kind === "market_return") continue;
          expected.set(
            i.productId,
            (expected.get(i.productId) || 0) +
              (src.kind === "fresh_return" ? i.quantity : -i.quantity),
          );
        }
        for (const p of await s.products()) {
          expect(p.stock).toBe(expected.get(p.id));
          expect(p.lots.reduce((n: number, l: any) => n + l.remaining, 0)).toBe(
            p.stock,
          );
        }
        const returns = await s.db
          .query("SELECT * FROM bill_returns WHERE bill_id=? ORDER BY line")
          .all(b.id);
        expect(returns.length).toBe(example.counts[2] + example.counts[3]);
        for (const r of returns) {
          if (r.kind === "market_return") {
            expect(r.lot_id).toBeNull();
            expect(r.product_id).toBeNull();
          } else {
            const lot = await s.db
              .query("SELECT * FROM stock_lots WHERE id=?")
              .get(r.lot_id);
            expect(lot.mrp).toBe(1500);
            expect(lot.remaining).toBe(144000);
            expect(lot.cost).toBeNull();
          }
        }
        const snapshot = JSON.stringify(await s.products());
        await s.decide(b.id, "accepted");
        expect(JSON.stringify(await s.products())).toBe(snapshot);
        expect(
          (
            await s.ingest(
              Buffer.from(await fixture(example.number)),
              "retry",
              "",
              "Test",
            )
          ).duplicate,
        ).toBe(true);
      }
    })();
  } finally {
    await s.db.close();
  }
});
const mixed = `INVOICE
Example Distributor
................
Serial No : 90001
OUTLET ID : 999
Customer :
Example Shop
................
SKU    UNIT   QTY    RATE      AMOUNT
 1  ITEM 10G MRP 20.00
 PKT 4 18.00 72.00
 FRESH :
 ITEM 10G MRP 20.00
 PKT 3 18.00 54.00
 EXPIRY :
 ITEM 10G MRP 20.00
 PKT 50 18.00 900.00
 FREE :
 ITEM 10G MRP 20.00
 PKT 1 0.00 0.00
Gross : 72.00
Returns : 954.00
Net(Rs) : -882.00
`;
test("mixed returns use matching MRP, support credit totals, retain FIFO and never sell expired returns", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({
      name: "ITEM 10G",
      unit: "PKT",
      stock: 2,
      mrp: 20,
      costPrice: 10,
    });
    await s.adjust(p!, {
      quantity: 100,
      mrp: 30,
      costPrice: 15,
      reason: "Other MRP",
    });
    const { id } = await s.ingest(Buffer.from(mixed), "mixed", "", "Test");
    const b = await s.reviewBill(id);
    expect(b.receipt.total).toBe(-882);
    expect(b.receipt.warnings).toEqual([]);
    await s.saveBill(id, b);
    await Promise.all([s.decide(id, "accepted"), s.decide(id, "accepted")]);
    expect((await s.product(p!)).stock).toBe(100000);
    expect(
      (await s.inventory.lots(p!))
        .filter((l) => l.mrp === 20)
        .reduce((n, l) => n + l.remaining, 0),
    ).toBe(0);
    expect(
      await s.db
        .query(
          "SELECT quantity,cost FROM allocations WHERE bill_id=? ORDER BY rowid",
        )
        .all(id),
    ).toEqual([
      { quantity: 2000, cost: 1000 },
      { quantity: 2000, cost: null },
      { quantity: 1000, cost: null },
    ]);
    expect(
      await s.db
        .query("SELECT count(*) n FROM bill_returns WHERE bill_id=?")
        .get(id),
    ).toEqual({ n: 2 });
  } finally {
    await s.db.close();
  }
});
test("free-item shortages roll back returns, newly created products and every deduction", async () => {
  const s = await openTestStore();
  try {
    const b = await prepare(s, await fixture("73374"), 1000);
    const first = b.items[0];
    await s.adjust(first.productId, {
      quantity: -1000,
      mrp: first.mrp,
      reason: "Shortage",
    });
    const before = JSON.stringify(await s.products());
    await expect(s.decide(b.id, "accepted")).rejects.toThrow(
      "Not enough stock",
    );
    expect(JSON.stringify(await s.products())).toBe(before);
    expect((await s.bill(b.id)).status).toBe("pending");
    expect(
      await s.db.query("SELECT count(*) n FROM bill_returns").get(),
    ).toEqual({ n: 0 });
    const freeBill = await prepare(s, await fixture("73354"));
    const free = freeBill.items.at(-1);
    await s.adjust(free.productId, {
      quantity: -1000,
      mrp: free.mrp,
      reason: "No free stock",
    });
    const snapshot = JSON.stringify(await s.products());
    await expect(s.decide(freeBill.id, "accepted")).rejects.toThrow(
      "Not enough stock",
    );
    expect(JSON.stringify(await s.products())).toBe(snapshot);
  } finally {
    await s.db.close();
  }
});
test("stock entries must stay in sync with the reviewed bill", async () => {
  const s = await openTestStore();
  try {
    const b = await prepare(s, await fixture("73354"));
    for (const items of [
      b.items.slice(0, -1),
      [...b.items, b.items[0]],
      b.items.map((i: any, j: number) => (j === 0 ? { ...i, quantity: 1 } : i)),
    ]) {
      await s.saveBill(b.id, { ...b, revision: undefined, items });
      await expect(s.decide(b.id, "accepted")).rejects.toThrow(
        /bill item|updated quantities/,
      );
    }
    const latest = await s.bill(b.id);
    await s.restoreBillPrint(b.id, latest.revision);
    const restored = await s.bill(b.id);
    expect(restored.items.length).toBe(5);
    expect(restored.items[0].productId).toBe(b.items[0].productId);
    await expect(s.saveBill(b.id, b)).rejects.toThrow("another window");
    await s.decide(b.id, "accepted");
  } finally {
    await s.db.close();
  }
});
test("unrecognized return sections, missing rows and incorrect discounts block acceptance", async () => {
  for (const text of [
    mixed.replace("EXPIRY :", "UNCLASSIFIED :"),
    mixed.replace("PKT 50 18.00 900.00", "???"),
    mixed.replace("Gross : 72.00", "Gross : 72.00\nDiscount : 2.00"),
    mixed.replace("-882.00", "-881.99"),
  ])
    expect(parseReceipt(text)!.warnings.length).toBeGreaterThan(0);
});
test("untouched pending drafts upgrade with a backup; edited and closed bills remain unchanged", async () => {
  const s = await openTestStore();
  try {
    const text = await fixture("73354");
    const ids = [];
    for (let n = 0; n < 3; n++)
      ids.push(
        (
          await s.ingest(
            Buffer.from(text.replace("73354", String(80000 + n))),
            "old",
            "",
            "Test",
          )
        ).id,
      );
    for (const id of ids) {
      const b = await s.bill(id);
      delete b.receipt.version;
      b.receipt.items.pop();
      b.items.pop();
      await s.db
        .query("UPDATE bills SET receipt=?,items=? WHERE id=?")
        .run(JSON.stringify(b.receipt), JSON.stringify(b.items), id);
    }
    await s.db
      .query("UPDATE bills SET revision=2,note='User note' WHERE id=?")
      .run(ids[1]);
    await s.decide(ids[2], "rejected");
    const beforeEdited = await s.bill(ids[1]),
      beforeClosed = await s.bill(ids[2]);
    await s.db.transaction(async () => {
      await (s as any).initialize();
    })();
    const updated = await s.bill(ids[0]);
    expect(updated.receipt.version).toBe(RECEIPT_VERSION);
    expect(updated.items.length).toBe(5);
    expect(updated.revision).toBe(2);
    expect(await s.bill(ids[1])).toEqual(beforeEdited);
    expect(await s.bill(ids[2])).toEqual(beforeClosed);
    expect(
      await s.db.query("SELECT count(*) n FROM bill_parse_history").get(),
    ).toEqual({ n: 1 });
    await s.db.transaction(async () => {
      await (s as any).initialize();
    })();
    expect((await s.bill(ids[0])).revision).toBe(2);
  } finally {
    await s.db.close();
  }
});
