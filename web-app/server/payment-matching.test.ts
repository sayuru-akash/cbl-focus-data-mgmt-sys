import { test, expect } from "bun:test";
import { openTestStore } from "./test-store";
import { finance, financeCsv } from "./finance";
import { grid } from "./grid";
import { printedIdentity, productRelevance } from "./product-matching";

test("payment edits are validated, revision checked and retained in history and reporting", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({
      name: "Item",
      unit: "PKT",
      stock: 20,
      mrp: 10,
    });
    const ids: string[] = [];
    for (const [index, payment] of [
      "cash",
      "cheque",
      "credit",
      null,
    ].entries()) {
      const { id } = await s.ingest(
        Buffer.from(`payment test ${index}`),
        "print",
        "",
        "Test",
      );
      ids.push(id);
      const b = await s.bill(id);
      const input = {
        ...b,
        number: `PAY-${index}`,
        shop: "Shop",
        items: [{ productId: p, quantity: 1, mrp: 10 }],
        payment_type: payment,
      };
      await expect(
        s.saveBill(id, { ...input, payment_type: "wire" }),
      ).rejects.toThrow("Choose Cash");
      await s.saveBill(id, input);
      await expect(s.saveBill(id, input)).rejects.toThrow(
        "changed in another window",
      );
      const current = await s.bill(id);
      expect(current.payment_type).toBe(payment);
      const history = await s.db
        .query("SELECT metadata FROM bill_parse_history WHERE bill_id=?")
        .get(id);
      expect(JSON.parse(history.metadata).payment_type).toBe(null);
      // Explicit receipt fixture tests net grouping, including zero and negative return credit.
      const net = [100, 0, -20, 25][index];
      const receipt = {
        date: "2026-09-28",
        total: net,
        items: [],
        accounting: {
          gross: net,
          discount: 0,
          skuDiscount: 0,
          returns: 0,
          returnReversal: 0,
        },
      };
      await s.db
        .query("UPDATE bills SET receipt=?,status='accepted' WHERE id=?")
        .run(JSON.stringify(receipt), id);
      await expect(
        s.saveBill(id, { ...current, payment_type: "cash" }),
      ).rejects.toThrow("already closed");
    }
    const report = await finance(
      s,
      new URLSearchParams("from=2026-09-01&to=2026-09-30"),
    );
    expect(report.payments.map((p) => [p.type, p.net, p.bills])).toEqual([
      ["cash", 100, 1],
      ["cheque", 0, 1],
      ["credit", -20, 1],
      ["unset", 25, 1],
    ]);
    expect(report.payments.reduce((sum, p) => sum + p.net, 0)).toBe(
      report.summary.net,
    );
    expect(financeCsv(report)).toContain('"Payment"');
    const filtered = await finance(
      s,
      new URLSearchParams("from=2026-09-01&to=2026-09-30&payment=credit"),
    );
    expect(filtered.rows.map((r) => r.id)).toEqual([ids[2]!]);
    const list = await grid(s, "bills", new URLSearchParams("payment=cash"));
    expect(list.rows.map((r) => r.id)).toEqual([ids[0]!]);
    await s.db
      .query("UPDATE bills SET status='rejected' WHERE id=?")
      .run(ids[0]);
    expect(
      (await finance(s, new URLSearchParams("from=2026-09-01&to=2026-09-30")))
        .payments[0]!.bills,
    ).toBe(0);
    expect((await s.product(p!)).stock).toBe(20000);
  } finally {
    await s.db.close();
  }
});

test("payment persists on real approval and stock reversal without changing totals", async () => {
  const s = await openTestStore();
  try {
    const productId = await s.saveProduct({
      name: "Item",
      unit: "PKT",
      stock: 10,
      mrp: 20,
    });
    const { id } = await s.ingest(
      Buffer.from("simple bill"),
      "print",
      "",
      "Test",
    );
    const b = await s.bill(id);
    await s.saveBill(id, {
      ...b,
      number: "PAY",
      shop: "Shop",
      payment_type: "cheque",
      items: [{ productId, quantity: 2, mrp: 20 }],
    });
    await s.decide(id, "accepted");
    expect((await s.bill(id)).payment_type).toBe("cheque");
    expect((await s.product(productId!)).stock).toBe(8000);
    await s.deleteBill(id, (await s.bill(id)).revision, "DELETE");
    expect((await s.product(productId!)).stock).toBe(10000);
    expect(
      (await grid(s, "bills", new URLSearchParams("payment=cheque"))).total,
    ).toBe(0);
  } finally {
    await s.db.close();
  }
});

