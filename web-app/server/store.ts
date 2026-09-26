import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { decodePrint, parseReceipt } from "./receipt";
import { Inventory, cents, productIdentity } from "./inventory";

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new AppError(message);
};
export const string = (v: unknown, max = 200) =>
  typeof v === "string" && v.trim().length <= max
    ? v.trim()
    : fail("Invalid text");
export const units = (v: unknown) =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= 1e8 &&
  Math.abs(v * 1000 - Math.round(v * 1000)) < 0.0001
    ? Math.round(v * 1000)
    : fail("Use a positive quantity with up to 3 decimals");
export class Store {
  db: Database;
  inventory: Inventory;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,sku TEXT UNIQUE NOT NULL,name TEXT NOT NULL,unit TEXT NOT NULL,stock INTEGER NOT NULL CHECK(stock>=0),minimum INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS bills(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,raw BLOB NOT NULL,preview TEXT NOT NULL,source TEXT NOT NULL,received TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',number TEXT NOT NULL DEFAULT '',shop TEXT NOT NULL DEFAULT '',items TEXT NOT NULL DEFAULT '[]',note TEXT NOT NULL DEFAULT '',decided TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS bill_number ON bills(number) WHERE number <> '' AND status <> 'rejected';
 CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),delta INTEGER NOT NULL,reason TEXT NOT NULL,bill_id TEXT REFERENCES bills(id),created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,outlet_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,address TEXT NOT NULL,phone TEXT NOT NULL,created TEXT NOT NULL,last_seen TEXT NOT NULL);
 `);
    const productColumns = this.db
      .query("PRAGMA table_info(products)")
      .all() as { name: string }[];
    if (!productColumns.some((c) => c.name === "match_name")) {
      this.db.transaction(() => {
        this.db.exec(
          "ALTER TABLE products ADD COLUMN match_name TEXT NOT NULL DEFAULT ''",
        );
        for (const p of this.db.query("SELECT id,name FROM products").all() as {
          id: string;
          name: string;
        }[])
          this.db
            .query("UPDATE products SET match_name=? WHERE id=?")
            .run(productIdentity(p.name), p.id);
      })();
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS product_match ON products(match_name,upper(unit)) WHERE archived=0",
    );
    this.inventory = new Inventory(this);
    const columns = this.db.query("PRAGMA table_info(bills)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "revision"))
      this.db.exec(
        "ALTER TABLE bills ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
      );
    if (!columns.some((column) => column.name === "receipt"))
      this.db.exec("ALTER TABLE bills ADD COLUMN receipt TEXT");
    if (!columns.some((column) => column.name === "customer_id"))
      this.db.exec(
        "ALTER TABLE bills ADD COLUMN customer_id TEXT REFERENCES customers(id)",
      );
    this.db.transaction(() => {
      const pending = this.db
        .query("SELECT id FROM bills WHERE receipt IS NULL")
        .all() as { id: string }[];
      for (const bill of pending) this.extractReceipt(bill.id);
    })();
  }
  private extractReceipt(id: string) {
    const bill = this.db.query("SELECT * FROM bills WHERE id=?").get(id) as any;
    const decoded =
      bill.mime === "application/pdf"
        ? { preview: "", uncertain: false }
        : decodePrint(new Uint8Array(bill.raw));
    const receipt = parseReceipt(decoded.preview, decoded.uncertain);
    let customerId = bill.customer_id || null;
    if (receipt?.outletId) {
      const existing = this.db
        .query("SELECT id,last_seen FROM customers WHERE outlet_id=?")
        .get(receipt.outletId) as any;
      customerId = existing?.id || randomUUID();
      if (!existing)
        this.db
          .query("INSERT INTO customers VALUES (?,?,?,?,?,?,?)")
          .run(
            customerId,
            receipt.outletId,
            receipt.shop,
            receipt.customerAddress,
            receipt.customerPhone,
            bill.received,
            bill.received,
          );
      else if (existing.last_seen <= bill.received)
        this.db
          .query(
            "UPDATE customers SET name=?,address=?,phone=?,last_seen=? WHERE id=?",
          )
          .run(
            receipt.shop,
            receipt.customerAddress,
            receipt.customerPhone,
            bill.received,
            customerId,
          );
    }
    let number = bill.number,
      shop = bill.shop,
      items = bill.items;
    if (
      receipt &&
      bill.status === "pending" &&
      !number &&
      !shop &&
      items === "[]" &&
      !bill.note
    ) {
      shop = receipt.shop;
      if (
        this.db
          .query(
            "SELECT id FROM bills WHERE number=? AND status<>'rejected' AND id<>?",
          )
          .get(receipt.number, id)
      )
        receipt.warnings.push(
          "This invoice number already exists. Check for a reprint.",
        );
      else number = receipt.number;
      if (!receipt.warnings.length)
        items = JSON.stringify(
          receipt.items.map((item, sourceLine) => ({
            productId: this.inventory.match(item.name, item.unit),
            quantity: item.quantity,
            sourceLine,
            mrp: item.mrp ?? null,
            sellingPrice: item.rate,
          })),
        );
    }
    this.db
      .query(
        "UPDATE bills SET preview=?,receipt=?,number=?,shop=?,items=?,customer_id=? WHERE id=?",
      )
      .run(
        decoded.preview,
        JSON.stringify(receipt),
        number,
        shop,
        items,
        customerId,
        id,
      );
  }
  setting(key: string) {
    return (
      this.db.query("SELECT value FROM settings WHERE key=?").get(key) as {
        value: string;
      } | null
    )?.value;
  }
  set(key: string, value: string) {
    this.db
      .query("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run(key, value);
  }
  products() {
    return this.db
      .query(
        "SELECT * FROM products WHERE archived=0 ORDER BY name COLLATE NOCASE",
      )
      .all()
      .map((r: any) => ({
        ...r,
        stock: r.stock / 1000,
        minimum: r.minimum / 1000,
        lots: this.inventory.lots(r.id),
      }));
  }
  product(id: string) {
    return this.db
      .query("SELECT * FROM products WHERE id=? AND archived=0")
      .get(id) as any;
  }
  saveProduct(input: any, id?: string) {
    let sku = string(input.sku || "", 80).toUpperCase();
    const name = string(input.name),
      unit = string(input.unit, 30) || "pcs",
      minimum = units(input.minimum ?? 0);
    if (!name) fail("Name is required");
    const stock = units(input.stock ?? 0);
    return this.db.transaction(() => {
      if (!sku) sku = id ? this.product(id)?.sku : this.inventory.nextSku();
      if (
        this.db
          .query("SELECT id FROM products WHERE upper(sku)=? AND id<>?")
          .get(sku, id || "")
      )
        fail("This SKU already exists");
      if (id) {
        if (!this.product(id)) throw new AppError("Item not found", 404);
        if (
          this.product(id).unit.toUpperCase() !== unit.toUpperCase() &&
          this.db
            .query("SELECT id FROM movements WHERE product_id=? LIMIT 1")
            .get(id)
        )
          fail("An item with stock history keeps its original unit");
        this.db
          .query(
            "UPDATE products SET sku=?,name=?,unit=?,minimum=?,match_name=? WHERE id=?",
          )
          .run(sku, name, unit, minimum, productIdentity(name), id);
      } else {
        id = randomUUID();
        this.db
          .query(
            "INSERT INTO products(id,sku,name,unit,stock,minimum,match_name) VALUES (?,?,?,?,?,?,?)",
          )
          .run(id, sku, name, unit, stock, minimum, productIdentity(name));
        if (stock) {
          this.movement(id, stock, "Opening stock");
          this.inventory.addLot(
            id,
            stock,
            cents(input.costPrice),
            cents(input.mrp),
          );
        }
      }
      return id;
    })();
  }
  movement(
    id: string,
    delta: number,
    reason: string,
    billId: string | null = null,
  ) {
    this.db
      .query("INSERT INTO movements VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), id, delta, reason, billId, new Date().toISOString());
  }
  adjust(id: string, input: any) {
    const amount = units(Math.abs(input.quantity));
    const reason = string(input.reason, 300);
    if (!amount || !reason) fail("Quantity and reason are required");
    const delta = input.quantity < 0 ? -amount : amount;
    this.db.transaction(() => {
      const p = this.product(id);
      if (!p) throw new AppError("Item not found", 404);
      if (p.stock + delta < 0) fail("Not enough stock");
      this.inventory.adjustLots(id, delta, input);
      this.db
        .query("UPDATE products SET stock=stock+? WHERE id=?")
        .run(delta, id);
      this.movement(id, delta, reason);
    })();
  }
  archive(id: string) {
    if (!this.product(id)) throw new AppError("Item not found", 404);
    this.db.query("UPDATE products SET archived=1 WHERE id=?").run(id);
  }
  history(id: string) {
    return this.db
      .query("SELECT * FROM movements WHERE product_id=? ORDER BY created DESC")
      .all(id)
      .map((r: any) => ({ ...r, delta: r.delta / 1000 }));
  }
  ingest(raw: Uint8Array, filename: string, mime: string, source: string) {
    if (!raw.length) fail("The file is empty");
    if (raw.length > 10 * 1024 * 1024)
      throw new AppError("Maximum file size is 10 MB", 413);
    const hash = createHash("sha256").update(raw).digest("hex");
    const old = this.db
      .query("SELECT id FROM bills WHERE hash=?")
      .get(hash) as any;
    if (old) return { id: old.id, duplicate: true };
    const id = randomUUID();
    const isPdf = Buffer.from(raw.subarray(0, 5)).toString() === "%PDF-";
    const preview = isPdf
      ? ""
      : new TextDecoder("utf-8")
          .decode(raw)
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
          .slice(0, 100000);
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO bills(id,hash,filename,mime,raw,preview,source,received) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          hash,
          string(filename, 200) || "Print job",
          isPdf ? "application/pdf" : "application/octet-stream",
          raw,
          preview,
          string(source, 80),
          new Date().toISOString(),
        );
      this.extractReceipt(id);
    })();
    return { id, duplicate: false };
  }
  bills() {
    return this.db
      .query(
        "SELECT id,filename,mime,source,received,status,number,shop,items,note,decided,receipt FROM bills ORDER BY received DESC",
      )
      .all()
      .map((r: any) => ({
        ...r,
        items: JSON.parse(r.items),
        receipt: JSON.parse(r.receipt || "null"),
      }));
  }
  bill(id: string) {
    const r = this.db.query("SELECT * FROM bills WHERE id=?").get(id) as any;
    if (!r) throw new AppError("Bill not found", 404);
    return {
      ...r,
      items: JSON.parse(r.items),
      receipt: JSON.parse(r.receipt || "null"),
    };
  }
  reviewBill(id: string) {
    const b = this.bill(id);
    if (b.status === "pending")
      b.items = b.items.map((item: any) => {
        if (item.productId || item.sourceLine === undefined) return item;
        const source = b.receipt?.items[item.sourceLine];
        return source
          ? {
              ...item,
              productId: this.inventory.match(source.name, source.unit),
            }
          : item;
      });
    return b;
  }
  saveBill(id: string, input: any) {
    const number = string(input.number, 100),
      shop = string(input.shop),
      note = string(input.note ?? "", 1000);
    if (!Array.isArray(input.items) || input.items.length > 500)
      fail("Invalid bill items");
    const originalBill = this.bill(id);
    const items = input.items.map((item: any) => {
      const productId = string(item.productId, 50);
      const quantity = units(item.quantity);
      if (productId && !this.product(productId))
        fail("Choose an active stock item");
      if (!quantity) fail("Quantity must be greater than zero");
      const sourceLine = item.sourceLine;
      if (
        sourceLine !== undefined &&
        (!Number.isInteger(sourceLine) ||
          sourceLine < 0 ||
          !originalBill.receipt?.items[sourceLine])
      )
        fail("Invalid source item");
      const source =
        sourceLine === undefined
          ? null
          : originalBill.receipt.items[sourceLine];
      const mrp = cents(source?.mrp ?? item.mrp),
        sellingPrice = cents(source?.rate ?? item.sellingPrice);
      return {
        productId,
        quantity: quantity / 1000,
        mrp: mrp === null ? null : mrp / 100,
        sellingPrice: sellingPrice === null ? null : sellingPrice / 100,
        ...(sourceLine === undefined ? {} : { sourceLine }),
      };
    });
    this.db.transaction(() => {
      const current = this.bill(id);
      if (current.status !== "pending") fail("This bill is already closed");
      if (input.revision !== undefined && input.revision !== current.revision)
        throw new AppError(
          "This bill changed in another window. Reload it before saving.",
          409,
        );
      this.db
        .query(
          "UPDATE bills SET number=?,shop=?,items=?,note=?,revision=revision+1 WHERE id=?",
        )
        .run(number, shop, JSON.stringify(items), note, id);
    })();
    return { revision: this.bill(id).revision };
  }
  decide(id: string, status: "accepted" | "rejected", revision?: number) {
    return this.db.transaction(() => {
      const b = this.bill(id);
      if (b.status === status) return { unchanged: true };
      if (b.status !== "pending") fail("This bill is already closed");
      if (revision !== undefined && revision !== b.revision)
        throw new AppError(
          "This bill changed in another window. Reload it before continuing.",
          409,
        );
      if (status === "accepted") {
        if (!b.number || !b.shop || !b.items.length)
          fail("Add bill number, shop, and items first");
        const totals = new Map<string, number>();
        for (const item of b.items) {
          if (!item.productId) fail("Choose a stock item for every line");
          totals.set(
            item.productId,
            (totals.get(item.productId) || 0) + units(item.quantity),
          );
        }
        for (const [pid, qty] of totals) {
          const p = this.product(pid);
          if (!p) fail("A stock item is no longer available");
          if (p.stock < qty) fail(`Not enough stock: ${p.name}`);
        }
        this.inventory.consume(b);
        for (const [pid, qty] of totals) {
          this.db
            .query("UPDATE products SET stock=stock-? WHERE id=?")
            .run(qty, pid);
          this.movement(pid, -qty, `Bill ${b.number}`, id);
        }
      }
      this.db
        .query(
          "UPDATE bills SET status=?,decided=?,revision=revision+1 WHERE id=?",
        )
        .run(status, new Date().toISOString(), id);
      return { unchanged: false };
    })();
  }
}
