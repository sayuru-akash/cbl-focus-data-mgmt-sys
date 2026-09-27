import { test, expect } from "bun:test";
import { openTestStore } from "./test-store";
import { finance, financeCsv } from "./finance";
import { categoryDiscounts, colomboDay } from "./discount-categories";
import { parseReceipt } from "./receipt";
const period = (extra = "") =>
  new URLSearchParams("from=2026-09-01&to=2026-09-30" + extra);
const print = (no: string) =>
  Bun.file(`${import.meta.dir}/fixtures/cbl-${no}.txt`).text();
test("real discount categories reconcile without double deductions and drafts are separate", async () => {
  const s = await openTestStore();
  try {
    for (const n of ["73351", "73354", "73364", "73374"])
      await s.ingest(Buffer.from(await print(n)), "print", "", "Test");
    const accepted = await finance(s, period());
    expect(accepted.summary.bills).toBe(0);
    expect(accepted.summary.net).toBe(0);
    const report = await finance(s, period("&status=pending"));
    expect(report.summary).toMatchObject({
      bills: 4,
      drafts: 4,
      accepted: 0,
      net: 68730.25,
      chocolate: 2784.15,
      candyBar: 340.2,
      cerealBars: 21.6,
      discount: 3145.95,
      returns: 2260.8,
      freshReturns: 1944,
      marketReturns: 414,
      returnReversal: 97.2,
      categoryDifference: 0,
      categoryIssues: 0,
      review: 0,
    });
    expect(
      report.summary.gross - report.summary.discount - report.summary.returns,
    ).toBeCloseTo(report.summary.net, 2);
    expect(report.days).toHaveLength(1);
    expect(report.freeUnits.PKT).toBe(4);
    const filtered = await finance(
      s,
      period("&status=pending&q=73351&size=5&page=99"),
    );
    expect(filtered.total).toBe(1);
    expect(filtered.page).toBe(1);
    expect(filtered.summary.net).toBe(10282.55);
    expect(filtered.rows[0]).toMatchObject({
      chocolate: 220.05,
      candyBar: 145.8,
      cerealBars: 21.6,
      discount: 387.45,
    });
    const snapshot = JSON.stringify(report.summary);
    expect(
      JSON.stringify(
        (await finance(s, period("&status=pending&sort=net&dir=asc&size=5")))
          .summary,
      ),
    ).toBe(snapshot);
    expect((await finance(s, period("&status=pending&q=%"))).total).toBe(0);
    expect(
      (
        await finance(
          s,
          new URLSearchParams("status=pending"),
          new Date("2026-09-27T15:00:00Z"),
        )
      ).total,
    ).toBe(0);
    expect(
      (
        await finance(
          s,
          new URLSearchParams("status=pending"),
          new Date("2026-09-27T19:00:00Z"),
        )
      ).total,
    ).toBe(4);
  } finally {
    await s.db.close();
  }
});
test("category edits are stored and finance flags unallocated discounts without inventing splits", async () => {
  const s = await openTestStore();
  try {
    const { id } = await s.ingest(
      Buffer.from(await print("73351")),
      "print",
      "",
      "Test",
    );
    const b = await s.bill(id);
    b.receipt.accounting.discount = 230.05;
    await s.saveBill(id, b);
    let r = await finance(s, period("&status=pending"));
    expect(r.summary.categoryDifference).toBe(10);
    expect(r.summary.categoryIssues).toBe(1);
    expect(r.summary.net).toBe(10272.55);
    const saved = await s.bill(id);
    saved.receipt.categoryDiscounts = {
      ...categoryDiscounts(saved.receipt),
      chocolate: 230.05,
    };
    await s.saveBill(id, saved);
    r = await finance(s, period("&status=pending"));
    expect(r.summary.categoryDifference).toBe(0);
    expect(r.summary.chocolate).toBe(230.05);
    expect((await s.bill(id)).originalReceipt.total).toBe(10282.55);
  } finally {
    await s.db.close();
  }
});
test("deleting an accepted bill removes finance values and restores stock; rejected and incomplete bills do not inflate totals", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({
      name: "Example",
      unit: "PKT",
      stock: 10,
      mrp: 20,
    });
    const receipt = parseReceipt(await print("73351"))!;
    receipt.number = "FIN-1";
    receipt.items = [
      {
        kind: "sale",
        section: "Sale",
        name: "Example",
        unit: "PKT",
        quantity: 2,
        rate: 18,
        amount: 36,
        mrp: 20,
      },
    ];
    receipt.accounting = {
      gross: 36,
      discount: 0,
      skuDiscount: 0,
      returnGross: 0,
      returnReversal: 0,
      returns: 0,
      calculatedNet: 36,
      difference: 0,
    };
    receipt.total = 36;
    receipt.totals = [];
    const { id } = await s.ingest(
      Buffer.from("finance test"),
      "print",
      "",
      "Test",
    );
    await s.db
      .query(
        "UPDATE bills SET payment_type='cash',number=?,shop=?,receipt=?,original_receipt=?,items=? WHERE id=?",
      )
      .run(
        "FIN-1",
        "Example",
        JSON.stringify(receipt),
        JSON.stringify(receipt),
        JSON.stringify([
          {
            productId: p,
            quantity: 2,
            mrp: 20,
            sellingPrice: 18,
            sourceLine: 0,
          },
        ]),
        id,
      );
    await s.decide(id, "accepted");
    expect((await finance(s, period())).summary.net).toBe(36);
    await s.deleteBill(id, (await s.bill(id)).revision, "DELETE");
    const cleared = await finance(s, period("&status=all"));
    expect(cleared.summary.net).toBe(0);
    expect(cleared.rows).toEqual([]);
    expect((await s.product(p)).stock).toBe(10000);
    const rejected = await s.ingest(
      Buffer.from(await print("73354")),
      "print",
      "",
      "Test",
    );
    await s.decide(rejected.id, "rejected");
    const bad = await s.ingest(Buffer.from("unreadable"), "print", "", "Test");
    await s.db
      .query("UPDATE bills SET received=? WHERE id=?")
      .run("2026-09-28T00:00:00Z", bad.id);
    const invalid = await finance(s, period("&status=all"));
    expect(invalid.summary.bills).toBe(1);
    expect(invalid.summary.incomplete).toBe(1);
    expect(invalid.rows[0].net).toBeNull();
    expect(invalid.summary.net).toBe(0);
    expect(financeCsv(invalid)).toContain("Amounts not available");
    invalid.rows[0].shop = '=HYPERLINK("bad")';
    expect(financeCsv(invalid)).toContain("'=HYPERLINK");
    await expect(
      finance(s, new URLSearchParams("from=2026-02-30")),
    ).rejects.toThrow("Invalid finance");
    await expect(
      finance(s, new URLSearchParams("from=2026-10-01&to=2026-09-01")),
    ).rejects.toThrow("Start date");
    await expect(finance(s, period("&status=rejected"))).rejects.toThrow(
      "Invalid finance",
    );
  } finally {
    await s.db.close();
  }
});
test("Sri Lanka month boundary is independent of the browser timezone", () => {
  expect(colomboDay(new Date("2026-09-30T19:00:00Z"))).toBe("2026-10-01");
});

test("finance totals and CSV include the whole filtered period, not just the current page", async () => {
  const s = await openTestStore();
  try {
    const text = await print("73351");
    await s.db.transaction(async () => {
      for (let i = 0; i < 6; i++)
        await s.ingest(
          Buffer.from(text.replaceAll("73351", String(94000 + i))),
          "print",
          "",
          "Test",
        );
    })();
    const page = await finance(s, period("&status=pending&size=5&page=2"));
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(6);
    expect(page.summary.net).toBe(61695.3);
    const exported = await finance(
      s,
      period("&status=pending&size=5&page=2"),
      new Date(),
      true,
    );
    expect(exported.rows).toHaveLength(6);
    expect(financeCsv(exported).split("\r\n")).toHaveLength(7);
    const one = await s.bill(exported.rows[0].id);
    await s.deleteBill(one.id, one.revision, "DELETE");
    expect((await finance(s, period("&status=pending"))).summary.net).toBe(
      51412.75,
    );
  } finally {
    await s.db.close();
  }
});
