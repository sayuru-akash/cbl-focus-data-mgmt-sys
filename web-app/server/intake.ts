import { invoiceCosts } from "./intake-costs";
import { createHash, randomUUID } from "node:crypto";
import { AppError, Store, string, units } from "./store";
import { cents } from "./inventory";
import { recognizePhoto } from "./ocr";
import {
  parseSupplierPage,
  packFrom,
  type IntakeDraft,
  type IntakeLine,
} from "./supplier-parser";

const fail = (message: string): never => {
  throw new AppError(message);
};
const key = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");
const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e8;
export { lineIssues, draftIssues } from "./intake-validation";
import { lineIssues, draftIssues } from "./intake-validation";
export class Intakes {
  constructor(private store: Store) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS intakes(id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'draft',draft TEXT NOT NULL,created TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,purchase_id TEXT REFERENCES purchases(id));
      CREATE TABLE IF NOT EXISTS intake_pages(id TEXT PRIMARY KEY,intake_id TEXT NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,position INTEGER NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,hash TEXT NOT NULL,raw BLOB NOT NULL,preview BLOB,ocr TEXT,error TEXT NOT NULL DEFAULT '',UNIQUE(intake_id,hash));
      CREATE TABLE IF NOT EXISTS supplier_products(tin TEXT NOT NULL,code TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id),PRIMARY KEY(tin,code));
      CREATE TABLE IF NOT EXISTS received_supplier_invoices(tin TEXT NOT NULL,number TEXT NOT NULL,intake_id TEXT NOT NULL REFERENCES intakes(id),PRIMARY KEY(tin,number));`);
  }
  list() {
    return this.store.db
      .query(
        "SELECT id,status,draft,created,revision,purchase_id FROM intakes ORDER BY created DESC",
      )
      .all()
      .map((r: any) => ({ ...r, draft: JSON.parse(r.draft) }));
  }
  get(id: string) {
    const r = this.store.db
      .query("SELECT * FROM intakes WHERE id=?")
      .get(id) as any;
    if (!r) throw new AppError("Invoice not found", 404);
    const pages = this.store.db
      .query(
        "SELECT id,position,filename,error,(ocr IS NOT NULL) AS processed FROM intake_pages WHERE intake_id=? ORDER BY position",
      )
      .all(id);
    const draft = JSON.parse(r.draft) as IntakeDraft;
    return {
      ...r,
      draft,
      pages,
      processing: this.processing.has(id),
      issues: draftIssues(draft, pages.length),
    };
  }
  page(id: string, page: string, original = false) {
    const r = this.store.db
      .query(
        "SELECT raw,preview,mime FROM intake_pages WHERE id=? AND intake_id=?",
      )
      .get(page, id) as any;
    if (!r) throw new AppError("Page not found", 404);
    return {
      bytes: original || !r.preview ? r.raw : r.preview,
      mime: original || !r.preview ? r.mime : "image/jpeg",
    };
  }
  async create(files: File[]) {
    if (!files.length || files.length > 20)
      fail("Upload 1 to 20 invoice photos");
    if (files.reduce((s, f) => s + f.size, 0) > 60 * 1024 * 1024)
      fail("Use up to 60 MB per invoice");
    const uploads: {
      id: string;
      filename: string;
      mime: string;
      raw: Uint8Array;
      hash: string;
    }[] = [];
    for (const f of files) {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(f.type) ||
        f.size > 12 * 1024 * 1024 ||
        !f.size
      )
        fail("Use JPG, PNG or WebP photos, up to 12 MB each");
      const raw = new Uint8Array(await f.arrayBuffer());
      uploads.push({
        id: randomUUID(),
        filename: string(f.name, 250),
        mime: f.type,
        raw,
        hash: createHash("sha256").update(raw).digest("hex"),
      });
    }
    if (new Set(uploads.map((f) => f.hash)).size !== uploads.length)
      fail("The same photo was selected twice");
    // An exact upload retry returns the existing draft or received invoice.
    const signature = uploads
      .map((f) => f.hash)
      .sort()
      .join(":");
    for (const r of this.store.db
      .query(
        "SELECT intake_id,group_concat(hash,':') hashes FROM (SELECT intake_id,hash FROM intake_pages ORDER BY hash) GROUP BY intake_id",
      )
      .all() as any[])
      if (r.hashes === signature) return this.get(r.intake_id);
    const id = randomUUID();
    const draft: IntakeDraft = {
      supplier: "",
      tin: "",
      number: "",
      date: "",
      gross: null,
      discount: null,
      total: null,
      pages: [],
      lines: [],
      headerReviewed: false,
    };
    this.store.db.transaction(() => {
      this.store.db
        .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
        .run(id, JSON.stringify(draft), new Date().toISOString());
      uploads.forEach((f, i) =>
        this.store.db
          .query(
            "INSERT INTO intake_pages(id,intake_id,position,filename,mime,hash,raw) VALUES (?,?,?,?,?,?,?)",
          )
          .run(f.id, id, i, f.filename, f.mime, f.hash, f.raw),
      );
    })();
    return this.get(id);
  }
  private processing = new Set<string>();
  async process(id: string) {
    const before = this.get(id);
    if (before.status !== "draft")
      fail("Received invoices cannot be processed again");
    if (before.draft.lines.length)
      fail("This draft is already processed. Review its extracted items");
    if (this.processing.size)
      throw new AppError(
        "Another invoice is processing. Try again shortly",
        409,
      );
    this.processing.add(id);
    try {
      const pages = this.store.db
        .query("SELECT * FROM intake_pages WHERE intake_id=? ORDER BY position")
        .all(id) as any[];
      const parsed = [];
      for (const p of pages) {
        try {
          const result = p.ocr
            ? { blocks: JSON.parse(p.ocr) }
            : await recognizePhoto(new Uint8Array(p.raw));
          if ("preview" in result)
            this.store.db
              .query(
                "UPDATE intake_pages SET preview=?,ocr=?,error='' WHERE id=?",
              )
              .run(result.preview, JSON.stringify(result.blocks), p.id);
          parsed.push(parseSupplierPage(result.blocks, p.position));
        } catch (error) {
          this.store.db
            .query("UPDATE intake_pages SET error=? WHERE id=?")
            .run(String(error instanceof Error ? error.message : error), p.id);
          throw error;
        }
      }
      const first = parsed[0]!,
        last = parsed.find((p) => p.total !== null) || parsed.at(-1)!;
      const draft: IntakeDraft = {
        supplier: first.supplier,
        tin: first.tin,
        number: first.invoice,
        date: first.date,
        gross: last.gross,
        discount: last.discount,
        total: last.total,
        pages: parsed.map((p) => p.fields),
        lines: parsed.flatMap((p) => p.lines),
        headerReviewed: false,
      };
      for (const line of draft.lines) {
        const mapping = this.store.db
          .query(
            "SELECT product_id FROM supplier_products WHERE tin=? AND code=?",
          )
          .get(draft.tin, key(line.code)) as any;
        if (mapping && this.store.product(mapping.product_id))
          line.productId = mapping.product_id;
      }
      this.store.db
        .query(
          "UPDATE intakes SET draft=?,revision=revision+1 WHERE id=? AND revision=?",
        )
        .run(JSON.stringify(draft), id, before.revision);
      return this.get(id);
    } finally {
      this.processing.delete(id);
    }
  }
  save(id: string, input: any) {
    const existing = this.get(id);
    if (existing.status !== "draft") fail("Received invoices cannot be edited");
    if (this.processing.has(id)) fail("Wait for photo processing to finish");
    if (input.revision !== existing.revision)
      throw new AppError("This draft changed. Reopen it before saving", 409);
    const d = input.draft as IntakeDraft;
    if (
      !d ||
      !Array.isArray(d.lines) ||
      d.lines.length > 500 ||
      !Array.isArray(d.pages) ||
      d.pages.length !== existing.pages.length
    )
      fail("Invalid invoice draft");
    for (const [field, max] of [
      ["supplier", 200],
      ["tin", 30],
      ["number", 100],
      ["date", 10],
    ] as const)
      d[field] = string(d[field], max);
    d.headerReviewed = d.headerReviewed === true;
    for (const field of ["gross", "discount", "total"] as const)
      if (d[field] !== null) cents(d[field]);
    for (const p of d.pages) {
      p.invoice = string(p.invoice, 100);
      p.document = string(p.document, 100);
      p.reviewed = p.reviewed === true;
      for (const v of [p.page, p.count])
        if (v !== null && (!Number.isInteger(v) || v < 1 || v > 20))
          fail("Invalid page number");
    }
    if (new Set(d.lines.map((l) => l.id)).size !== d.lines.length)
      fail("Duplicate invoice row");
    for (const l of d.lines) {
      for (const [field, max] of [
        ["id", 50],
        ["code", 80],
        ["description", 500],
        ["weight", 50],
        ["unit", 20],
        ["packEvidence", 200],
        ["productId", 50],
      ] as const)
        l[field] = string(l[field], max);
      l.code = key(l.code);
      l.unit = key(l.unit);
      l.reviewed = l.reviewed === true;
      if (!Number.isInteger(l.page) || l.page < 0 || l.page >= d.pages.length)
        fail("Invalid source page");
      for (const v of [l.sold, l.boxes, l.packSize])
        if (v !== null && !finite(v)) fail("Invalid quantity");
      for (const v of [l.amount, l.unitPrice, l.mrp]) if (v !== null) cents(v);
      if (l.productId && !this.store.product(l.productId))
        fail("Select an active product");
    }
    this.store.db
      .query(
        "UPDATE intakes SET draft=?,revision=revision+1 WHERE id=? AND revision=?",
      )
      .run(JSON.stringify(d), id, existing.revision);
    return this.get(id);
  }
  receive(id: string, revision: number) {
    return this.store.db.transaction(() => {
      const intake = this.get(id);
      if (intake.status === "received") return intake;
      if (intake.revision !== revision)
        throw new AppError(
          "This draft changed. Reopen it before receiving",
          409,
        );
      const d: IntakeDraft = intake.draft,
        issues = draftIssues(d, intake.pages.length);
      if (issues.length) fail(issues[0]!);
      if (
        this.store.db
          .query(
            "SELECT intake_id FROM received_supplier_invoices WHERE tin=? AND number=?",
          )
          .get(d.tin, key(d.number))
      )
        fail("This supplier invoice has already been received");
      const costs = invoiceCosts(d);
      if (!costs) fail("Check invoice amounts before receiving");
      const shares = costs!.map((c) => c.discountCents);
      const resolved = new Map<string, string>();
      const lines = d.lines.map((l, index) => {
        const mapping = this.store.db
          .query(
            "SELECT product_id FROM supplier_products WHERE tin=? AND code=?",
          )
          .get(d.tin, l.code) as any;
        let productId =
          resolved.get(l.code) || mapping?.product_id || l.productId;
        if (productId && l.productId && productId !== l.productId)
          fail(`Product code ${l.code} is already linked to another product`);
        if (productId) {
          const p = this.store.product(productId);
          if (!p || p.unit !== "PKT")
            fail(`Select an active packet product for ${l.code}`);
          const conflicting = this.store.db
            .query(
              "SELECT code FROM supplier_products WHERE tin=? AND product_id=? AND code<>?",
            )
            .get(d.tin, productId, l.code);
          if (
            conflicting ||
            [...resolved.entries()].some(
              ([code, pid]) => pid === productId && code !== l.code,
            )
          )
            fail("Different supplier codes must use separate products");
        } else {
          // Codes are supplier-scoped. Never merge products by name or price.
          const sku = `${d.tin}-${l.code}`;
          if (
            this.store.db
              .query("SELECT id FROM products WHERE upper(sku)=?")
              .get(sku.toUpperCase())
          )
            fail(`SKU ${sku} exists. Select its stock item explicitly`);
          productId = this.store.saveProduct({
            name: l.description,
            sku,
            unit: "PKT",
            stock: 0,
          });
        }
        resolved.set(l.code, productId);
        this.store.db
          .query("INSERT OR IGNORE INTO supplier_products VALUES (?,?,?)")
          .run(d.tin, l.code, productId);
        const quantity = l.sold! * l.packSize!;
        units(quantity);
        return {
          productId,
          quantity,
          mrp: l.mrp,
          costPrice: costs![index]!.costPrice,
        };
      });
      const purchase = this.store.inventory.savePurchase({
        supplier: `${d.supplier} (${d.tin})`,
        number: d.number,
        received: d.date,
        note: "From reviewed supplier invoice photos. Cost includes VAT and allocated invoice discount.",
        lines,
      });
      this.store.inventory.postPurchase(purchase.id);
      this.store.db
        .query("INSERT INTO received_supplier_invoices VALUES (?,?,?)")
        .run(d.tin, key(d.number), id);
      // Keep reviewed source amounts and exact discount shares for audit; rounded unit costs are separate.
      d.lines.forEach((l, i) => {
        l.productId = lines[i]!.productId;
      });
      this.store.db
        .query(
          "UPDATE intakes SET status='received',purchase_id=?,draft=?,revision=revision+1 WHERE id=?",
        )
        .run(
          purchase.id,
          JSON.stringify({ ...d, allocatedDiscountCents: shares }),
          id,
        );
      return this.get(id);
    })();
  }
}
