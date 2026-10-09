import { expect, test } from "bun:test";
import { openTestStore } from "./test-store";
import { isGenericSalesUnit, salesUnitCompatible } from "./sales-units";

test("generic sales counts never convert cartons or blur explicit stock units", () => {
  for (const stock of ["PKT", "BOX", "BTL", "UNIT"]) {
    expect(salesUnitCompatible(" unit ", stock)).toBe(true);
    expect(salesUnitCompatible("UNITS", stock)).toBe(true);
  }
  for (const unit of ["DZ", "MC", "KG", "PACK", "unknown"]) {
    expect(isGenericSalesUnit(unit)).toBe(false);
    expect(salesUnitCompatible(unit, "PKT")).toBe(false);
    expect(salesUnitCompatible("UNIT", unit)).toBe(false);
  }
  expect(salesUnitCompatible("PKT", "BOX")).toBe(false);
  expect(salesUnitCompatible("BTL", "PKT")).toBe(false);
});

test("UNIT resolves identity before MRP across packet, box and bottle stock, while intake remains strict", async () => {
  const s = await openTestStore();
  try {
    const ids: string[] = [];
    for (const unit of ["PKT", "BOX", "BTL"]) {
      ids.push(
        (await s.saveProduct({
          name: `Sample ${unit} 20G`,
          unit,
          stock: 10,
          mrp: 50,
        }))!,
      );
    }
    let match = await s.inventory.billMatcher();
    for (const [i, unit] of ["PKT", "BOX", "BTL"].entries()) {
      expect(match(`Sample ${unit} 20G`, "UNIT", 50)).toBe(ids[i]!);
      expect(match(`Sample ${unit} 20G`, "UNIT", 60)).toBe("");
      expect(match(`Sample ${unit} 20G`, "UNIT", null)).toBe("");
      expect(await s.inventory.match(`Sample ${unit} 20G`, "UNIT")).toBe("");
    }
    await s.saveProduct({
      name: "Sample PKT 20GX12EA",
      unit: "BOX",
      stock: 0,
      mrp: 60,
    });
    match = await s.inventory.billMatcher();
    expect(match("Sample PKT 20G", "UNIT", 50)).toBe("");
    expect(match("Sample PKT 20G", "PKT", 50)).toBe(ids[0]!);
    expect(match("Sample PKT 20G", "BOX", 50)).toBe("");
  } finally {
    await s.db.close();
  }
});

test("existing UNIT drafts rematch without writes; sales, free items and fresh/market returns post exact stock and reverse once", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({
      name: "Sample Chocolate 20G",
      unit: "PKT",
      stock: 12,
      mrp: 50,
      costPrice: 30,
    });
    const print = `INVOICE #98101
SAMPLE SHOP
2026-10-09
SKU UNIT QTY RATE AMOUNT
SAMPLE CHOCOLATE 20G
UNIT 8 45.00 360.00
Net(Rs) 360.00`;
    const { id } = await s.ingest(
      Buffer.from(print),
      "synthetic-unit.bin",
      "",
      "Test",
    );
    const receipt = {
      version: 2,
      number: "98101",
      shop: "SAMPLE SHOP",
      date: "2026-10-09",
      outletId: "SYNTHETIC-UNIT",
      items: [
        {
          name: "Sample Chocolate 20G",
          unit: "UNIT",
          quantity: 8,
          mrp: 50,
          rate: 45,
          amount: 360,
          kind: "sale",
          section: "Sale",
        },
        {
          name: "Sample Chocolate 20G",
          unit: "UNIT",
          quantity: 2,
          mrp: 50,
          rate: 0,
          amount: 0,
          kind: "free",
          section: "Free",
        },
        {
          name: "Sample Chocolate 20G",
          unit: "UNIT",
          quantity: 3,
          mrp: 50,
          rate: 45,
          amount: 135,
          kind: "fresh_return",
          section: "Fresh",
        },
        {
          name: "Sample Chocolate 20G",
          unit: "UNIT",
          quantity: 1,
          mrp: 50,
          rate: 45,
          amount: 45,
          kind: "market_return",
          section: "Market",
        },
      ],
      warnings: [],
      reviewed: true,
      total: 180,
      accounting: {
        gross: 360,
        discount: 0,
        skuDiscount: 0,
        returnGross: 180,
        returnReversal: 0,
        returns: 180,
        calculatedNet: 180,
        difference: 0,
      },
      totals: [],
    };
    const items = receipt.items.map((l, sourceLine) => ({
      productId: "",
      automaticMatch: true,
      quantity: l.quantity,
      mrp: l.mrp,
      sellingPrice: l.rate,
      sourceLine,
    }));
    await s.db
      .query(
        "UPDATE bills SET number=?,shop=?,receipt=?,items=?,payment_type=?,revision=2 WHERE id=?",
      )
      .run(
        receipt.number,
        receipt.shop,
        JSON.stringify(receipt),
        JSON.stringify(items),
        "cash",
        id,
      );
    const before = await s.bill(id);
    const reviewed = await s.reviewBill(id);
    expect(reviewed.items.every((i: any) => i.productId === p)).toBe(true);
    expect((await s.bill(id)).items).toEqual(before.items);
    expect((await s.inventory.plan(reviewed)).issues).toEqual([]);
    await s.saveBill(id, reviewed);
    await s.decide(id, "accepted");
    expect((await s.product(p!))!.stock / 1000).toBe(5);
    expect(
      (await s.bill(id)).receipt.items.every((l: any) => l.unit === "UNIT"),
    ).toBe(true);
    await s.decide(id, "accepted");
    expect((await s.product(p!))!.stock / 1000).toBe(5);
    const returns = await s.db
      .query(
        "SELECT kind,lot_id FROM bill_returns WHERE bill_id=? ORDER BY line",
      )
      .all(id);
    expect(returns[0].lot_id).not.toBeNull();
    expect(returns[1].lot_id).toBeNull();
    await s.deleteBill(id, (await s.bill(id)).revision, "DELETE");
    expect((await s.product(p!))!.stock / 1000).toBe(12);
  } finally {
    await s.db.close();
  }
});

