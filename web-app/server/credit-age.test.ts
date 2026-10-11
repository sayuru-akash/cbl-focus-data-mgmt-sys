import { test, expect } from "bun:test";
import { creditAge, creditAgeCsv } from "./credit-age";
import { openTestStore } from "./test-store";
import type { Store } from "./store";

const now = new Date("2026-10-11T12:00:00Z");
const dateAtAge = (age: number) =>
  new Date(Date.parse("2026-10-11T00:00:00Z") - age * 86400000)
    .toISOString()
    .slice(0, 10);
async function seed(
  s: Store,
  number: string,
  date: string,
  net: number | null = 100,
  status = "accepted",
  payment = "credit",
  shop = "EXAMPLE SHOP",
) {
  const { id } = await s.ingest(
    Buffer.from("Synthetic credit " + number),
    "test",
    "",
    "Test",
  );
  const r = {
    number,
    date,
    shop,
    outletId: "100",
    items: [],
    warnings: [],
    reviewed: true,
    version: 2,
    total: net,
    accounting: {
      gross: Math.max(0, net || 0),
      discount: 0,
      skuDiscount: 0,
      returns: Math.max(0, -(net || 0)),
      returnReversal: 0,
      difference: 0,
    },
  };
  await s.db
    .query(
      "UPDATE bills SET number=?,shop=?,receipt=?,original_receipt=?,status=?,payment_type=?,decided=? WHERE id=?",
    )
    .run(
      number,
      shop,
      JSON.stringify(r),
      JSON.stringify(r),
      status,
      payment,
      new Date().toISOString(),
      id,
    );
  return id;
}

test("credit age partitions exact calendar-day boundaries across all dates, never overlaps or counts drafts/cash/cheque", async () => {
  const s = await openTestStore();
  try {
    await s.db.transaction(async () => {
      for (const age of [0, 1, 13, 14, 20, 21, 29, 30, 31, 400])
        await seed(s, "AGE-" + age, dateAtAge(age));
      for (const [status, payment] of [
        ["pending", "credit"],
        ["rejected", "credit"],
        ["accepted", "cash"],
        ["accepted", "cheque"],
      ])
        await seed(s, status + payment, dateAtAge(40), 900, status, payment);
    })();
    const report = await creditAge(
      s,
      new URLSearchParams("from=2026-10-01&to=2026-10-11"),
      now,
    );
    expect(report.asOf).toBe("2026-10-11");
    expect(report.total).toBe(10);
    expect(report.net).toBe(1000);
    expect(report.buckets.map((b) => [b.key, b.bills, b.net])).toEqual([
      ["today", 1, 100],
      ["1-13", 2, 200],
      ["14-20", 2, 200],
      ["21-29", 2, 200],
      ["30+", 3, 300],
      ["undated", 0, 0],
      ["future", 0, 0],
    ]);
    const selectedIds: string[] = [];
    for (const band of ["today", "1-13", "14-20", "21-29", "30+"]) {
      const selected = await creditAge(s, new URLSearchParams({ band }), now);
      expect(selected.rows.every((r) => r.band === band)).toBe(true);
      expect(selected.net).toBe(
        report.buckets.find((b) => b.key === band)!.net,
      );
      selectedIds.push(...selected.rows.map((r) => r.id));
    }
    expect(new Set(selectedIds).size).toBe(10);
    expect(selectedIds).toHaveLength(10);
  } finally {
    await s.db.close();
  }
});

