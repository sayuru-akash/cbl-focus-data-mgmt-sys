import { expect, test } from "bun:test";
import { openTestStore } from "./test-store";

test("automatic bill mapping requires a unique identity, unit and available printed MRP", async () => {
  const s = await openTestStore();
  try {
    const id = await s.saveProduct({
      name: "SWISS ROLL CHO 200gX24EA",
      unit: "PKT",
      stock: 10,
      mrp: 400,
    });
    let match = await s.inventory.billMatcher();
    const printed = "SWISS ROLL CHOCOLATE 200G";
    expect(match(printed, "PKT", 400)).toBe(id!);
    expect(match(printed, "PKT", 420)).toBe("");
    expect(match(printed, "PKT", null)).toBe("");
    expect(match(printed, "PKT", undefined)).toBe("");
    expect(match(printed, "DZ", 400)).toBe("");
    expect(match("SWISS ROLL VANILLA 200G", "PKT", 400)).toBe("");
    await s.db
      .query("INSERT INTO product_aliases(name,unit,product_id) VALUES (?,?,?)")
      .run("REMEMBERED ROLL", "PKT", id);
    const remembered = await s.inventory.billMatcher();
    expect(remembered("Remembered roll", "PKT", 400)).toBe(id!);
    expect(remembered("Remembered roll", "PKT", 420)).toBe("");
    await s.db
      .query("UPDATE stock_lots SET remaining=0 WHERE product_id=?")
      .run(id);
    match = await s.inventory.billMatcher();
    expect(match(printed, "PKT", 400)).toBe("");
    await s.db
      .query("UPDATE stock_lots SET remaining=1000,mrp=NULL WHERE product_id=?")
      .run(id);
    expect((await s.inventory.billMatcher())(printed, "PKT", 400)).toBe("");
    await s.db
      .query("UPDATE stock_lots SET mrp=40000 WHERE product_id=?")
      .run(id);
    await s.saveProduct({
      name: "SWISS ROLL CHOC 200GX12EA",
      unit: "PKT",
      stock: 1,
      mrp: 420,
    });
    expect((await s.inventory.billMatcher())(printed, "PKT", 400)).toBe("");
  } finally {
    await s.db.close();
  }
});

test("draft review clears stale automatic mappings but preserves explicit manual choices", async () => {
  const s = await openTestStore();
  try {
    const productId = await s.saveProduct({
      name: "Item",
      unit: "PKT",
      stock: 10,
      mrp: 20,
    });
    const { id } = await s.ingest(
      Buffer.from("mapping provenance"),
      "print",
      "",
      "Test",
    );
    const source = {
      name: "Item",
      unit: "PKT",
      quantity: 1,
      mrp: 25,
      rate: 25,
      amount: 25,
      kind: "sale",
      section: "Sale",
    };
    const receipt = { items: [source] };
    const item = { productId, quantity: 1, sourceLine: 0, mrp: 25 };
    const set = async (items: any[], revision = 1) =>
      s.db
        .query("UPDATE bills SET receipt=?,items=?,revision=? WHERE id=?")
        .run(JSON.stringify(receipt), JSON.stringify(items), revision, id);
    await set([item]);
    expect((await s.reviewBill(id)).items[0].productId).toBe("");
    await set([{ ...item, automaticMatch: true }], 5);
    expect((await s.reviewBill(id)).items[0].productId).toBe("");
    await set([{ ...item, automaticMatch: false }], 5);
    expect((await s.reviewBill(id)).items[0].productId).toBe(productId!);
    await set([item], 5); // Legacy reviewed mappings are never silently discarded.
    expect((await s.reviewBill(id)).items[0].productId).toBe(productId!);
    receipt.items[0]!.mrp = 20;
    await set([{ ...item, productId: "", automaticMatch: false }], 5);
    expect((await s.reviewBill(id)).items[0].productId).toBe("");
    await set([{ ...item, productId: "", automaticMatch: true }], 5);
    expect((await s.reviewBill(id)).items[0].productId).toBe(productId!);
    await set([{ ...item, productId: "", createReturnProduct: true }], 5);
    expect((await s.reviewBill(id)).items[0].productId).toBe("");
  } finally {
    await s.db.close();
  }
});

test("print ingestion and draft saving retain automatic versus manual mapping intent", async () => {
  const s = await openTestStore();
  try {
    const productId = await s.saveProduct({
      name: "ITEM",
      unit: "PKT",
      stock: 10,
      mrp: 20,
    });
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
    const { id } = await s.ingest(Buffer.from(text), "print", "", "Test");
    const b = await s.bill(id);
    expect(b.items[0]).toMatchObject({ productId, automaticMatch: true });
    await s.saveBill(id, {
      ...b,
      items: b.items.map((i: any) => ({
        ...i,
        productId: "",
        automaticMatch: false,
      })),
    });
    const cleared = await s.reviewBill(id);
    expect(cleared.items[0]).toMatchObject({
      productId: "",
      automaticMatch: false,
    });
    await s.saveBill(id, {
      ...cleared,
      items: cleared.items.map((i: any) => ({
        ...i,
        productId,
        automaticMatch: false,
      })),
    });
    expect((await s.reviewBill(id)).items[0]).toMatchObject({
      productId,
      automaticMatch: false,
    });
    await s.restoreBillPrint(id, (await s.bill(id)).revision);
    expect((await s.reviewBill(id)).items[0]).toMatchObject({
      productId,
      automaticMatch: false,
    });
  } finally {
    await s.db.close();
  }
});
