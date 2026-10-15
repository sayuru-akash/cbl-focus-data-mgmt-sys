import { z } from "zod";
import { AppError, type Store } from "./store";
import { colomboDay } from "./discount-categories";

export const stockMarginBasisPoints = 670;
// Round half up to cents per sellable unit, preserving the agreed gross margin.
export function rdPriceCents(cost: number) {
  const denominator = BigInt(10000 - stockMarginBasisPoints);
  return (BigInt(cost) * 10000n + denominator / 2n) / denominator;
}
const filters = z.object({
  q: z.string().trim().max(200).default(""),
  status: z.enum(["all", "priced", "unpriced"]).default("all"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  size: z.coerce.number().int().min(5).max(100).default(10),
  sort: z.enum(["name", "sku", "stock", "direct", "rd"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});
export type StockValueRow = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  stock: number;
  direct: number | null;
  rd: number | null;
  unpricedStock: number;
  unpricedLots: number;
  balanceMismatch: boolean;
};
export async function stockValue(
  store: Store,
  params: URLSearchParams,
  now = new Date(),
  exportAll = false,
) {
  const parsed = filters.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError("Invalid stock value filters");
  const f = parsed.data,
    where = ["p.archived=0", "l.remaining>0"],
    args: string[] = [];
  for (const word of f.q.split(/\s+/).filter(Boolean).slice(0, 12)) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')");
    const term = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(term, term);
  }
  const lots = await store.db
    .query(
      `SELECT p.id,p.name,p.sku,p.unit,p.stock,l.remaining,l.cost FROM products p JOIN stock_lots l ON l.product_id=p.id WHERE ${where.join(" AND ")}`,
    )
    .all(...args);
  const grouped = new Map<
    string,
    {
      row: StockValueRow;
      direct: bigint;
      rd: bigint;
      priced: number;
      quantity: number;
      recorded: number;
    }
  >();
  for (const lot of lots) {
    let item = grouped.get(lot.id);
    if (!item) {
      item = {
        row: {
          id: lot.id,
          name: lot.name,
          sku: lot.sku,
          unit: lot.unit,
          stock: 0,
          direct: null,
          rd: null,
          unpricedStock: 0,
          unpricedLots: 0,
          balanceMismatch: false,
        },
        direct: 0n,
        rd: 0n,
        priced: 0,
        quantity: 0,
        recorded: lot.stock,
      };
      grouped.set(lot.id, item);
    }
    item.quantity += lot.remaining;
    if (lot.cost === null) {
      item.row.unpricedStock += lot.remaining;
      item.row.unpricedLots++;
    } else {
      item.priced += lot.remaining;
      item.direct += BigInt(lot.cost) * BigInt(lot.remaining);
      item.rd += rdPriceCents(lot.cost) * BigInt(lot.remaining);
    }
  }
  let directCents = 0n,
    rdCents = 0n,
    pricedStock = 0;
  const rows: StockValueRow[] = [];
  for (const item of grouped.values()) {
    if (f.status === "priced" && item.row.unpricedLots > 0) continue;
    if (f.status === "unpriced" && !item.row.unpricedLots) continue;
    const direct = (item.direct + 500n) / 1000n,
      rd = (item.rd + 500n) / 1000n;
    item.row.stock = item.quantity / 1000;
    item.row.unpricedStock /= 1000;
    item.row.balanceMismatch = item.quantity !== item.recorded;
    if (item.priced > 0) {
      item.row.direct = Number(direct) / 100;
      item.row.rd = Number(rd) / 100;
    }
    directCents += direct;
    rdCents += rd;
    pricedStock += item.priced;
    rows.push(item.row);
  }
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
    asOf: colomboDay(now),
    marginPercent: stockMarginBasisPoints / 100,
    summary: {
      items: rows.length,
      direct:
        rows.length > 0 && !pricedStock ? null : Number(directCents) / 100,
      rd: rows.length > 0 && !pricedStock ? null : Number(rdCents) / 100,
      unpricedLots: rows.reduce((n, r) => n + r.unpricedLots, 0),
      unpricedItems: rows.filter((r) => r.unpricedLots > 0).length,
      balanceIssues: rows.filter((r) => r.balanceMismatch).length,
    },
    total: rows.length,
    page,
    size: f.size,
    filters: { q: f.q, status: f.status },
    rows: exportAll ? rows : rows.slice((page - 1) * f.size, page * f.size),
  };
}
export type StockValueReport = Awaited<ReturnType<typeof stockValue>>;
export function stockValueCsv(report: StockValueReport) {
  const cell = (v: string | number | null, i: number) => {
    let text =
      typeof v === "number"
        ? [4, 5].includes(i)
          ? v.toFixed(2)
          : String(v)
        : v || "";
    if (typeof v === "string" && /^(?:\s*[=+@-]|[\t\r\n])/.test(text))
      text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const rows = [
    [
      "Item",
      "SKU",
      "Available",
      "Unit",
      "Direct value (Rs)",
      "RD value (Rs)",
      "Unpriced quantity",
      "Check",
    ],
    ...report.rows.map((r) => [
      r.name,
      r.sku,
      r.stock,
      r.unit,
      r.direct,
      r.rd,
      r.unpricedStock,
      r.balanceMismatch ? "Stock balance" : "",
    ]),
    ["TOTAL", "", "", "", report.summary.direct, report.summary.rd, "", ""],
  ];
  return "\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