test("UNIT cannot hide combined shortages, wrong MRP, explicit-unit mismatch or an unconfirmed new fresh-return unit", async () => {
  const s = await openTestStore();
  try {
    const productId = await s.saveProduct({
      name: "Sample",
      unit: "PKT",
      stock: 5,
      mrp: 50,
    });
    const bill: any = {
      receipt: {
        items: [
          { name: "Sample", unit: "UNIT", mrp: 50, kind: "sale" },
          { name: "Sample", unit: "UNIT", mrp: 50, kind: "free" },
        ],
        warnings: [],
        accounting: { difference: 0 },
      },
      items: [
        { productId, quantity: 4, sourceLine: 0 },
        { productId, quantity: 2, sourceLine: 1 },
      ],
    };
    expect(
      (await s.inventory.plan(bill)).issues.some(
        (i: any) => i.kind === "shortage" && i.shortage === 1,
      ),
    ).toBe(true);
    bill.receipt.items[0].unit = "BOX";
    expect(
      (await s.inventory.plan(bill)).issues.some((i: any) => i.kind === "unit"),
    ).toBe(true);
    bill.receipt.items[0].unit = "UNIT";
    bill.receipt.items[0].mrp = 60;
    expect(
      (await s.inventory.plan(bill)).issues.some(
        (i: any) => i.kind === "shortage" && i.mrp === 60,
      ),
    ).toBe(true);
    bill.items = [
      { productId: "", quantity: 1, sourceLine: 0, createReturnProduct: true },
    ];
    bill.receipt.items = [
      { name: "New Sample", unit: "UNIT", mrp: 50, kind: "fresh_return" },
    ];
    expect(
      (await s.inventory.plan(bill)).issues.some((i: any) =>
        i.message?.includes("Choose PKT"),
      ),
    ).toBe(true);
    await expect(
      s.db.transaction(() => s.inventory.consume(bill))(),
    ).rejects.toThrow("Choose PKT");
    expect((await s.products()).length).toBe(1);
    expect((await s.product(productId!))!.stock / 1000).toBe(5);
  } finally {
    await s.db.close();
  }
});

test("the confirmed Milk 170G OLD label uses the same product but only its own MRP lots", async () => {
  const s = await openTestStore();
  try {
    const id = await s.saveProduct({
      name: "RITZBURY MILK 170G",
      unit: "PKT",
      stock: 5,
      mrp: 480,
    });
    await s.inventory.addLot(id!, 2000, 40000, 53000);
    await s.db.query("UPDATE products SET stock=stock+2000 WHERE id=?").run(id);
    const match = await s.inventory.billMatcher();
    expect(match("RITZBURY MILK 170G-OLD", "UNIT", 480)).toBe(id!);
    expect(match("RITZBURY MILK 170G-OLD", "PKT", 480)).toBe(id!);
    expect(match("RITZBURY MILK 170G", "UNIT", 530)).toBe(id!);
    expect(match("RITZBURY MILK 170G-OLD", "UNIT", 500)).toBe("");
    expect(match("RITZBURY MILK SWEET 170G-OLD", "UNIT", 480)).toBe("");
    await s.db
      .query("UPDATE stock_lots SET remaining=0 WHERE product_id=? AND mrp=?")
      .run(id, 48000);
    expect(
      (await s.inventory.billMatcher())("RITZBURY MILK 170G-OLD", "UNIT", 480),
    ).toBe("");
  } finally {
    await s.db.close();
  }
});
