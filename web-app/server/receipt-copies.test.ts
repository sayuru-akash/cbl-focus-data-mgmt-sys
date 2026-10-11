import { expect, test } from "bun:test";
import { parseReceipt, decodePrint, billReviewErrors } from "./receipt";
import { categoryDiscounts } from "./discount-categories";
import { finance, financeCsv } from "./finance";
import { openTestStore } from "./test-store";
import { repairRepeatedCopyCategories } from "./bill-category-repair";

const text = await Bun.file(`${import.meta.dir}/fixtures/cbl-73351.txt`).text();
const copies = (count = 2) =>
  Array.from({ length: count }, (_, i) =>
    text.replace(
      "[DUPLICATE] Copy",
      `[ORIGINAL] ${i ? "CUSTOMER" : "DISTRIBUTOR"} COPY`,
    ),
  ).join("\n");
const period = new URLSearchParams("from=2026-09-01&to=2026-09-30");

test("complete customer/distributor copies count each sale, free item and category once", () => {
  const single = parseReceipt(text)!;
  for (const count of [2, 3, 5]) {
    const repeated = parseReceipt(copies(count))!;
    expect(repeated.printCopies).toEqual({ count, identical: true });
    expect(repeated.items).toEqual(single.items);
    expect(repeated.accounting).toEqual(single.accounting);
    expect(repeated.totals).toEqual(single.totals);
    expect(categoryDiscounts(repeated)).toEqual(categoryDiscounts(single));
    expect(repeated.warnings).toEqual(single.warnings);
  }
  const returns = returnPrint();
  expect(
    parseReceipt(returns)!.items.filter((i) => i.kind === "fresh_return"),
  ).toHaveLength(1);
  expect(parseReceipt(returns)!.accounting.returnReversal).toBe(3);
  expect(parseReceipt(returns + returns)!.accounting).toEqual(
    parseReceipt(returns)!.accounting,
  );
  expect(parseReceipt(returns + returns)!.items).toEqual(
    parseReceipt(returns)!.items,
  );
});

// Synthetic return rows retain the known print pattern without live business data.
function returnPrint() {
  return text
    .replace("  FREE :", "  FRESH :")
    .replace("PKT     1     0.00       0.00", "PKT     1     63.00      63.00")
    .replace("  CATEGORY", "REVERSE GRTS (3.00)\n  CATEGORY")
    .replace(
      "Returns             :               0.00",
      "Returns             :              60.00",
    )
    .replaceAll("10,282.55", "10,222.55");
}

test("conflicting complete copies are not merged and require explicit review", () => {
  for (const changed of [
    text.replace("PKT     6", "PKT     7"),
    text.replaceAll("73351", "73352"),
    text.replace("220.05", "221.05"),
    text.replace("EXAMPLE SHOP", "OTHER SHOP"),
  ]) {
    const receipt = parseReceipt(text + changed)!;
    expect(receipt.printCopies).toEqual({ count: 2, identical: false });
    expect(receipt.items).toEqual(parseReceipt(text)!.items);
    expect(receipt.warnings.join(" ")).toContain("Printed copies differ");
    expect(
      billReviewErrors({
        number: receipt.number,
        receipt,
        items: receipt.items.map((i, sourceLine) => ({
          sourceLine,
          quantity: i.quantity,
        })),
      }).join(" "),
    ).toContain("Printed copies differ");
  }
});

test("ordinary continuation pages and genuinely repeated rows remain intact; truncated copies warn", () => {
  const repeatedLine =
    " 1  CHOCO-LA CRISPIES 45G   MRP 100.00\n          PKT     6     90.00      540.00\n";
  const single = parseReceipt(text)!;
  const withRepeatedRow = parseReceipt(
    text.replace("NET TOTAL B/F RETURN", repeatedLine + "NET TOTAL B/F RETURN"),
  )!;
  expect(withRepeatedRow.items.length).toBe(single.items.length + 1);
  const split = text.indexOf(" 10 ");
  const pages =
    text.slice(0, split) +
    "INVOICE\nBill date : 2026-09-28\nSerial No : 73351\n" +
    text.slice(split);
  expect(parseReceipt(pages)!.items).toEqual(single.items);
  expect(parseReceipt(pages)!.printCopies).toBeUndefined();
  const truncated = parseReceipt(text + text.slice(0, split))!;
  expect(truncated.printCopies).toBeUndefined();
  expect(truncated.warnings.join(" ")).toContain("Multiple invoice copies");
  const raw = Buffer.concat([
    Buffer.from([27, 64]),
    Buffer.from(copies()),
    Buffer.from([29, 97, 0]),
  ]);
  expect(parseReceipt(decodePrint(raw).preview)!.items).toEqual(single.items);
});

