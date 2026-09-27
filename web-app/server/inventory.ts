import { printedIdentity } from "./product-matching";
import { lineKind, billReviewErrors } from "./receipt";
import { mapAsync } from "./db";
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
export const productIdentity = (value: string) =>
  normalize(value)
    .replace(/×/g, "X")
    .replace(/(\d+(?:\.\d+)?\s*(?:KG|G|ML|L))\s*(?:X\s*\d+\s*)+(?:EA)?$/i, "$1")
    .replace(/(\d)\s+(KG|G|ML|L)\b/g, "$1$2");
export class Inventory {
  constructor(private store: Store) {}
  static async open(store: Store) {
    const instance = new Inventory(store);
    await store.db.transaction(async () => {
      await instance.initialize();
    })();
    return instance;
  }
  async initialize() {
    const store = this.store;
    await store.db.exec(`
      CREATE TABLE IF NOT EXISTS stock_lots(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),received_qty INTEGER NOT NULL,remaining INTEGER NOT NULL CHECK(remaining>=0),cost INTEGER,mrp INTEGER,purchase_id TEXT,received TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS stock_lots_product ON stock_lots(product_id,mrp,received,created);
      CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY,number TEXT NOT NULL,supplier TEXT NOT NULL,received TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',lines TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,posted TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS purchase_number ON purchases(lower(trim(supplier)),lower(trim(number))) WHERE number<>'';
      CREATE TABLE IF NOT EXISTS allocations(id TEXT PRIMARY KEY,bill_id TEXT NOT NULL REFERENCES bills(id),line INTEGER NOT NULL,lot_id TEXT NOT NULL REFERENCES stock_lots(id),quantity INTEGER NOT NULL,cost INTEGER,mrp INTEGER,selling_price INTEGER);
      CREATE TABLE IF NOT EXISTS bill_returns(id TEXT PRIMARY KEY,bill_id TEXT NOT NULL REFERENCES bills(id),line INTEGER NOT NULL,product_id TEXT REFERENCES products(id),kind TEXT NOT NULL,name TEXT NOT NULL,unit TEXT NOT NULL,quantity INTEGER NOT NULL,mrp INTEGER,amount INTEGER NOT NULL,lot_id TEXT REFERENCES stock_lots(id),created TEXT NOT NULL,UNIQUE(bill_id,line));
      CREATE TABLE IF NOT EXISTS product_aliases(name TEXT NOT NULL,unit TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id),PRIMARY KEY(name,unit));
    `);
    await store.db.transaction(async () => {
      // Migrate pre-batch stock once; unknown prices stay unknown.
      if (!(await store.setting("inventoryLotsMigrated"))) {
        const rows = (await store.db
          .query("SELECT id,stock FROM products WHERE stock>0")
          .all()) as any[];
        for (const row of rows)
          await this.addLot(
            row.id,
            row.stock,
            null,
            null,
            null,
            new Date().toISOString().slice(0, 10),
          );
        await store.set("inventoryLotsMigrated", "1");
      }
    })();
  }
  async addLot(
    productId: string,
    quantity: number,
    cost: number | null,
    mrp: number | null,
    purchaseId: string | null = null,
    received = new Date().toISOString().slice(0, 10),
  ) {
    const id = randomUUID();
    await this.store.db
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
  async lots(productId: string) {
    return (
      (await this.store.db
        .query(
          "SELECT * FROM stock_lots WHERE product_id=? ORDER BY received,created,rowid",
        )
        .all(productId)) as any[]
    ).map((l) => ({
      ...l,
      remaining: l.remaining / 1000,
      received_qty: l.received_qty / 1000,
      costPrice: l.cost === null ? null : l.cost / 100,
      mrp: l.mrp === null ? null : l.mrp / 100,
    }));
  }
  async setLotPrices(productId: string, lotId: string, input: any) {
    await this.store.db.transaction(async () => {
      const lot = (await this.store.db
        .query("SELECT * FROM stock_lots WHERE id=? AND product_id=?")
        .get(lotId, productId)) as any;
      if (!lot) fail("Batch not found");
      if (
        lot.remaining !== lot.received_qty ||
        (await this.store.db
          .query("SELECT id FROM allocations WHERE lot_id=?")
          .get(lotId))
      )
        fail("Used batches keep their original prices");
      if (
        await this.store.db
          .query("SELECT id FROM bill_returns WHERE lot_id=?")
          .get(lotId)
      )
        fail("Returned batches keep their printed MRP");
      if (lot.purchase_id)
        fail("Received stock bills keep their original prices");
      await this.store.db
        .query("UPDATE stock_lots SET cost=?,mrp=? WHERE id=?")
        .run(cents(input.costPrice), cents(input.mrp), lotId);
    })();
  }
  async matcher() {
    // Load once per bill review; no persistent cache that could hide stock edits.
    const products = await this.store.db
      .query("SELECT id,name,unit,match_name FROM products WHERE archived=0")
      .all();
    const aliases = await this.store.db
      .query("SELECT name,unit,product_id FROM product_aliases")
      .all();
    return (name: string, unit: string): string => {
      const eligible = products.filter(
        (p) => normalize(p.unit) === normalize(unit),
      );
      const alias = aliases.find(
        (a) => a.name === normalize(name) && a.unit === normalize(unit),
      );
      if (alias && eligible.some((p) => p.id === alias.product_id))
        return alias.product_id;
      const exact = eligible.filter(
        (p) => p.match_name === productIdentity(name),
      );
      if (exact.length) return exact.length === 1 ? exact[0]!.id : "";
      const identity = printedIdentity(name);
      const normalized = eligible.filter(
        (p) => printedIdentity(p.name) === identity,
      );
      return normalized.length === 1 ? normalized[0]!.id : "";
    };
  }
  async billMatcher() {
    const identify = await this.matcher();
    const lots = await this.store.db
      .query(
        "SELECT DISTINCT product_id,mrp FROM stock_lots WHERE remaining>0 AND mrp IS NOT NULL",
      )
      .all();
    const prices = new Set(lots.map((lot) => `${lot.product_id}:${lot.mrp}`));
    return (
      name: string,
      unit: string,
      mrp: number | null | undefined,
    ): string => {
      if (mrp == null || !Number.isFinite(mrp) || mrp < 0) return "";
      const id = identify(name, unit);
      return id && prices.has(`${id}:${cents(mrp)}`) ? id : "";
    };
  }
  async match(name: string, unit: string) {
    return (await this.matcher())(name, unit);
  }
  async nextSku() {
    let n = Number((await this.store.setting("skuSequence")) || 0),
      sku: string;
    do {
      sku = `P${String(++n).padStart(6, "0")}`;
    } while (
      await this.store.db
        .query("SELECT id FROM products WHERE upper(sku)=?")
        .get(sku)
    );
    await this.store.set("skuSequence", String(n));
    return sku;
  }
  async purchases() {
    return (
      (await this.store.db
        .query("SELECT * FROM purchases ORDER BY created DESC")
        .all()) as any[]
    ).map(this.readPurchase);
  }
  private readPurchase(row: any) {
    return { ...row, lines: JSON.parse(row.lines) };
  }
  async purchase(id: string) {
    const row = await this.store.db
      .query("SELECT * FROM purchases WHERE id=?")
      .get(id);
    if (!row) throw new AppError("Stock bill not found", 404);
    return this.readPurchase(row);
  }
  async savePurchase(input: any, id?: string) {
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
    const lines = await mapAsync(input.lines, async (line: any) => {
      const productId = string(line.productId || "", 50),
        quantity = units(line.quantity),
        cost = cents(line.costPrice),
        mrp = cents(line.mrp);
      if (!quantity) fail("Received quantity must be greater than zero");
      if (productId && !(await this.store.product(productId)))
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
    return await this.store.db.transaction(async () => {
      if (id && (await this.purchase(id)).status !== "draft")
        fail("Received stock bills cannot be edited");
      const duplicate = await this.store.db
        .query(
          "SELECT id FROM purchases WHERE lower(trim(supplier))=lower(?) AND lower(trim(number))=lower(?) AND id<>?",
        )
        .get(supplier, number, id || "");
      if (duplicate) fail("This supplier reference already exists");
      if (id)
        await this.store.db
          .query(
            "UPDATE purchases SET number=?,supplier=?,received=?,lines=?,note=? WHERE id=?",
          )
          .run(number, supplier, received, JSON.stringify(lines), note, id);
      else {
        id = randomUUID();
        await this.store.db
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
      return await this.purchase(id!);
    })();
  }
  async deletePurchase(id: string) {
    await this.store.db.transaction(async () => {
      if ((await this.purchase(id)).status !== "draft")
        fail("Received stock bills cannot be deleted");
      await this.store.db.query("DELETE FROM purchases WHERE id=?").run(id);
    })();
  }
  async postPurchase(id: string) {
    return await this.store.db.transaction(async () => {
      const purchase = await this.purchase(id);
      if (purchase.status === "received") return purchase;
      for (const line of purchase.lines) {
        if (!line.productId) {
          const p = line.newProduct,
            existing = p.sku
              ? ((await this.store.db
                  .query("SELECT * FROM products WHERE upper(sku)=?")
                  .get(p.sku)) as any)
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
            line.productId = await this.store.saveProduct({
              ...p,
              sku: p.sku || (await this.nextSku()),
              stock: 0,
            });
        }
        if (!(await this.store.product(line.productId)))
          fail("A stock item is no longer available");
        const quantity = units(line.quantity);
        await this.addLot(
          line.productId,
          quantity,
          cents(line.costPrice),
          cents(line.mrp),
          id,
          purchase.received,
        );
        await this.store.db
          .query("UPDATE products SET stock=stock+? WHERE id=?")
          .run(quantity, line.productId);
        await this.store.movement(
          line.productId,
          quantity,
          `Stock in ${purchase.number}`,
        );
      }
      await this.store.db
        .query(
          "UPDATE purchases SET status='received',lines=?,posted=? WHERE id=?",
        )
        .run(JSON.stringify(purchase.lines), new Date().toISOString(), id);
      return await this.purchase(id);
    })();
  }
  async plan(bill: any) {
    const remaining = new Map<string, number>(),
      allocations: any[] = [],
      issues: any[] = billReviewErrors(bill).map((message) => ({
        kind: "review",
        message,
        name: "Check the print",
      }));
    const returnedLots = bill.items.flatMap((item: any, index: number) => {
      if (
        lineKind(bill, item) !== "fresh_return" ||
        (!item.productId && !item.createReturnProduct)
      )
        return [];
      const source = bill.receipt.items[item.sourceLine];
      return [
        {
          id: `return:${index}`,
          product_id: item.productId || `new-return:${index}`,
          remaining: units(item.quantity),
          mrp: cents(source.mrp ?? item.mrp),
          cost: null,
          received: new Date().toISOString().slice(0, 10),
          created: new Date().toISOString(),
        },
      ];
    });
    for (let index = 0; index < bill.items.length; index++) {
      const item = bill.items[index],
        source =
          item.sourceLine === undefined
            ? null
            : bill.receipt?.items[item.sourceLine];
      const kind = lineKind(bill, item);
      if (kind === "market_return" && !item.productId) continue;
      const product =
          item.createReturnProduct && kind === "fresh_return" && !item.productId
            ? {
                id: `new-return:${index}`,
                name: source.name,
                unit: source.unit,
              }
            : await this.store.product(item.productId),
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
          message:
            kind === "fresh_return"
              ? "Choose or create the item to receive this fresh return."
              : "Choose a stock item for this line.",
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
      if (kind === "market_return") continue;
      if (kind === "fresh_return") {
        if (mrp === null)
          issues.push({
            line: index,
            kind: "price",
            name,
            message: "Enter the MRP for this fresh return.",
            shortage: 0,
          });
        continue;
      }
      const lots = (await this.store.db
        .query(
          "SELECT * FROM stock_lots WHERE product_id=? AND remaining>0 ORDER BY received,created,rowid",
        )
        .all(product.id)) as any[];
      lots.push(
        ...returnedLots.filter((lot: any) => lot.product_id === product.id),
      );
      lots.sort(
        (a, b) =>
          a.received.localeCompare(b.received) ||
          a.created.localeCompare(b.created),
      );
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
  async consume(bill: any) {
    for (const item of bill.items) {
      if (!item.createReturnProduct) continue;
      const source = bill.receipt?.items[item.sourceLine];
      if (source?.kind !== "fresh_return" || item.productId)
        fail("Invalid new return item");
      const exact = await this.store.db
        .query(
          "SELECT id FROM products WHERE match_name=? AND upper(unit)=? AND archived=0 LIMIT 2",
        )
        .all(productIdentity(source.name), normalize(source.unit));
      if (exact.length > 1)
        fail("Several stock items match this return. Choose the correct item.");
      item.productId =
        exact[0]?.id ||
        (await this.store.saveProduct({
          name: source.name,
          unit: source.unit,
          stock: 0,
        }));
      delete item.createReturnProduct;
    }
    await this.store.db
      .query("UPDATE bills SET items=? WHERE id=?")
      .run(JSON.stringify(bill.items), bill.id);
    for (const item of bill.items) {
      if (item.productId && !(await this.store.product(item.productId)))
        fail("A stock item is no longer available");
    }
    const { issues, allocations } = await this.plan(bill);
    if (issues.length)
      fail(issues[0].message || `Not enough stock: ${issues[0].name}`);
    const returnIds = new Map<string, string>();
    // Fresh returns are received before outgoing allocations, in this same transaction.
    for (let index = 0; index < bill.items.length; index++) {
      const item = bill.items[index],
        kind = lineKind(bill, item);
      if (kind !== "fresh_return" && kind !== "market_return") continue;
      const source = bill.receipt.items[item.sourceLine],
        quantity = units(item.quantity),
        mrp = cents(source.mrp ?? item.mrp);
      let lotId: string | null = null;
      if (kind === "fresh_return") {
        // The print gives a selling rate, not acquisition cost. Keep unknown cost null.
        lotId = await this.addLot(item.productId, quantity, null, mrp);
        returnIds.set(`return:${index}`, lotId);
        await this.store.db
          .query("UPDATE products SET stock=stock+? WHERE id=?")
          .run(quantity, item.productId);
        await this.store.movement(
          item.productId,
          quantity,
          `Fresh return · Bill ${bill.number}`,
          bill.id,
        );
      }
      await this.store.db
        .query("INSERT INTO bill_returns VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          bill.id,
          index,
          item.productId || null,
          kind,
          source.name,
          source.unit,
          quantity,
          mrp,
          cents(source.amount),
          lotId,
          new Date().toISOString(),
        );
    }
    for (const a of allocations) {
      const lotId = returnIds.get(a.lotId) || a.lotId;
      const result = await this.store.db
        .query(
          "UPDATE stock_lots SET remaining=remaining-? WHERE id=? AND remaining>=?",
        )
        .run(a.quantity, lotId, a.quantity);
      if (result.changes !== 1)
        fail("Stock changed. Review availability again.");
      await this.store.db
        .query("INSERT INTO allocations VALUES (?,?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          bill.id,
          a.line,
          lotId,
          a.quantity,
          a.cost,
          a.mrp,
          a.sellingPrice,
        );
    }
    for (const item of bill.items) {
      const kind = lineKind(bill, item);
      if (kind === "sale" || kind === "free") {
        const qty = units(item.quantity);
        await this.store.db
          .query("UPDATE products SET stock=stock-? WHERE id=?")
          .run(qty, item.productId);
        await this.store.movement(
          item.productId,
          -qty,
          `${kind === "free" ? "Free item · " : ""}Bill ${bill.number}`,
          bill.id,
        );
      }
      const source =
        item.sourceLine === undefined
          ? null
          : bill.receipt?.items[item.sourceLine];
      if (source && item.productId)
        await this.store.db
          .query("INSERT OR REPLACE INTO product_aliases VALUES (?,?,?)")
          .run(normalize(source.name), normalize(source.unit), item.productId);
    }
  }
  async reverseBill(bill: any) {
    const allocations = await this.store.db
      .query(
        "SELECT a.*,l.product_id FROM allocations a JOIN stock_lots l ON l.id=a.lot_id WHERE a.bill_id=?",
      )
      .all(bill.id);
    const returns = await this.store.db
      .query(
        "SELECT * FROM bill_returns WHERE bill_id=? AND kind='fresh_return'",
      )
      .all(bill.id);
    for (let line = 0; line < bill.items.length; line++) {
      const item = bill.items[line],
        kind = lineKind(bill, item);
      if (
        ["sale", "free"].includes(kind) &&
        allocations
          .filter((a) => a.line === line)
          .reduce((n, a) => n + a.quantity, 0) !== units(item.quantity)
      )
        fail(
          "This bill has incomplete stock history and cannot be safely deleted.",
        );
      if (
        kind === "fresh_return" &&
        returns
          .filter((r) => r.line === line)
          .reduce((n, r) => n + r.quantity, 0) !== units(item.quantity)
      )
        fail(
          "This return has incomplete stock history and cannot be safely deleted.",
        );
    }
    // Refuse to erase a return lot used elsewhere, including manual stock reductions.
    for (const returned of returns) {
      const lot = await this.store.db
        .query("SELECT * FROM stock_lots WHERE id=?")
        .get(returned.lot_id);
      const ownUsed = allocations
        .filter((a) => a.lot_id === returned.lot_id)
        .reduce((n, a) => n + a.quantity, 0);
      const other = await this.store.db
        .query(
          "SELECT bill_id FROM allocations WHERE lot_id=? AND bill_id<>? LIMIT 1",
        )
        .get(returned.lot_id, bill.id);
      if (!lot || other || lot.remaining + ownUsed !== returned.quantity)
        fail(
          `Cannot delete: fresh-return stock for ${returned.name} has been used or adjusted. Reverse the dependent bill or adjustment first.`,
        );
    }
    for (const a of allocations) {
      const restored = await this.store.db
        .query(
          "UPDATE stock_lots SET remaining=remaining+? WHERE id=? AND remaining+?<=received_qty",
        )
        .run(a.quantity, a.lot_id, a.quantity);
      if (restored.changes !== 1)
        fail("Stock history changed. This bill cannot be safely deleted.");
      await this.store.db
        .query("UPDATE products SET stock=stock+? WHERE id=?")
        .run(a.quantity, a.product_id);
    }
    await this.store.db
      .query("DELETE FROM allocations WHERE bill_id=?")
      .run(bill.id);
    await this.store.db
      .query("DELETE FROM bill_returns WHERE bill_id=?")
      .run(bill.id);
    for (const returned of returns) {
      const removed = await this.store.db
        .query("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?")
        .run(returned.quantity, returned.product_id, returned.quantity);
      if (removed.changes !== 1)
        fail("Not enough stock to reverse this fresh return");
      await this.store.db
        .query("DELETE FROM stock_lots WHERE id=?")
        .run(returned.lot_id);
    }
  }
  async adjustLots(productId: string, delta: number, input: any) {
    if (delta > 0) {
      await this.addLot(
        productId,
        delta,
        cents(input.costPrice),
        cents(input.mrp),
      );
      return;
    }
    const lots = (await this.store.db
      .query(
        "SELECT * FROM stock_lots WHERE product_id=? AND remaining>0 ORDER BY received,created,rowid",
      )
      .all(productId)) as any[];
    const mrp = cents(input.mrp);
    if (mrp === null && new Set(lots.map((l) => l.mrp)).size > 1)
      fail("Choose an MRP for the adjustment");
    let left = -delta;
    for (const lot of lots) {
      if (mrp !== null && lot.mrp !== mrp) continue;
      const take = Math.min(left, lot.remaining);
      await this.store.db
        .query("UPDATE stock_lots SET remaining=remaining-? WHERE id=?")
        .run(take, lot.id);
      left -= take;
      if (!left) break;
    }
    if (left) fail("Not enough stock at this MRP");
  }
}
