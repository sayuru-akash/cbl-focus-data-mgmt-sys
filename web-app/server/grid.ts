import { z } from "zod";
import { AppError, type Store } from "./store";
const schema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  size: z.coerce.number().int().min(5).max(100).default(10),
  q: z.string().trim().max(200).default(""),
  status: z.string().max(30).default("all"),
  sort: z.string().max(40).default(""),
  dir: z.enum(["asc", "desc"]).default("desc"),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  customer: z.string().max(80).optional(),
  product: z.string().max(80).optional(),
});
export function grid(store: Store, kind: string, params: URLSearchParams) {
  const parsed = schema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError("Invalid table filters");
  const f = parsed.data;
  if (f.from && f.to && f.from > f.to)
    throw new AppError("Start date must be before end date");
  let source = "",
    search: string[] = [],
    sorts: Record<string, string> = {},
    date = "";
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  switch (kind) {
    case "products":
      source = `SELECT p.id,p.name,p.sku,p.unit,p.stock/1000.0 stock,p.minimum/1000.0 minimum,MIN(l.mrp)/100.0 mrp_min,MAX(l.mrp)/100.0 mrp_max FROM products p LEFT JOIN stock_lots l ON l.product_id=p.id AND l.remaining>0 WHERE p.archived=0 GROUP BY p.id`;
      search = ["name", "sku"];
      sorts = {
        name: "name COLLATE NOCASE",
        sku: "sku",
        stock: "stock",
        minimum: "minimum",
        mrp: "mrp_min",
      };
      if (!["all", "low", "available", "empty"].includes(f.status))
        throw new AppError("Invalid stock filter");
      if (f.status === "low") clauses.push("stock<=minimum");
      if (f.status === "empty") clauses.push("stock=0");
      if (f.status === "available") clauses.push("stock>0");
      break;
    case "bills":
      source = `SELECT id,number,shop,status,received,customer_id,COALESCE(json_extract(receipt,'$.date'),substr(received,1,10)) date,json_extract(receipt,'$.outletId') outlet,json_extract(receipt,'$.total') total FROM bills`;
      search = ["number", "shop", "outlet"];
      sorts = {
        number: "number",
        shop: "shop COLLATE NOCASE",
        date: "date",
        total: "total",
        status: "status",
        received: "received",
      };
      date = "date";
      if (!["all", "pending", "accepted", "rejected"].includes(f.status))
        throw new AppError("Invalid bill status");
      if (f.status !== "all") {
        clauses.push("status=?");
        args.push(f.status);
      }
      if (f.customer) {
        clauses.push("customer_id=?");
        args.push(f.customer);
      }
      break;
    case "invoices":
      source = `SELECT id,json_extract(draft,'$.number') number,json_extract(draft,'$.supplier') supplier,json_extract(draft,'$.date') date,status,json_extract(draft,'$.total') total,(SELECT COUNT(*) FROM intake_pages WHERE intake_id=i.id) pages,'invoice' kind,created FROM intakes i UNION ALL SELECT p.id,p.number,p.supplier,p.received date,p.status,NULL total,0 pages,'receipt' kind,p.created FROM purchases p WHERE NOT EXISTS(SELECT 1 FROM intakes WHERE purchase_id=p.id)`;
      search = ["number", "supplier"];
      sorts = {
        number: "number",
        supplier: "supplier COLLATE NOCASE",
        date: "date",
        status: "status",
        total: "total",
        created: "created",
        pages: "pages",
      };
      date = "date";
      if (!["all", "draft", "received"].includes(f.status))
        throw new AppError("Invalid invoice status");
      if (f.status !== "all") {
        clauses.push("status=?");
        args.push(f.status);
      }
      break;
    case "lots":
      if (!f.product) throw new AppError("Choose an item");
      source = `SELECT l.id,l.product_id,l.received,l.received_qty/1000.0 received_qty,l.remaining/1000.0 remaining,l.cost/100.0 cost,l.mrp/100.0 mrp,l.purchase_id,i.id intake_id FROM stock_lots l LEFT JOIN intakes i ON i.purchase_id=l.purchase_id`;
      search = ["received", "mrp", "cost"];
      sorts = {
        received: "received",
        received_qty: "received_qty",
        remaining: "remaining",
        cost: "cost",
        mrp: "mrp",
      };
      date = "received";
      clauses.push("product_id=?");
      args.push(f.product);
      if (!["all", "available", "empty"].includes(f.status))
        throw new AppError("Invalid batch status");
      if (f.status === "available") clauses.push("remaining>0");
      if (f.status === "empty") clauses.push("remaining=0");
      break;
    case "movements":
      if (!f.product) throw new AppError("Choose an item");
      source = `SELECT id,product_id,created,reason,delta/1000.0 delta,bill_id FROM movements`;
      search = ["reason"];
      sorts = { created: "created", reason: "reason", delta: "delta" };
      date = "substr(created,1,10)";
      clauses.push("product_id=?");
      args.push(f.product);
      break;
    case "customers":
      source = `SELECT c.*,(SELECT COUNT(*) FROM bills b WHERE b.customer_id=c.id) bill_count FROM customers c`;
      search = ["name", "outlet_id", "address", "phone"];
      sorts = {
        name: "name COLLATE NOCASE",
        outlet_id: "outlet_id",
        last_seen: "last_seen",
        bill_count: "bill_count",
      };
      date = "substr(last_seen,1,10)";
      break;
    default:
      throw new AppError("Table not found", 404);
  }
  if (f.q) {
    clauses.push(
      "(" + search.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ") + ")",
    );
    const escaped = "%" + f.q.replace(/[\\%_]/g, "\\$&") + "%";
    search.forEach(() => args.push(escaped));
  }
  if (date && f.from) {
    clauses.push(`${date}>=?`);
    args.push(f.from);
  }
  if (date && f.to) {
    clauses.push(`${date}<=?`);
    args.push(f.to);
  }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const requested =
    f.sort ||
    {
      products: "name",
      bills: "received",
      invoices: "created",
      customers: "name",
      lots: "received",
      movements: "created",
    }[kind]!;
  if (!sorts[requested]) throw new AppError("Invalid sort column");
  const base = `FROM (${source}) rows${where}`;
  const total = (
    store.db.query(`SELECT COUNT(*) total ${base}`).get(...args) as {
      total: number;
    }
  ).total;
  const page = Math.min(f.page, Math.max(1, Math.ceil(total / f.size)));
  const rows = store.db
    .query(
      `SELECT * ${base} ORDER BY ${sorts[requested]} ${f.dir === "asc" ? "ASC" : "DESC"},id ASC LIMIT ? OFFSET ?`,
    )
    .all(...args, f.size, (page - 1) * f.size);
  return { rows, total, page, size: f.size };
}
