import { randomUUID } from "node:crypto";
import { AppError, units, string, type Store } from "./store";

const fail = (message: string): never => {
  throw new AppError(message);
};
export const cents = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1e8 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.00001
  )
    fail("Prices must be positive with up to 2 decimals");
  return Math.round((value as number) * 100);
};
const normalize = (value: string) =>
  value.trim().replace(/\s+/g, " ").toUpperCase();

export class Inventory {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS stock_lots(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),received_qty INTEGER NOT NULL,remaining INTEGER NOT NULL CHECK(remaining>=0),cost INTEGER,mrp INTEGER,purchase_id TEXT,received TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS stock_lots_product ON stock_lots(product_id,mrp,received,created);
      CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY,number TEXT NOT NULL,supplier TEXT NOT NULL,received TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',lines TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,posted TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS purchase_number ON purchases(lower(trim(supplier)),lower(trim(number))) WHERE number<>'';
      CREATE TABLE IF NOT EXISTS allocations(id TEXT PRIMARY KEY,bill_id TEXT NOT NULL REFERENCES bills(id),line INTEGER NOT NULL,lot_id TEXT NOT NULL REFERENCES stock_lots(id),quantity INTEGER NOT NULL,cost INTEGER,mrp INTEGER,selling_price INTEGER);
      CREATE TABLE IF NOT EXISTS product_aliases(name TEXT NOT NULL,unit TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id),PRIMARY KEY(name,unit));
    `);
    store.db.transaction(() => {
      // Migrate pre-batch stock once; unknown prices stay unknown.
      if (!store.setting("inventoryLotsMigrated")) {
        const rows = store.db
          .query("SELECT id,stock FROM products WHERE stock>0")
          .all() as any[];
        for (const row of rows)
          this.addLot(
            row.id,
            row.stock,
            null,
            null,
            null,
            new Date().toISOString().slice(0, 10),
          );
        store.set("inventoryLotsMigrated", "1");
      }
    })();
  }
  addLot(
    productId: string,
    quantity: number,
    cost: number | null,
    mrp: number | null,
    purchaseId: string | null = null,
    received = new Date().toISOString().slice(0, 10),
  ) {
    const id = randomUUID();
    this.store.db
      .query("INSERT INTO stock_lots VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        productId,
        quantity,
        quantity,
        cost,
        mrp,
        purchaseId,
        received,
        new Date().toISOString(),
      );
    return id;
  }
  lots(productId: string) {
    return (
      this.store.db
        .query(
          "SELECT * FROM stock_lots WHERE product_id=? ORDER BY received,created,rowid",
        )
        .all(productId) as any[]
    ).map((l) => ({
      ...l,
      remaining: l.remaining / 1000,
      received_qty: l.received_qty / 1000,
      costPrice: l.cost === null ? null : l.cost / 100,
      mrp: l.mrp === null ? null : l.mrp / 100,
    }));
  }
  setLotPrices(productId: string, lotId: string, input: any) {
    this.store.db.transaction(() => {
      const lot = this.store.db
        .query("SELECT * FROM stock_lots WHERE id=? AND product_id=?")
        .get(lotId, productId) as any;
      if (!lot) fail("Batch not found");
      if (
        lot.remaining !== lot.received_qty ||
        this.store.db
          .query("SELECT id FROM allocations WHERE lot_id=?")
          .get(lotId)
      )
        fail("Used batches keep their original prices");
      if (lot.purchase_id)
        fail("Received stock bills keep their original prices");
      this.store.db
        .query("UPDATE stock_lots SET cost=?,mrp=? WHERE id=?")
        .run(cents(input.costPrice), cents(input.mrp), lotId);
    })();
  }
  match(name: string, unit: string) {
    return (
      (
        this.store.db
          .query(
            "SELECT p.id FROM product_aliases a JOIN products p ON p.id=a.product_id WHERE a.name=? AND a.unit=? AND p.archived=0",
          )
          .get(normalize(name), normalize(unit)) as any
      )?.id || ""
    );
  }
  nextSku() {
    let n = Number(this.store.setting("skuSequence") || 0),
      sku: string;
    do {
      sku = `P${String(++n).padStart(6, "0")}`;
    } while (
      this.store.db.query("SELECT id FROM products WHERE upper(sku)=?").get(sku)
    );
    this.store.set("skuSequence", String(n));
    return sku;
  }
  purchases() {
    return (
      this.store.db
        .query("SELECT * FROM purchases ORDER BY created DESC")
        .all() as any[]
    ).map(this.readPurchase);
  }
  private readPurchase(row: any) {
    return { ...row, lines: JSON.parse(row.lines) };
  }
  purchase(id: string) {
    const row = this.store.db
      .query("SELECT * FROM purchases WHERE id=?")
      .get(id);
    if (!row) throw new AppError("Stock bill not found", 404);
    return this.readPurchase(row);
  }
  savePurchase(input: any, id?: string) {
    const number = string(input.number, 100),
      supplier = string(input.supplier, 200),
      received = string(input.received, 10),
      note = string(input.note || "", 1000);
    if (!number || !supplier) fail("Enter a reference and supplier");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(received) ||
      !Number.isFinite(Date.parse(received)) ||
      new Date(received).toISOString().slice(0, 10) !== received
    )
      fail("Enter a valid date");
    if (
      !Array.isArray(input.lines) ||
      !input.lines.length ||
      input.lines.length > 500
    )
      fail("Add 1 to 500 stock items");
    const lines = input.lines.map((line: any) => {
      const productId = string(line.productId || "", 50),
        quantity = units(line.quantity),
        cost = cents(line.costPrice),
        mrp = cents(line.mrp);
      if (!quantity) fail("Received quantity must be greater than zero");
      if (productId && !this.store.product(productId))
        fail("Choose an active stock item");
      const newProduct = productId
        ? undefined
        : {
            sku: string(line.newProduct?.sku || "", 80).toUpperCase(),
            name: string(line.newProduct?.name || "", 200),
            unit: string(line.newProduct?.unit || "", 30),
          };
      if (newProduct && (!newProduct.name || !newProduct.unit))
        fail("Enter a name and unit for each new item");
      const billLine = line.billLine;
      if (
        billLine !== undefined &&
        (!Number.isInteger(billLine) || billLine < 0 || billLine > 499)
      )
        fail("Invalid bill line");
      return {
        productId,
        ...(newProduct ? { newProduct } : {}),
        quantity: quantity / 1000,
        costPrice: cost === null ? null : cost / 100,
        mrp: mrp === null ? null : mrp / 100,
        ...(billLine === undefined ? {} : { billLine }),
      };
    });
    return this.store.db.transaction(() => {
      if (id && this.purchase(id).status !== "draft")
        fail("Received stock bills cannot be edited");
      const duplicate = this.store.db
        .query(
          "SELECT id FROM purchases WHERE lower(trim(supplier))=lower(?) AND lower(trim(number))=lower(?) AND id<>?",
        )
        .get(supplier, number, id || "");
      if (duplicate) fail("This supplier reference already exists");
      if (id)
        this.store.db
          .query(
            "UPDATE purchases SET number=?,supplier=?,received=?,lines=?,note=? WHERE id=?",
          )
          .run(number, supplier, received, JSON.stringify(lines), note, id);
      else {
        id = randomUUID();
        this.store.db
          .query(
            "INSERT INTO purchases(id,number,supplier,received,lines,note,created) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            id,
            number,
            supplier,
            received,
            JSON.stringify(lines),
            note,
            new Date().toISOString(),
          );
      }
      return this.purchase(id!);
    })();
  }
  deletePurchase(id: string) {
    this.store.db.transaction(() => {
      if (this.purchase(id).status !== "draft")
        fail("Received stock bills cannot be deleted");
      this.store.db.query("DELETE FROM purchases WHERE id=?").run(id);
    })();
  }
  postPurchase(id: string) {
    return this.store.db.transaction(() => {
      const purchase = this.purchase(id);
      if (purchase.status === "received") return purchase;
      for (const line of purchase.lines) {
        if (!line.productId) {
          const p = line.newProduct,
            existing = p.sku
              ? (this.store.db
                  .query("SELECT * FROM products WHERE upper(sku)=?")
                  .get(p.sku) as any)
              : null;
          if (existing) {
            if (
              existing.archived ||
              normalize(existing.name) !== normalize(p.name) ||
              normalize(existing.unit) !== normalize(p.unit)
            )
              fail("SKU already exists. Select its stock item instead");
            line.productId = existing.id;
          } else
            line.productId = this.store.saveProduct({
              ...p,
              sku: p.sku || this.nextSku(),
              stock: 0,
            });
        }
        if (!this.store.product(line.productId))
          fail("A stock item is no longer available");
        const quantity = units(line.quantity);
        this.addLot(
          line.productId,
          quantity,
          cents(line.costPrice),
          cents(line.mrp),
          id,
          purchase.received,
        );
        this.store.db
          .query("UPDATE products SET stock=stock+? WHERE id=?")
          .run(quantity, line.productId);
        this.store.movement(
          line.productId,
          quantity,
          `Stock in ${purchase.number}`,
        );
      }
      this.store.db
        .query(
          "UPDATE purchases SET status='received',lines=?,posted=? WHERE id=?",
        )
        .run(JSON.stringify(purchase.lines), new Date().toISOString(), id);
      return this.purchase(id);
    })();
  }
  plan(bill: any) {
    const remaining = new Map<string, number>(),
      allocations: any[] = [],
      issues: any[] = [];
    for (let index = 0; index < bill.items.length; index++) {
      const item = bill.items[index],
        source =
          item.sourceLine === undefined
            ? null
            : bill.receipt?.items[item.sourceLine];
      const product = this.store.product(item.productId),
        required = units(item.quantity),
        mrp = cents(source?.mrp ?? item.mrp);
      const name = product?.name || source?.name || `Item ${index + 1}`;
      if (!product) {
        issues.push({
          line: index,
          kind: "missing",
          name,
          required: required / 1000,
          available: 0,
          shortage: required / 1000,
          mrp: mrp === null ? null : mrp / 100,
          unit: source?.unit || "pcs",
        });
        continue;
      }
      if (source?.unit && normalize(source.unit) !== normalize(product.unit)) {
        issues.push({
          line: index,
          kind: "unit",
          name,
          message: `Print uses ${source.unit}; stock uses ${product.unit}. Check the item and quantity.`,
          required: required / 1000,
          available: 0,
          shortage: 0,
          mrp: mrp === null ? null : mrp / 100,
        });
        continue;
      }
      const lots = this.store.db
        .query(
          "SELECT * FROM stock_lots WHERE product_id=? AND remaining>0 ORDER BY received,created,rowid",
        )
        .all(product.id) as any[];
      if (mrp === null && new Set(lots.map((l) => l.mrp)).size > 1) {
        issues.push({
          line: index,
          kind: "price",
          name,
          message: "Choose the selling MRP for this line.",
          shortage: 0,
        });
        continue;
      }
      let missing = required,
        available = 0;
      for (const lot of lots) {
        if (mrp !== null && lot.mrp !== mrp) continue;
        const left = remaining.get(lot.id) ?? lot.remaining;
        available += left;
        const take = Math.min(left, missing);
        if (take > 0) {
          allocations.push({
            line: index,
            lotId: lot.id,
            productId: product.id,
            quantity: take,
            cost: lot.cost,
            mrp: lot.mrp,
            sellingPrice: cents(source?.rate ?? item.sellingPrice),
          });
          remaining.set(lot.id, left - take);
          missing -= take;
        }
      }
      if (missing > 0)
        issues.push({
          line: index,
          kind: "shortage",
          name,
          productId: product.id,
          required: required / 1000,
          available: available / 1000,
          shortage: missing / 1000,
          mrp: mrp === null ? null : mrp / 100,
          unit: product.unit,
        });
    }
    return { issues, allocations };
  }
  consume(bill: any) {
    const { issues, allocations } = this.plan(bill);
    if (issues.length)
      fail(
        issues[0].kind === "missing"
          ? "Choose a stock item for every line"
          : issues[0].message ||
              `Not enough stock: ${issues[0].name}${issues[0].mrp === null ? "" : ` at MRP ${issues[0].mrp}`}`,
      );
    for (const a of allocations) {
      this.store.db
        .query(
          "UPDATE stock_lots SET remaining=remaining-? WHERE id=? AND remaining>=?",
        )
        .run(a.quantity, a.lotId, a.quantity);
      this.store.db
        .query("INSERT INTO allocations VALUES (?,?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          bill.id,
          a.line,
          a.lotId,
          a.quantity,
          a.cost,
          a.mrp,
          a.sellingPrice,
        );
    }
    for (const item of bill.items) {
      const source =
        item.sourceLine === undefined
          ? null
          : bill.receipt?.items[item.sourceLine];
      if (source)
        this.store.db
          .query("INSERT OR REPLACE INTO product_aliases VALUES (?,?,?)")
          .run(normalize(source.name), normalize(source.unit), item.productId);
    }
  }
  adjustLots(productId: string, delta: number, input: any) {
    if (delta > 0) {
      this.addLot(productId, delta, cents(input.costPrice), cents(input.mrp));
      return;
    }
    const lots = this.store.db
      .query(
        "SELECT * FROM stock_lots WHERE product_id=? AND remaining>0 ORDER BY received,created,rowid",
      )
      .all(productId) as any[];
    const mrp = cents(input.mrp);
    if (mrp === null && new Set(lots.map((l) => l.mrp)).size > 1)
      fail("Choose an MRP for the adjustment");
    let left = -delta;
    for (const lot of lots) {
      if (mrp !== null && lot.mrp !== mrp) continue;
      const take = Math.min(left, lot.remaining);
      this.store.db
        .query("UPDATE stock_lots SET remaining=remaining-? WHERE id=?")
        .run(take, lot.id);
      left -= take;
      if (!left) break;
    }
    if (left) fail("Not enough stock at this MRP");
  }
}
