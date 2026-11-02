import { expect, test } from "bun:test";
import { openTestStore } from "./test-store";
import { Intakes } from "./intake";
import { stockValue, stockValueCsv } from "./stock-value";
import { grid } from "./grid";

async function fixture() {
  const s = await openTestStore(),
    intake = await Intakes.open(s);
  const productId = await s.saveProduct({
      name: "Sample 480GX3EA",
      unit: "PKT",
    }),
    id = crypto.randomUUID();
  const draft = {
    supplier: "Synthetic supplier",
    tin: "999999999",
    number: "QA-DISCOUNT-1",
    date: "2026-11-03",
    gross: 300,
    discount: 30,
    total: 270,
    headerReviewed: true,
    pages: [
      {
        page: 1,
        count: 1,
        document: "QA-PAGE",
        invoice: "QA-DISCOUNT-1",
        reviewed: true,
      },
    ],
    lines: [100, 200].map((amount, i) => ({
      id: crypto.randomUUID(),
      page: 0,
      code: "QA-" + i,
      description: "Sample 480GX3EA",
      weight: "480G",
      boxes: 1,
      sold: 1,
      unit: "MC",
      unitPrice: amount,
      amount,
      packSize: 3,
      packEvidence: "480GX3EA",
      mrp: i ? 80 : 50,
      productId,
      reviewed: true,
    })),
  };
  await s.db
    .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
    .run(id, JSON.stringify(draft), "2026-11-03");
  await s.db
    .query(
      "INSERT INTO intake_pages(id,intake_id,position,filename,mime,hash,raw) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      crypto.randomUUID(),
      id,
      0,
      "synthetic.jpg",
      "image/jpeg",
      "synthetic",
      new Uint8Array([1]),
    );
  const received = await intake.receive(id, 1);
  return { s, intake, id, productId, purchaseId: received.purchase_id };
}

test("before-discount costs drive stock, receipt, sort and valuation while discounts and net ledger costs remain separate", async () => {
  const { s, productId, purchaseId } = await fixture();
  try {
    expect(
      (await s.inventory.lots(productId!)).map((l) => [
        l.costPrice,
        l.netCostPrice,
        l.mrp,
      ]),
    ).toEqual([
      [33.33, 30, 50],
      [66.67, 60, 80],
    ]);
    const purchase = await s.inventory.purchase(purchaseId);
    expect(purchase.lines.map((l: any) => l.costPrice)).toEqual([30, 60]);
    expect(
      (await s.inventory.displayPurchase(purchase)).lines.map((l: any) => [
        l.costPrice,
        l.netCostPrice,
      ]),
    ).toEqual([
      [33.33, 30],
      [66.67, 60],
    ]);
    const batches = await grid(
      s,
      "lots",
      new URLSearchParams({ product: productId!, sort: "cost", dir: "desc" }),
    );
    expect(batches.rows.map((l) => [l.cost, l.net_cost])).toEqual([
      [66.67, 60],
      [33.33, 30],
    ]);
    const r = await stockValue(s, new URLSearchParams());
    expect(
      (
        await grid(
          s,
          "lots",
          new URLSearchParams({ product: productId!, q: "33.33" }),
        )
      ).rows.map((l) => l.cost),
    ).toEqual([33.33]);
    expect(r.summary).toMatchObject({ direct: 300, rd: 321.54 });
    expect(stockValueCsv(r)).toContain('"300.00","321.54"');
    const raw = `INVOICE\nDistributor\n................\nBill date : 2026-11-03\nSerial No : 98061\nOUTLET ID : QA-COST\nCustomer :\nSample shop\n................\nSKU UNIT QTY RATE AMOUNT\n 1 SAMPLE 480G MRP 50.00\n PKT 2 45.00 90.00\nGross : 90.00\nNet(Rs) : 90.00\n`;
    const { id } = await s.ingest(
        Buffer.from(raw),
        "synthetic-cost-bill",
        "",
        "Test",
      ),
      b = await s.bill(id);
    b.receipt.reviewed = true;
    b.items[0].productId = productId;
    b.items[0].automaticMatch = false;
    await s.saveBill(id, { ...b, payment_type: "cash" });
    await s.decide(id, "accepted");
    expect(
      await s.db.query("SELECT cost FROM allocations WHERE bill_id=?").get(id),
    ).toEqual({ cost: 3000 });
    expect((await stockValue(s, new URLSearchParams())).summary.direct).toBe(
      233.34,
    );
    await s.deleteBill(id, (await s.bill(id)).revision, "DELETE");
    expect((await stockValue(s, new URLSearchParams())).summary.direct).toBe(
      300,
    );
  } finally {
    await s.db.close();
  }
});

test("populated-store upgrade recovers original costs once without repricing lots or altering quantities", async () => {
  const { s, id, purchaseId } = await fixture();
  try {
    const before = await s.db
      .query(
        "SELECT * FROM stock_lots WHERE purchase_id=? ORDER BY created,rowid",
      )
      .all(purchaseId);
    const purchase = await s.inventory.purchase(purchaseId);
    await s.db.exec("DROP TABLE stock_lot_costs");
    await s.inventory.initialize();
    await Intakes.open(s);
    await Intakes.open(s);
    expect(
      await s.db
        .query(
          "SELECT * FROM stock_lots WHERE purchase_id=? ORDER BY created,rowid",
        )
        .all(purchaseId),
    ).toEqual(before);
    expect(await s.inventory.purchase(purchaseId)).toEqual(purchase);
    expect(
      await s.db
        .query(
          "SELECT before_discount,source FROM stock_lot_costs ORDER BY before_discount",
        )
        .all(),
    ).toEqual([
      { before_discount: 3333, source: id },
      { before_discount: 6667, source: id },
    ]);
    expect((await stockValue(s, new URLSearchParams())).summary.direct).toBe(
      300,
    );
  } finally {
    await s.db.close();
  }
});

test("inconsistent historical invoice evidence stays unpriced instead of relabelling net cost as original cost", async () => {
  const { s, id, productId } = await fixture();
  try {
    await s.db
      .query(
        "DELETE FROM stock_lot_costs WHERE lot_id IN (SELECT id FROM stock_lots WHERE product_id=?)",
      )
      .run(productId);
    const row = await s.db
        .query("SELECT draft FROM intakes WHERE id=?")
        .get(id),
      draft = JSON.parse(row.draft);
    draft.total = 1;
    await s.db
      .query("UPDATE intakes SET draft=? WHERE id=?")
      .run(JSON.stringify(draft), id);
    await Intakes.open(s);
    expect(
      (await s.inventory.lots(productId!)).map((l) => [
        l.costPrice,
        l.netCostPrice,
      ]),
    ).toEqual([
      [null, 30],
      [null, 60],
    ]);
    expect((await stockValue(s, new URLSearchParams())).summary).toMatchObject({
      direct: null,
      rd: null,
      unpricedLots: 2,
    });
  } finally {
    await s.db.close();
  }
});