test("real supplier spellings and outer-case sizes normalize without losing variant identity", () => {
  const pairs = [
    ["CHOCO-LA MILK 45G", "CHOCOLA MILK 45GX12DZ-SPS"],
    ["CHUNKY CHOC TRIO 60G", "CHUNKY TRIO 60gX6DZ-A"],
    [
      "O-KAY SPONGE LAYER CAKE CHOCOLATE 18G",
      "O-KAY SPONGE L/CAKE CHOCOLATE 18GX288EA",
    ],
    ["SWISS ROLL CHOCOLATE 200G", "SWISS ROLL CHO 200gX24EA"],
    ["CHOCOLATE FINGERS 110G-A", "CHO. FINGERS 110GX2DZ-A"],
    ["GO CHOK VANILLA 30G", "GO CHOK VANILLA 30G X 18 X12"],
    ["POPIT 9G", "POPIT 9G.NETX48DZ"],
    ["CHIT CHAT 12G", "CHIT CHAT 12G.NETX36DZ"],
    ["RITZBURY CRISPY 93G", "RITZBURY CRISPIES 93GX12DZ-SPS"],
  ];
  for (const [a, b] of pairs)
    expect(printedIdentity(a!)).toBe(printedIdentity(b!));
  for (const [a, b] of [
    ["MILK 45G", "MILK SWEET 45G"],
    ["CAKE 310G", "CAKE 480G"],
    ["ROLL VANILLA 200G", "ROLL STRAWBERRY 200G"],
    ["PEANUT 50G", "CASHEW 50G"],
    ["BUBBLES 4.5G", "BUBBLES 4.5G-OLD"],
    ["CHOCO-LA 20G", "CHOCO-LE 20G"],
  ])
    expect(printedIdentity(a!)).not.toBe(printedIdentity(b!));
  expect(
    productRelevance("CHOCOLATE FINGERS 18G", "CHO. FINGERS 110GX2DZ-A"),
  ).toBeGreaterThan(
    productRelevance(
      "CHOCOLATE FINGERS 18G",
      "O-KAY SPONGE L/CAKE CHOCOLATE 18GX288EA",
    ),
  );
});

test("automatic matching is unique, unit scoped, excludes archived items and preserves MRP allocation checks", async () => {
  const s = await openTestStore();
  try {
    const name = "SWISS ROLL CHO 200gX24EA",
      printed = "SWISS ROLL CHOCOLATE 200G";
    const id = await s.saveProduct({ name, unit: "PKT", stock: 10, mrp: 400 });
    expect(await s.inventory.match(printed, "PKT")).toBe(id!);
    expect(await s.inventory.match(printed, "DZ")).toBe("");
    expect(await s.inventory.match("SWISS ROLL VANILLA 200G", "PKT")).toBe("");
    const { id: billId } = await s.ingest(
      Buffer.from("wrong MRP"),
      "print",
      "",
      "Test",
    );
    await s.saveBill(billId, {
      ...(await s.bill(billId)),
      number: "MRP",
      shop: "Shop",
      items: [{ productId: id, quantity: 2, mrp: 420 }],
      payment_type: "cash",
    });
    await expect(s.decide(billId, "accepted")).rejects.toThrow();
    expect((await s.product(id!)).stock).toBe(10000);
    const other = await s.saveProduct({
      name: "SWISS ROLL CHOC 200GX12EA",
      unit: "PKT",
      stock: 1,
      mrp: 420,
    });
    expect(await s.inventory.match(printed, "PKT")).toBe("");
    await s.db.query("UPDATE products SET archived=1 WHERE id=?").run(other);
    expect(await s.inventory.match(printed, "PKT")).toBe(id!);
  } finally {
    await s.db.close();
  }
});

test("accepted payment can change after ten days with audited revisions and no ledger changes", async () => {
  const s = await openTestStore();
  try {
    const productId = await s.saveProduct({
      name: "Item",
      unit: "PKT",
      stock: 10,
      mrp: 20,
    });
    const { id } = await s.ingest(
      Buffer.from("payment-only"),
      "print",
      "",
      "Test",
    );
    await s.saveBill(id, {
      ...(await s.bill(id)),
      number: "PAID",
      shop: "Shop",
      payment_type: "cash",
      items: [{ productId, quantity: 2, mrp: 20 }],
    });
    await expect(s.setBillPayment(id, "credit", 2)).rejects.toThrow(
      "Only accepted",
    );
    await s.decide(id, "accepted");
    await s.db
      .query("UPDATE bills SET decided='2020-01-01T00:00:00Z' WHERE id=?")
      .run(id);
    const before = await s.bill(id);
    const ledger = async () =>
      JSON.stringify({
        lots: await s.db.query("SELECT * FROM stock_lots ORDER BY id").all(),
        moves: await s.db.query("SELECT * FROM movements ORDER BY id").all(),
        allocations: await s.db
          .query("SELECT * FROM allocations ORDER BY id")
          .all(),
      });
    const snapshot = await ledger();
    await expect(
      s.setBillPayment(id, "other", before.revision),
    ).rejects.toThrow("Choose Cash");
    await expect(s.setBillPayment(id, "credit", undefined)).rejects.toThrow(
      "changed",
    );
    const changed = await s.setBillPayment(id, "credit", before.revision);
    await expect(
      s.setBillPayment(id, "cheque", before.revision),
    ).rejects.toThrow("changed");
    await s.setBillPayment(id, "cheque", changed.revision);
    const after = await s.bill(id);
    const { revision: a, payment_type: b, ...old } = before;
    const { revision: c, payment_type: d, ...fresh } = after;
    expect(fresh).toEqual(old);
    expect(c).toBe(a + 2);
    expect(d).toBe("cheque");
    expect(await ledger()).toBe(snapshot);
    expect((await s.setBillPayment(id, "cheque", c)).revision).toBe(c);
    const audit = await s.db
      .query(
        "SELECT metadata FROM bill_parse_history WHERE bill_id=? AND revision=?",
      )
      .get(id, changed.revision);
    expect(JSON.parse(audit.metadata)).toMatchObject({
      action: "payment_change",
      payment_type: "credit",
      next_payment_type: "cheque",
    });
  } finally {
    await s.db.close();
  }
});
