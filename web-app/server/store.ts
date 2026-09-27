import { reviewedReceipt } from "./reviewed-receipt";
import { mapAsync } from "./db";
import { openDatabase, type DataConnection } from "./db";
import { createHash, randomUUID } from "node:crypto";
import {
  decodePrint,
  parseReceipt,
  RECEIPT_VERSION,
  billReviewErrors,
} from "./receipt";
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
  Number.isInteger(v)
    ? Math.round(v * 1000)
    : fail("Use a whole-number quantity (0 or more)");
export class Store {
  inventory!: Inventory;
  private constructor(public db: DataConnection) {}
  static async open(path: string, schema = "public") {
    const store = new Store(await openDatabase(path, schema));
    await store.db.transaction(async () => {
      await store.initialize();
    })();
    return store;
  }
  private async initialize() {
    await this.db.exec(`
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,sku TEXT UNIQUE NOT NULL,name TEXT NOT NULL,unit TEXT NOT NULL,stock INTEGER NOT NULL CHECK(stock>=0),minimum INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS deleted_bills(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,deleted TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bills(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,raw BLOB NOT NULL,preview TEXT NOT NULL,source TEXT NOT NULL,received TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',number TEXT NOT NULL DEFAULT '',shop TEXT NOT NULL DEFAULT '',items TEXT NOT NULL DEFAULT '[]',note TEXT NOT NULL DEFAULT '',decided TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS bill_number ON bills(number) WHERE number <> '' AND status <> 'rejected';
 CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),delta INTEGER NOT NULL,reason TEXT NOT NULL,bill_id TEXT REFERENCES bills(id),created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bill_parse_history(id TEXT PRIMARY KEY,bill_id TEXT NOT NULL REFERENCES bills(id),receipt TEXT,items TEXT NOT NULL,revision INTEGER NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,outlet_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,address TEXT NOT NULL,phone TEXT NOT NULL,created TEXT NOT NULL,last_seen TEXT NOT NULL);
 `);
    const historyColumns = await this.db
      .query("PRAGMA table_info(bill_parse_history)")
      .all();
    if (!historyColumns.some((c) => c.name === "metadata"))
      await this.db.exec(
        "ALTER TABLE bill_parse_history ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
      );
    const productColumns = (await this.db
      .query("PRAGMA table_info(products)")
      .all()) as {
      name: string;
    }[];
    if (!productColumns.some((c) => c.name === "match_name")) {
      await this.db.transaction(async () => {
        await this.db.exec(
          "ALTER TABLE products ADD COLUMN match_name TEXT NOT NULL DEFAULT ''",
        );
        for (const p of (await this.db
          .query("SELECT id,name FROM products")
          .all()) as {
          id: string;
          name: string;
        }[])
          await this.db
            .query("UPDATE products SET match_name=? WHERE id=?")
            .run(productIdentity(p.name), p.id);
      })();
    }
    await this.db.exec(
      "CREATE INDEX IF NOT EXISTS product_match ON products(match_name,upper(unit)) WHERE archived=0",
    );
    this.inventory = new Inventory(this);
    await this.inventory.initialize();
    const columns = (await this.db.query("PRAGMA table_info(bills)").all()) as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "revision"))
      await this.db.exec(
        "ALTER TABLE bills ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
      );
    if (!columns.some((column) => column.name === "receipt"))
      await this.db.exec("ALTER TABLE bills ADD COLUMN receipt TEXT");
    if (!columns.some((column) => column.name === "original_receipt")) {
      await this.db.exec("ALTER TABLE bills ADD COLUMN original_receipt TEXT");
      await this.db.exec("UPDATE bills SET original_receipt=receipt");
    }
    if (!columns.some((column) => column.name === "customer_id"))
      await this.db.exec(
        "ALTER TABLE bills ADD COLUMN customer_id TEXT REFERENCES customers(id)",
      );
    await this.db.exec(
      "CREATE INDEX IF NOT EXISTS bills_customer_status ON bills(customer_id,status,received); CREATE INDEX IF NOT EXISTS bills_status_received ON bills(status,received)",
    );
    await this.db.transaction(async () => {
      const pending = (await this.db
        .query("SELECT id FROM bills WHERE receipt IS NULL")
        .all()) as {
        id: string;
      }[];
      for (const bill of pending) await this.extractReceipt(bill.id);
      // Upgrade only untouched drafts. Never rewrite an approved ledger or user edits.
      const older = await this.db
        .query(
          "SELECT id,receipt,items,revision FROM bills WHERE status='pending' AND revision=1 AND receipt IS NOT NULL",
        )
        .all();
      for (const bill of older) {
        const receipt = JSON.parse(bill.receipt || "null");
        if (!receipt || receipt.version === RECEIPT_VERSION) continue;
        await this.db
          .query(
            "INSERT INTO bill_parse_history(id,bill_id,receipt,items,revision,created) VALUES (?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            bill.id,
            bill.receipt,
            bill.items,
            bill.revision,
            new Date().toISOString(),
          );
        await this.extractReceipt(bill.id, true);
        await this.db
          .query("UPDATE bills SET revision=revision+1 WHERE id=?")
          .run(bill.id);
      }
    })();
  }
  private async extractReceipt(id: string, refresh = false) {
    const bill = (await this.db
      .query("SELECT * FROM bills WHERE id=?")
      .get(id)) as any;
    const decoded =
      bill.mime === "application/pdf"
        ? { preview: "", uncertain: false }
        : decodePrint(new Uint8Array(bill.raw));
    const receipt = parseReceipt(decoded.preview, decoded.uncertain);
    let customerId = bill.customer_id || null;
    // Captures may be rejected or corrected. Only link an already known outlet here.
    if (receipt?.outletId)
      customerId =
        (
          (await this.db
            .query("SELECT id FROM customers WHERE outlet_id=?")
            .get(receipt.outletId)) as any
        )?.id || null;
    let number = bill.number,
      shop = bill.shop,
      items = bill.items;
    if (
      receipt &&
      bill.status === "pending" &&
      (refresh || (!number && !shop && items === "[]" && !bill.note))
    ) {
      shop = receipt.shop;
      if (
        await this.db
          .query(
            "SELECT id FROM bills WHERE number=? AND status<>'rejected' AND id<>?",
          )
          .get(receipt.number, id)
      )
        receipt.warnings.push(
          "This invoice number already exists. Check for a reprint.",
        );
      else number = receipt.number;
      items = JSON.stringify(
        await mapAsync(receipt.items, async (item, sourceLine) => ({
          productId: await this.inventory.match(item.name, item.unit),
          quantity: item.quantity,
          sourceLine,
          mrp: item.mrp ?? null,
          sellingPrice: item.rate,
        })),
      );
    }
    await this.db
      .query(
        "UPDATE bills SET preview=?,receipt=?,original_receipt=?,number=?,shop=?,items=?,customer_id=? WHERE id=?",
      )
      .run(
        decoded.preview,
        JSON.stringify(receipt),
        JSON.stringify(receipt),
        number,
        shop,
        items,
        customerId,
        id,
      );
  }
  async setting(key: string) {
    return (
      (await this.db
        .query("SELECT value FROM settings WHERE key=?")
        .get(key)) as {
        value: string;
      } | null
    )?.value;
  }
  private async approveCustomer(bill: any) {
    const receipt = bill.receipt;
    if (!receipt?.outletId) return;
    const existing = (await this.db
      .query("SELECT * FROM customers WHERE outlet_id=?")
      .get(receipt.outletId)) as any;
    const customerId = existing?.id || randomUUID();
    if (!existing) {
      await this.db
        .query("INSERT INTO customers VALUES (?,?,?,?,?,?,?)")
        .run(
          customerId,
          receipt.outletId,
          bill.shop,
          receipt.customerAddress || "",
          receipt.customerPhone || "",
          bill.received,
          bill.received,
        );
    } else {
      const latest = (await this.db
        .query(
          "SELECT COALESCE(NULLIF(json_extract(receipt,'$.date'),''),substr(received,1,10)) date,received FROM bills WHERE customer_id=? AND status='accepted' ORDER BY date DESC,received DESC LIMIT 1",
        )
        .get(customerId)) as any;
      const billDate = receipt.date || bill.received.slice(0, 10);
      if (
        !latest ||
        billDate > latest.date ||
        (billDate === latest.date && bill.received >= latest.received)
      )
        await this.db
          .query(
            "UPDATE customers SET name=?,address=?,phone=?,last_seen=? WHERE id=?",
          )
          .run(
            bill.shop,
            receipt.customerAddress || existing.address,
            receipt.customerPhone || existing.phone,
            bill.received,
            customerId,
          );
    }
    await this.db
      .query("UPDATE bills SET customer_id=? WHERE id=?")
      .run(customerId, bill.id);
  }
  async set(key: string, value: string) {
    await this.db
      .query("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run(key, value);
  }
  async products() {
    return await mapAsync(
      await this.db
        .query(
          "SELECT * FROM products WHERE archived=0 ORDER BY name COLLATE NOCASE",
        )
        .all(),
      async (r: any) => ({
        ...r,
        stock: r.stock / 1000,
        minimum: r.minimum / 1000,
        lots: await this.inventory.lots(r.id),
      }),
    );
  }
  async product(id: string) {
    return (await this.db
      .query("SELECT * FROM products WHERE id=? AND archived=0")
      .get(id)) as any;
  }
  async saveProduct(input: any, id?: string) {
    let sku = string(input.sku || "", 80).toUpperCase();
    const name = string(input.name),
      unit = string(input.unit, 30) || "pcs",
      minimum = units(input.minimum ?? 0);
    if (!name) fail("Name is required");
    const stock = units(input.stock ?? 0);
    return await this.db.transaction(async () => {
      if (!sku)
        sku = id
          ? (await this.product(id))?.sku
          : await this.inventory.nextSku();
      if (
        await this.db
          .query("SELECT id FROM products WHERE upper(sku)=? AND id<>?")
          .get(sku, id || "")
      )
        fail("This SKU already exists");
      if (id) {
        if (!(await this.product(id)))
          throw new AppError("Item not found", 404);
        if (
          (await this.product(id)).unit.toUpperCase() !== unit.toUpperCase() &&
          (await this.db
            .query("SELECT id FROM movements WHERE product_id=? LIMIT 1")
            .get(id))
        )
          fail("An item with stock history keeps its original unit");
        await this.db
          .query(
            "UPDATE products SET sku=?,name=?,unit=?,minimum=?,match_name=? WHERE id=?",
          )
          .run(sku, name, unit, minimum, productIdentity(name), id);
      } else {
        id = randomUUID();
        await this.db
          .query(
            "INSERT INTO products(id,sku,name,unit,stock,minimum,match_name) VALUES (?,?,?,?,?,?,?)",
          )
          .run(id, sku, name, unit, stock, minimum, productIdentity(name));
        if (stock) {
          await this.movement(id, stock, "Opening stock");
          await this.inventory.addLot(
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
  async movement(
    id: string,
    delta: number,
    reason: string,
    billId: string | null = null,
  ) {
    await this.db
      .query("INSERT INTO movements VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), id, delta, reason, billId, new Date().toISOString());
  }
  async adjust(id: string, input: any) {
    const amount = units(Math.abs(input.quantity));
    const reason = string(input.reason, 300);
    if (!amount || !reason) fail("Quantity and reason are required");
    const delta = input.quantity < 0 ? -amount : amount;
    await this.db.transaction(async () => {
      const p = await this.product(id);
      if (!p) throw new AppError("Item not found", 404);
      if (p.stock + delta < 0) fail("Not enough stock");
      await this.inventory.adjustLots(id, delta, input);
      await this.db
        .query("UPDATE products SET stock=stock+? WHERE id=?")
        .run(delta, id);
      await this.movement(id, delta, reason);
    })();
  }
  async archive(id: string) {
    await this.db.transaction(async () => {
      if (!(await this.product(id))) throw new AppError("Item not found", 404);
      await this.db.query("UPDATE products SET archived=1 WHERE id=?").run(id);
    })();
  }
  async history(id: string) {
    return (
      await this.db
        .query(
          "SELECT * FROM movements WHERE product_id=? ORDER BY created DESC",
        )
        .all(id)
    ).map((r: any) => ({ ...r, delta: r.delta / 1000 }));
  }
  async ingest(
    raw: Uint8Array,
    filename: string,
    mime: string,
    source: string,
  ) {
    return this.db.transaction(async () =>
      this.ingestLocked(raw, filename, mime, source),
    )();
  }
  private async ingestLocked(
    raw: Uint8Array,
    filename: string,
    mime: string,
    source: string,
  ) {
    if (!raw.length) fail("The file is empty");
    if (raw.length > 10 * 1024 * 1024)
      throw new AppError("Maximum file size is 10 MB", 413);
    const hash = createHash("sha256").update(raw).digest("hex");
    const old = (await this.db
      .query("SELECT id FROM bills WHERE hash=?")
      .get(hash)) as any;
    if (old) return { id: old.id, duplicate: true };
    const deleted = await this.db
      .query("SELECT id FROM deleted_bills WHERE hash=?")
      .get(hash);
    if (deleted) return { id: deleted.id, duplicate: true, deleted: true };
    const id = randomUUID();
    const isPdf = Buffer.from(raw.subarray(0, 5)).toString() === "%PDF-";
    const preview = isPdf
      ? ""
      : new TextDecoder("utf-8")
          .decode(raw)
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
          .slice(0, 100000);
    await this.db.transaction(async () => {
      await this.db
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
      await this.extractReceipt(id);
    })();
    return { id, duplicate: false };
  }
  async bills() {
    return (
      await this.db
        .query(
          "SELECT id,filename,mime,source,received,status,number,shop,items,note,decided,receipt FROM bills ORDER BY received DESC",
        )
        .all()
    ).map((r: any) => ({
      ...r,
      items: JSON.parse(r.items),
      receipt: JSON.parse(r.receipt || "null"),
    }));
  }
  async bill(id: string) {
    const r = (await this.db
      .query("SELECT * FROM bills WHERE id=?")
      .get(id)) as any;
    if (!r) throw new AppError("Bill not found", 404);
    return {
      ...r,
      items: JSON.parse(r.items),
      receipt: JSON.parse(r.receipt || "null"),
      originalReceipt: JSON.parse(r.original_receipt || r.receipt || "null"),
    };
  }
  async reviewBill(id: string) {
    const b = await this.bill(id);
    if (b.status === "pending")
      b.items = await mapAsync(b.items, async (item: any) => {
        if (item.productId || item.sourceLine === undefined) return item;
        const source = b.receipt?.items[item.sourceLine];
        return source
          ? {
              ...item,
              productId: await this.inventory.match(source.name, source.unit),
            }
          : item;
      });
    return b;
  }
  async restoreBillPrint(id: string, revision: number) {
    return this.db.transaction(async () => {
      const b = await this.bill(id);
      if (b.status !== "pending") fail("This bill is already closed");
      if (revision !== b.revision)
        throw new AppError(
          "This bill changed in another window. Reload it before continuing.",
          409,
        );
      if (!b.receipt) fail("No recognized print to restore");
      await this.db
        .query(
          "INSERT INTO bill_parse_history(id,bill_id,receipt,items,revision,created) VALUES (?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          id,
          JSON.stringify(b.receipt),
          JSON.stringify(b.items),
          b.revision,
          new Date().toISOString(),
        );
      await this.extractReceipt(id, true);
      const refreshed = await this.bill(id);
      // Retain unambiguous product mappings, matched by printed identity rather than shifted index.
      for (const item of refreshed.items) {
        const source = refreshed.receipt.items[item.sourceLine];
        const matches = b.items.filter((old: any) => {
          const previous = b.receipt.items[old.sourceLine];
          return (
            old.productId &&
            previous &&
            previous.name === source.name &&
            previous.unit === source.unit &&
            previous.mrp === source.mrp &&
            (previous.kind || "sale") === source.kind
          );
        });
        if (new Set(matches.map((m: any) => m.productId)).size === 1)
          item.productId = matches[0].productId;
      }
      await this.db
        .query("UPDATE bills SET items=?,revision=revision+1 WHERE id=?")
        .run(JSON.stringify(refreshed.items), id);
      return { revision: b.revision + 1 };
    })();
  }
  async saveBill(id: string, input: any) {
    const number = string(input.number, 100),
      shop = string(input.shop),
      note = string(input.note ?? "", 1000);
    if (!Array.isArray(input.items) || input.items.length > 500)
      fail("Invalid bill items");
    const originalBill = await this.bill(id);
    const receipt =
      originalBill.receipt && input.receipt
        ? reviewedReceipt(input.receipt, originalBill.receipt, number, shop)
        : originalBill.receipt;
    const items = await mapAsync(input.items, async (item: any) => {
      const productId = string(item.productId, 50);
      const quantity = units(item.quantity);
      if (productId && !(await this.product(productId)))
        fail("Choose an active stock item");
      if (!quantity) fail("Quantity must be greater than zero");
      const sourceLine = item.sourceLine;
      if (
        sourceLine !== undefined &&
        (!Number.isInteger(sourceLine) ||
          sourceLine < 0 ||
          !receipt?.items[sourceLine])
      )
        fail("Invalid source item");
      const source =
        sourceLine === undefined ? null : receipt.items[sourceLine];
      const mrp = cents(source?.mrp ?? item.mrp),
        sellingPrice = cents(source?.rate ?? item.sellingPrice);
      if (
        item.createReturnProduct &&
        (source?.kind !== "fresh_return" || productId)
      )
        fail("New return items are only allowed for unmapped fresh returns");
      return {
        productId,
        ...(item.createReturnProduct ? { createReturnProduct: true } : {}),
        quantity: quantity / 1000,
        mrp: mrp === null ? null : mrp / 100,
        sellingPrice: sellingPrice === null ? null : sellingPrice / 100,
        ...(sourceLine === undefined ? {} : { sourceLine }),
      };
    });
    await this.db.transaction(async () => {
      const current = await this.bill(id);
      if (current.status !== "pending") fail("This bill is already closed");
      if (input.revision !== undefined && input.revision !== current.revision)
        throw new AppError(
          "This bill changed in another window. Reload it before saving.",
          409,
        );
      await this.db
        .query(
          "INSERT INTO bill_parse_history(id,bill_id,receipt,items,revision,created) VALUES (?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          id,
          JSON.stringify(current.receipt),
          JSON.stringify(current.items),
          current.revision,
          new Date().toISOString(),
        );
      await this.db
        .query(
          "UPDATE bill_parse_history SET metadata=? WHERE bill_id=? AND revision=?",
        )
        .run(
          JSON.stringify({
            number: current.number,
            shop: current.shop,
            note: current.note,
          }),
          id,
          current.revision,
        );
      await this.db
        .query(
          "UPDATE bills SET number=?,shop=?,items=?,note=?,receipt=?,revision=revision+1 WHERE id=?",
        )
        .run(
          number,
          shop,
          JSON.stringify(items),
          note,
          JSON.stringify(receipt),
          id,
        );
    })();
    return { revision: (await this.bill(id)).revision };
  }
  async deleteBill(id: string, revision: number, confirmation: string) {
    if (confirmation !== "DELETE") fail("Confirm deletion first");
    return this.db.transaction(async () => {
      if (
        await this.db.query("SELECT id FROM deleted_bills WHERE id=?").get(id)
      )
        return { unchanged: true };
      const bill = await this.bill(id);
      if (!Number.isInteger(revision) || revision !== bill.revision)
        throw new AppError(
          "This bill changed. Reload it before deleting.",
          409,
        );
      if (bill.status === "accepted") {
        const approved = Date.parse(bill.decided || "");
        if (!Number.isFinite(approved) || Date.now() > approved + 10 * 86400000)
          fail("Accepted bills can only be deleted within 10 days of approval");
        await this.inventory.reverseBill(bill);
      }
      await this.db.query("DELETE FROM allocations WHERE bill_id=?").run(id);
      await this.db.query("DELETE FROM bill_returns WHERE bill_id=?").run(id);
      await this.db.query("DELETE FROM movements WHERE bill_id=?").run(id);
      await this.db
        .query("DELETE FROM bill_parse_history WHERE bill_id=?")
        .run(id);
      // Keep only a fingerprint so delayed connector retries cannot recreate a deleted bill.
      await this.db
        .query("INSERT INTO deleted_bills VALUES (?,?,?)")
        .run(id, bill.hash, new Date().toISOString());
      await this.db.query("DELETE FROM bills WHERE id=?").run(id);
      return { unchanged: false };
    })();
  }
  async decide(id: string, status: "accepted" | "rejected", revision?: number) {
    return await this.db.transaction(async () => {
      const b = await this.bill(id);
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
        if (
          b.originalReceipt?.number &&
          (await this.db
            .query(
              "SELECT id FROM bills WHERE id<>? AND status='accepted' AND json_extract(original_receipt,'$.number')=? AND json_extract(original_receipt,'$.outletId')=?",
            )
            .get(
              id,
              b.originalReceipt.number,
              b.originalReceipt.outletId || "",
            ))
        )
          fail("This original invoice has already been accepted");
        const reviewErrors = billReviewErrors(b);
        if (reviewErrors.length) fail(reviewErrors[0]);
        await this.inventory.consume(b);
        await this.approveCustomer(b);
      }
      await this.db
        .query(
          "UPDATE bills SET status=?,decided=?,revision=revision+1 WHERE id=?",
        )
        .run(status, new Date().toISOString(), id);
      return { unchanged: false };
    })();
  }
}
