import { z } from "zod";
import { colomboDay } from "./discount-categories";
import { AppError, type Store } from "./store";

import { creditAgeBands } from "./credit-age-bands";
const filters = z.object({
  band: z
    .enum([
      "all",
      "today",
      "1-13",
      "14-20",
      "21-29",
      "30+",
      "undated",
      "future",
    ])
    .default("all"),
  q: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  size: z.coerce.number().int().min(5).max(100).default(10),
  sort: z.enum(["number", "date", "shop", "age", "net"]).default("age"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type CreditAgeRow = {
  id: string;
  number: string;
  shop: string;
  date: string;
  age: number | null;
  band: string;
  net: number | null;
  issues: string[];
};
const dayNumber = (date: string) => Date.parse(date + "T00:00:00Z") / 86400000;

export async function creditAge(
  store: Store,
  params: URLSearchParams,
  now = new Date(),
  exportAll = false,
) {
  const result = filters.safeParse(Object.fromEntries(params));
  if (!result.success) throw new AppError("Invalid credit age filters");
  const f = result.data,
    asOf = colomboDay(now);
  const where = ["status='accepted'", "payment_type='credit'"],
    args: string[] = [];
  if (f.q) {
    where.push(
      "(number LIKE ? ESCAPE '\\' OR shop LIKE ? ESCAPE '\\' OR json_extract(receipt,'$.outletId') LIKE ? ESCAPE '\\')",
    );
    const q = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(q, q, q);
  }
  const bills = await store.db
    .query(
      `SELECT id,number,shop,receipt FROM bills WHERE ${where.join(" AND ")}`,
    )
    .all(...args);
  const buckets = [
    ...creditAgeBands.map(({ key, label }) => ({
      key: key as string,
      label,
      bills: 0,
      net: 0,
      incomplete: 0,
    })),
    { key: "undated", label: "Date missing", bills: 0, net: 0, incomplete: 0 },
    { key: "future", label: "Future date", bills: 0, net: 0, incomplete: 0 },
  ];
  const rows: CreditAgeRow[] = [];
  for (const b of bills) {
    const receipt = JSON.parse(b.receipt || "null"),
      date = receipt?.date || "";
    const validDate = z.iso.date().safeParse(date).success;
    const age = validDate ? dayNumber(asOf) - dayNumber(date) : null;
    const band =
      age === null
        ? "undated"
        : age < 0
          ? "future"
          : creditAgeBands.find((b) => age >= b.min && age <= b.max)!.key;
    const net =
      typeof receipt?.total === "number" && Number.isFinite(receipt.total)
        ? Math.round(receipt.total * 100)
        : null;
    const bucket = buckets.find((b) => b.key === band)!;
    bucket.bills++;
    if (net === null) bucket.incomplete++;
    else bucket.net += net;
    const issues = [];
    if (!validDate) issues.push("Bill date missing or invalid");
    if (age !== null && age < 0) issues.push("Bill date is in the future");
    if (net === null) issues.push("Amount not available");
    rows.push({
      id: b.id,
      number: b.number,
      shop: b.shop,
      date: validDate ? date : "",
      age,
      band,
      net: net === null ? null : net / 100,
      issues,
    });
  }
  const selected = rows.filter((r) => f.band === "all" || r.band === f.band);
  selected.sort((a, b) => {
    const av = a[f.sort] || (a[f.sort] === 0 ? 0 : null),
      bv = b[f.sort] || (b[f.sort] === 0 ? 0 : null);
    if (av === null || bv === null)
      return av === bv ? a.id.localeCompare(b.id) : av === null ? 1 : -1;
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), "en", {
            numeric: true,
            sensitivity: "base",
          });
    return (f.dir === "desc" ? -cmp : cmp) || a.id.localeCompare(b.id);
  });
  const page = Math.min(
    f.page,
    Math.max(1, Math.ceil(selected.length / f.size)),
  );
  return {
    asOf,
    buckets: buckets.map((b) => ({ ...b, net: b.net / 100 })),
    total: selected.length,
    page,
    size: f.size,
    net:
      selected.reduce(
        (n, r) => n + (r.net === null ? 0 : Math.round(r.net * 100)),
        0,
      ) / 100,
    incomplete: selected.filter((r) => r.net === null).length,
    rows: exportAll
      ? selected
      : selected.slice((page - 1) * f.size, page * f.size),
    filters: { band: f.band, q: f.q },
  };
}
export type CreditAgeReport = Awaited<ReturnType<typeof creditAge>>;

export function creditAgeCsv(report: CreditAgeReport) {
  const cell = (v: string | number | null, column: number) => {
    let text =
      typeof v === "number"
        ? column === 4
          ? v.toFixed(2)
          : String(v)
        : v || "";
    if (typeof v === "string" && /^(?:\s*[=+@-]|[\t\r\n])/.test(text))
      text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return (
    "\ufeff" +
    [
      [
        "Bill",
        "Date",
        "Customer",
        "Age (days)",
        "Credit billed (Rs)",
        "As of",
        "Review",
      ],
      ...report.rows.map((r) => [
        r.number,
        r.date,
        r.shop,
        r.age,
        r.net,
        report.asOf,
        r.issues.join("; "),
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}