test("missing/future dates and unknown, zero or negative amounts stay explicit; Colombo midnight moves groups", async () => {
  const s = await openTestStore();
  try {
    await s.db.transaction(async () => {
      await seed(s, "MISSING", "", 25);
      await seed(s, "INVALID", "2026-02-30", 35);
      await seed(s, "FUTURE", "2026-10-12", 45);
      await seed(s, "NULL", dateAtAge(30), null);
      await seed(s, "ZERO", dateAtAge(30), 0);
      await seed(s, "NEGATIVE", dateAtAge(30), -10.25);
      await seed(s, "MIDNIGHT", "2026-09-28", 100);
    })();
    const report = await creditAge(s, new URLSearchParams(), now);
    expect(report.buckets.find((b) => b.key === "undated")).toMatchObject({
      bills: 2,
      net: 60,
    });
    expect(report.buckets.find((b) => b.key === "future")).toMatchObject({
      bills: 1,
      net: 45,
    });
    expect(report.buckets.find((b) => b.key === "30+")).toMatchObject({
      bills: 3,
      net: -10.25,
      incomplete: 1,
    });
    expect(report.net).toBe(194.75);
    const selected = await creditAge(
      s,
      new URLSearchParams("band=30%2B"),
      now,
      true,
    );
    expect(selected.incomplete).toBe(1);
    expect(selected.rows.find((r) => r.number === "NULL")!.net).toBeNull();
    const csv = creditAgeCsv(selected);
    expect(csv).toContain('"30","-10.25"');
    expect(csv).toContain("Amount not available");
    const before = await creditAge(
      s,
      new URLSearchParams("q=MIDNIGHT"),
      new Date("2026-10-11T18:29:59Z"),
    );
    const after = await creditAge(
      s,
      new URLSearchParams("q=MIDNIGHT"),
      new Date("2026-10-11T18:30:00Z"),
    );
    expect(before.rows[0].age).toBe(13);
    expect(after.rows[0].age).toBe(14);
    expect(after.rows[0].band).toBe("14-20");
  } finally {
    await s.db.close();
  }
});

test("search, stable pagination, sorting and CSV share full group totals; payment edits and deletion update groups", async () => {
  const s = await openTestStore();
  try {
    let first = "";
    await s.db.transaction(async () => {
      for (let i = 0; i < 6; i++) {
        const id = await seed(
          s,
          "CREDIT-" + i,
          dateAtAge(30 + i),
          100 + i,
          "accepted",
          "credit",
          i === 0 ? "=EXAMPLE" : "EXAMPLE SHOP",
        );
        if (i === 0) first = id;
      }
    })();
    const p = new URLSearchParams("band=30%2B&size=5&page=2&sort=age&dir=asc");
    const report = await creditAge(s, p, now);
    expect(report.total).toBe(6);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].number).toBe("CREDIT-5");
    expect(report.net).toBe(615);
    expect(report.buckets.find((b) => b.key === "30+")!.net).toBe(615);
    const full = await creditAge(s, p, now, true);
    expect(full.rows).toHaveLength(6);
    expect(creditAgeCsv(full).split("\r\n")).toHaveLength(7);
    expect(creditAgeCsv(full)).toContain("'=EXAMPLE");
    const search = await creditAge(
      s,
      new URLSearchParams("band=30%2B&q=CREDIT-5"),
      now,
    );
    expect(search.total).toBe(1);
    expect(search.net).toBe(105);
    expect(search.buckets.find((b) => b.key === "30+")!.net).toBe(105);
    expect((await creditAge(s, new URLSearchParams("q=%"), now)).total).toBe(0);
    const movements = await s.db
      .query("SELECT count(*) n FROM movements")
      .get();
    await s.setBillPayment(first, "cash", (await s.bill(first)).revision);
    expect((await creditAge(s, new URLSearchParams(), now)).net).toBe(515);
    await s.setBillPayment(first, "credit", (await s.bill(first)).revision);
    expect((await creditAge(s, new URLSearchParams(), now)).net).toBe(615);
    await s.deleteBill(first, (await s.bill(first)).revision, "DELETE");
    expect((await creditAge(s, new URLSearchParams(), now)).net).toBe(515);
    expect(await s.db.query("SELECT count(*) n FROM movements").get()).toEqual(
      movements,
    );
    for (const query of ["band=14", "sort=evil", "page=0", "size=999"])
      await expect(
        creditAge(s, new URLSearchParams(query), now),
      ).rejects.toThrow("Invalid credit age filters");
  } finally {
    await s.db.close();
  }
});
