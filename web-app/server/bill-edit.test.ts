import { test, expect } from "bun:test";
import { openTestStore } from "./test-store";
import { recalculateReceipt } from "./receipt";
const text = `INVOICE
Distributor
................
Bill date : 2026-09-28
Serial No : 91001
OUTLET ID : 12
Customer :
Example shop
................
SKU UNIT QTY RATE AMOUNT
 1  ITEM MRP 20.00
 PKT 2 18.00 36.00
Gross : 36.00
Net(Rs) : 36.00
`;
test("draft edits persist customer details, quantities, prices, discounts and calculated totals while preserving the print", async () => {
  const s = await openTestStore();
  try {
    const { id } = await s.ingest(Buffer.from(text), "print", "", "Test");
    const productId = await s.saveProduct({
      name: "Corrected item",
      unit: "PKT",
      stock: 20,
      mrp: 25,
    });
    const b = await s.bill(id);
    b.number = "CORRECTED-1";
    b.shop = "Corrected shop";
    b.note = "Checked delivery";
    b.receipt = recalculateReceipt({
      ...b.receipt,
      number: b.number,
      shop: b.shop,
      date: "2026-09-29",
      outletId: "99",
      customerAddress: "New address",
      customerPhone: "0771234567",
      items: [
        {
          ...b.receipt.items[0],
          name: "Corrected item",
          quantity: 3,
          mrp: 25,
          rate: 22,
          discount: 1,
          amount: 65,
        },
      ],
      accounting: { ...b.receipt.accounting, discount: 2, skuDiscount: 3 },
    });
    b.items = [
      { productId, quantity: 3, mrp: 25, sellingPrice: 22, sourceLine: 0 },
    ];
    await s.saveBill(id, b);
    const saved = await s.bill(id);
    expect(saved.receipt.total).toBe(60);
    expect(saved.receipt.edited).toBe(true);
    expect(saved.receipt).toMatchObject({
      date: "2026-09-29",
      outletId: "99",
      customerAddress: "New address",
    });
    expect(saved.originalReceipt.total).toBe(36);
    expect(Buffer.from(saved.raw).toString()).toBe(text);
    expect((await s.product(productId!)).stock).toBe(20000);
    expect(
      await s.db
        .query("SELECT count(*) n FROM bill_parse_history WHERE bill_id=?")
        .get(id),
    ).toEqual({ n: 1 });
    await s.decide(id, "accepted");
    expect((await s.product(productId!)).stock).toBe(17000);
    expect(
      await s.db.query("SELECT name,outlet_id FROM customers").get(),
    ).toEqual({ name: "Corrected shop", outlet_id: "99" });
    await expect(s.saveBill(id, { ...saved, shop: "Another" })).rejects.toThrow(
      "already closed",
    );
    const again = await s.ingest(
      Buffer.from(text + "\n"),
      "reprint",
      "",
      "Test",
    );
    const copy = await s.reviewBill(again.id);
    copy.number = "ANOTHER-NUMBER";
    copy.receipt.number = copy.number;
    copy.receipt.reviewed = true;
    copy.items[0].productId = productId;
    await s.saveBill(again.id, copy);
    await expect(s.decide(again.id, "accepted")).rejects.toThrow(
      "original invoice has already been accepted",
    );
  } finally {
    await s.db.close();
  }
});
test("adding/removing lines and changing sale/free/fresh/market types changes the ledger only on acceptance", async () => {
  const s = await openTestStore();
  try {
    const { id } = await s.ingest(Buffer.from(text), "print", "", "Test");
    const p = await s.saveProduct({
      name: "ITEM",
      unit: "PKT",
      stock: 10,
      mrp: 20,
    });
    const b = await s.bill(id);
    const line = b.receipt.items[0];
    b.receipt = recalculateReceipt({
      ...b.receipt,
      items: [
        { ...line, kind: "fresh_return", quantity: 3, amount: 54 },
        { ...line, kind: "market_return", quantity: 5, amount: 90 },
        { ...line, kind: "free", quantity: 1, rate: 0, amount: 0 },
      ],
    });
    b.items = b.receipt.items.map((l: any, sourceLine: number) => ({
      productId: p,
      quantity: l.quantity,
      sourceLine,
    }));
    await s.saveBill(id, b);
    expect((await s.product(p!)).stock).toBe(10000);
    expect((await s.bill(id)).receipt.total).toBe(-144);
    await s.decide(id, "accepted");
    expect((await s.product(p!)).stock).toBe(12000);
    const returns = await s.db
      .query("SELECT kind,lot_id FROM bill_returns ORDER BY line")
      .all();
    expect(returns[0].lot_id).toBeTruthy();
    expect(returns[1].lot_id).toBeNull();
  } finally {
    await s.db.close();
  }
});
test("restore recovers the original after saved edits and bad pricing cannot be saved", async () => {
  const s = await openTestStore();
  try {
    const { id } = await s.ingest(Buffer.from(text), "print", "", "Test");
    const b = await s.bill(id);
    for (const patch of [
      { rate: -1 },
      { amount: 100 },
      { kind: "free" },
      { discount: 100 },
    ]) {
      const invalid = structuredClone(b);
      Object.assign(invalid.receipt.items[0], patch);
      await expect(s.saveBill(id, invalid)).rejects.toThrow();
    }
    const invalid = structuredClone(b);
    invalid.receipt.accounting.discount = 40;
    await expect(s.saveBill(id, invalid)).rejects.toThrow("Discounts exceed");
    b.shop = "Edited";
    b.receipt.items = [];
    b.items = [];
    await s.saveBill(id, b);
    const edited = await s.bill(id);
    expect(edited.items).toHaveLength(0);
    expect(edited.receipt.total).toBe(0);
    await s.restoreBillPrint(id, edited.revision);
    const restored = await s.bill(id);
    expect(restored.receipt.total).toBe(36);
    expect(restored.items).toHaveLength(1);
    expect(restored.shop).toBe("Example shop");
    await expect(s.saveBill(id, edited)).rejects.toThrow("another window");
  } finally {
    await s.db.close();
  }
});