test("copy capture acceptance, retries and separate reprints never deduct twice", async () => {
  const s = await openTestStore();
  try {
    const single = parseReceipt(text)!;
    for (const line of single.items.filter(
      (i) => i.kind === "sale" || i.kind === "free",
    ))
      if (!(await s.products()).some((p) => p.name === line.name))
        await s.saveProduct({
          name: line.name,
          unit: line.unit,
          stock: 1000,
          mrp: line.mrp,
        });
    const { id } = await s.ingest(Buffer.from(copies()), "copies", "", "Test");
    const b = await s.reviewBill(id);
    expect(b.receipt.items).toEqual(single.items);
    await s.saveBill(id, {
      ...b,
      payment_type: "cash",
      receipt: { ...b.receipt, reviewed: true },
    });
    await s.decide(id, "accepted");
    const movements = await s.db
      .query("SELECT * FROM movements ORDER BY id")
      .all();
    for (const product of await s.products()) {
      const demand = single.items
        .filter((i) => i.name === product.name)
        .reduce((n, i) => n + i.quantity, 0);
      expect(product.stock).toBe(1000 - demand);
    }
    expect(await s.decide(id, "accepted")).toEqual({ unchanged: true });
    expect(await s.ingest(Buffer.from(copies()), "retry", "", "Test")).toEqual({
      id,
      duplicate: true,
    });
    const reprint = await s.ingest(Buffer.from(text), "one copy", "", "Test");
    const other = await s.reviewBill(reprint.id);
    await s.saveBill(reprint.id, {
      ...other,
      number: "RENAMED",
      payment_type: "cash",
      receipt: { ...other.receipt, reviewed: true },
    });
    await expect(s.decide(reprint.id, "accepted")).rejects.toThrow(
      "original invoice has already been accepted",
    );
    expect(
      await s.db.query("SELECT * FROM movements ORDER BY id").all(),
    ).toEqual(movements);
    const report = await finance(s, period);
    expect(report.summary.categoryIssues).toBe(0);
    expect(report.summary.net).toBe(single.total!);
    expect(report.summary.discount).toBe(387.45);
    expect(report.summary.chocolate).toBe(220.05);
    expect(financeCsv(report)).toContain('"220.05","145.80","21.60"');
    await s.deleteBill(id, (await s.bill(id)).revision, "DELETE");
    expect((await finance(s, period)).summary.bills).toBe(0);
    expect((await s.products()).every((p) => p.stock === 1000)).toBe(true);
  } finally {
    await s.db.close();
  }
});

test("authorized legacy category repair preserves accepted amounts, stock and original evidence and is idempotent", async () => {
  const s = await openTestStore();
  try {
    const { id } = await s.ingest(Buffer.from(copies()), "legacy", "", "Test");
    const b = await s.bill(id);
    const legacy = {
      ...b.receipt,
      reviewed: true,
      categoryDiscounts: {
        chocolate: 440.1,
        candyBar: 291.6,
        cerealBars: 43.2,
      },
      totals: [...b.receipt.totals, ...b.receipt.totals],
    };
    await s.db
      .query(
        "UPDATE bills SET receipt=?,original_receipt=?,status='accepted' WHERE id=?",
      )
      .run(JSON.stringify(legacy), JSON.stringify(legacy), id);
    const before = await s.db.query("SELECT * FROM bills WHERE id=?").get(id);
    await expect(
      repairRepeatedCopyCategories(s.db, id, before.revision + 1),
    ).rejects.toThrow("revision changed");
    expect((await finance(s, period)).summary.categoryIssues).toBe(1);
    await repairRepeatedCopyCategories(s.db, id, before.revision);
    const after = await s.db.query("SELECT * FROM bills WHERE id=?").get(id);
    expect({
      ...after,
      receipt: before.receipt,
      revision: before.revision,
    }).toEqual(before);
    expect({
      ...JSON.parse(after.receipt),
      categoryDiscounts: legacy.categoryDiscounts,
    }).toEqual(legacy);
    expect((await finance(s, period)).summary).toMatchObject({
      categoryIssues: 0,
      categoryDifference: 0,
      net: 10282.55,
      discount: 387.45,
    });
    expect(
      await repairRepeatedCopyCategories(s.db, id, after.revision),
    ).toEqual({ unchanged: true });
    const history = await s.db
      .query("SELECT * FROM bill_parse_history WHERE bill_id=?")
      .all(id);
    expect(history).toHaveLength(1);
    expect(history[0].receipt).toBe(before.receipt);
    expect(await s.db.query("SELECT count(*) n FROM movements").get()).toEqual({
      n: 0,
    });
    // Manual category edits and mismatched deductions cannot be silently overwritten.
    await s.db
      .query("UPDATE bills SET receipt=? WHERE id=?")
      .run(
        JSON.stringify({
          ...legacy,
          categoryDiscounts: { ...legacy.categoryDiscounts, chocolate: 441 },
        }),
        id,
      );
    await expect(
      repairRepeatedCopyCategories(s.db, id, after.revision),
    ).rejects.toThrow("not the repeated printed breakdown");
    await s.db
      .query("UPDATE bills SET receipt=? WHERE id=?")
      .run(
        JSON.stringify({
          ...legacy,
          accounting: { ...legacy.accounting, discount: 221.05 },
        }),
        id,
      );
    await expect(
      repairRepeatedCopyCategories(s.db, id, after.revision),
    ).rejects.toThrow("do not reconcile");
    expect(
      await s.db.query("SELECT count(*) n FROM bill_parse_history").get(),
    ).toEqual({ n: 1 });
  } finally {
    await s.db.close();
  }
});
