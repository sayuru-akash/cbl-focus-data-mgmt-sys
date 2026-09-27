import { paymentLabels } from "./payment";
import { z } from "zod";
import { AppError, type Store } from "./store";
import {
  categoryDiscounts,
  categoryDifference,
  colomboDay,
} from "./discount-categories";
const filters = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(["accepted", "pending", "all"]).default("accepted"),
  payment: z.enum(["all", "cash", "cheque", "credit", "unset"]).default("all"),
  q: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  size: z.coerce.number().int().min(5).max(100).default(10),
  sort: z
    .enum([
      "date",
      "number",
      "shop",
      "status",
      "payment_type",
      "gross",
      "discount",
      "returns",
      "net",
      "chocolate",
      "candyBar",
      "cerealBars",
    ])
    .default("date"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
const cents = (n: number) => Math.round(n * 100);
export type FinanceRow = {
  id: string;
  number: string;
  shop: string;
  date: string;
  status: string;
  payment_type: string | null;
  gross: number | null;
  discount: number | null;
  returns: number | null;
  net: number | null;
  chocolate: number | null;
  candyBar: number | null;
  cerealBars: number | null;
  issues: string[];
};
export async function finance(
  store: Store,
  params: URLSearchParams,
  now = new Date(),
  exportAll = false,
) {
  const parsed = filters.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError("Invalid finance filters");
  const f = parsed.data,
    today = colomboDay(now),
    from = f.from || today.slice(0, 7) + "-01",
    to = f.to || today;
  if (from > to) throw new AppError("Start date must be before end date");
  const where = [
      "status IN ('accepted','pending')",
      "COALESCE(NULLIF(json_extract(receipt,'$.date'),''),substr(received,1,10))>=?",
      "COALESCE(NULLIF(json_extract(receipt,'$.date'),''),substr(received,1,10))<=?",
    ],
    args: any[] = [from, to];
  if (f.status !== "all") {
    where.push("status=?");
    args.push(f.status);
  }
  if (f.payment !== "all") {
    where.push("COALESCE(payment_type,'unset')=?");
    args.push(f.payment);
  }
  if (f.q) {
    where.push(
      "(number LIKE ? ESCAPE '\\' OR shop LIKE ? ESCAPE '\\' OR json_extract(receipt,'$.outletId') LIKE ? ESCAPE '\\')",
    );
    const q = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(q, q, q);
  }
  const bills = await store.db
    .query(
      `SELECT id,number,shop,status,payment_type,received,receipt FROM bills WHERE ${where.join(" AND ")}`,
    )
    .all(...args);
  const payments = Object.keys(paymentLabels).map((type) => ({
    type,
    label: paymentLabels[type as keyof typeof paymentLabels],
    net: 0,
    bills: 0,
    incomplete: 0,
  }));
  const summary = {
    bills: bills.length,
    accepted: 0,
    drafts: 0,
    customers: 0,
    gross: 0,
    discount: 0,
    billDiscount: 0,
    skuDiscount: 0,
    lineDiscount: 0,
    returns: 0,
    freshReturns: 0,
    marketReturns: 0,
    returnReversal: 0,
    net: 0,
    chocolate: 0,
    candyBar: 0,
    cerealBars: 0,
    categoryDifference: 0,
    categoryIssues: 0,
    incomplete: 0,
    review: 0,
  };
  const monetary = [
    "gross",
    "discount",
    "billDiscount",
    "skuDiscount",
    "lineDiscount",
    "returns",
    "freshReturns",
    "marketReturns",
    "returnReversal",
    "net",
    "chocolate",
    "candyBar",
    "cerealBars",
    "categoryDifference",
  ] as const;
  const rows: FinanceRow[] = [],
    days = new Map<
      string,
      { date: string; net: number; discount: number; bills: number }
    >(),
    customers = new Set<string>(),
    freeUnits: Record<string, number> = {};
  for (const b of bills) {
    const r = JSON.parse(b.receipt || "null"),
      a = r?.accounting;
    const date = r?.date || b.received.slice(0, 10),
      issues: string[] = [];
    b.status === "accepted" ? summary.accepted++ : summary.drafts++;
    customers.add(r?.outletId || b.shop.trim().toUpperCase() || b.id);
    const row: FinanceRow = {
      id: b.id,
      number: b.number,
      shop: b.shop,
      status: b.status,
      payment_type: b.payment_type,
      date,
      gross: null,
      discount: null,
      returns: null,
      net: null,
      chocolate: null,
      candyBar: null,
      cerealBars: null,
      issues,
    };
    const payment = payments.find(
      (p) => p.type === (b.payment_type || "unset"),
    )!;
    payment.bills++;
    if (!r?.date) issues.push("Bill date missing; received date used");
    if (
      !a ||
      ![
        a.gross,
        a.discount,
        a.skuDiscount,
        a.returns,
        a.returnReversal,
        r.total,
      ].every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      summary.incomplete++;
      payment.incomplete++;
      issues.push("Amounts not available");
      rows.push(row);
      continue;
    }
    const categories = categoryDiscounts(r),
      difference = categoryDifference(r);
    const lineDiscount = (r.items || [])
      .filter((i: any) => i.kind === "sale")
      .reduce((n: number, i: any) => n + cents(i.discount || 0), 0);
    const fresh = (r.items || [])
      .filter((i: any) => i.kind === "fresh_return")
      .reduce((n: number, i: any) => n + cents(i.amount), 0);
    const market = (r.items || [])
      .filter((i: any) => i.kind === "market_return")
      .reduce((n: number, i: any) => n + cents(i.amount), 0);
    const values = {
      gross: cents(a.gross) + lineDiscount,
      discount: cents(a.discount) + cents(a.skuDiscount) + lineDiscount,
      billDiscount: cents(a.discount),
      skuDiscount: cents(a.skuDiscount),
      lineDiscount,
      returns: cents(a.returns),
      freshReturns: fresh,
      marketReturns: market,
      returnReversal: cents(a.returnReversal),
      net: cents(r.total),
      chocolate: cents(categories.chocolate),
      candyBar: cents(categories.candyBar),
      cerealBars: cents(categories.cerealBars),
      categoryDifference: cents(difference),
    };
    payment.net += values.net;
    for (const key of monetary) summary[key] += values[key];
    if (difference) {
      summary.categoryIssues++;
      issues.push("Discount categories need review");
    }
    if (
      (r.warnings?.length && !r.reviewed) ||
      a.difference ||
      values.gross - values.discount - values.returns !== values.net
    ) {
      summary.review++;
      issues.push("Check bill amounts");
    }
    for (const item of r.items || [])
      if (item.kind === "free")
        freeUnits[item.unit] = (freeUnits[item.unit] || 0) + item.quantity;
    for (const key of [
      "gross",
      "discount",
      "returns",
      "net",
      "chocolate",
      "candyBar",
      "cerealBars",
    ] as const)
      row[key] = values[key] / 100;
    const day = days.get(date) || { date, net: 0, discount: 0, bills: 0 };
    day.net += values.net;
    day.discount += values.discount;
    day.bills++;
    days.set(date, day);
    rows.push(row);
  }
  summary.customers = customers.size;
  for (const key of monetary) summary[key] /= 100;
  rows.sort((a, b) => {
    const av = a[f.sort],
      bv = b[f.sort];
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
  const page = Math.min(f.page, Math.max(1, Math.ceil(rows.length / f.size)));
  return {
    rows: exportAll ? rows : rows.slice((page - 1) * f.size, page * f.size),
    total: rows.length,
    page,
    size: f.size,
    summary,
    freeUnits,
    payments: payments.map((p) => ({ ...p, net: p.net / 100 })),
    days: [...days.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ ...d, net: d.net / 100, discount: d.discount / 100 })),
    filters: { from, to, status: f.status, q: f.q, payment: f.payment },
  };
}
export type FinanceReport = Awaited<ReturnType<typeof finance>>;

export function financeCsv(report: FinanceReport) {
  const headers = [
    "Bill",
    "Date",
    "Customer",
    "Status",
    "Payment",
    "Gross",
    "Discounts",
    "Chocolate",
    "Candy Bar",
    "Cereal Bars",
    "Return credit",
    "Net billed",
    "Review",
  ];
  const cell = (v: unknown) => {
    let text = typeof v === "number" ? v.toFixed(2) : String(v ?? "");
    if (typeof v !== "number" && /^(?:\s*[=+@-]|[\t\r\n])/.test(text))
      text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return (
    "\ufeff" +
    [
      headers,
      ...report.rows.map((r) => [
        r.number,
        r.date,
        r.shop,
        r.status,
        paymentLabels[
          (r.payment_type || "unset") as keyof typeof paymentLabels
        ],
        r.gross,
        r.discount,
        r.chocolate,
        r.candyBar,
        r.cerealBars,
        r.returns,
        r.net,
        r.issues.join("; "),
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}
