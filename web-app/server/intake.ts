import { PhotoStorage } from "./photos";
import { mapAsync } from "./db";
import { invoiceCosts } from "./intake-costs";
import { createHash, randomUUID } from "node:crypto";
import { AppError, Store, string, units } from "./store";
import { cents } from "./inventory";
import { recognizePhoto } from "./ocr";
import { parseExtractedPage, extractedPage } from "./ocr-vision";
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
import { lineIssues, draftIssues, draftValidation } from "./intake-validation";
export class Intakes {
  constructor(
    private store: Store,
    private photos?: PhotoStorage,
  ) {}
  static async open(store: Store, photos?: PhotoStorage) {
    const instance = new Intakes(store, photos);
    await store.db.transaction(async () => {
      await instance.initialize();
    })();
    return instance;
  }
  async initialize() {
    const store = this.store;
    await store.db
      .exec(`CREATE TABLE IF NOT EXISTS intakes(id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'draft',draft TEXT NOT NULL,created TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,purchase_id TEXT REFERENCES purchases(id));
      CREATE TABLE IF NOT EXISTS intake_pages(id TEXT PRIMARY KEY,intake_id TEXT NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,position INTEGER NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,hash TEXT NOT NULL,raw BLOB NOT NULL,preview BLOB,ocr TEXT,error TEXT NOT NULL DEFAULT '',UNIQUE(intake_id,hash));
      CREATE TABLE IF NOT EXISTS supplier_products(tin TEXT NOT NULL,code TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id),PRIMARY KEY(tin,code));
      CREATE INDEX IF NOT EXISTS supplier_product_lookup ON supplier_products(product_id);
      CREATE TABLE IF NOT EXISTS received_supplier_invoices(tin TEXT NOT NULL,number TEXT NOT NULL,intake_id TEXT NOT NULL REFERENCES intakes(id),PRIMARY KEY(tin,number));`);
    const columns = await store.db
      .query("PRAGMA table_info(intake_pages)")
      .all();
    for (const name of ["object_key", "preview_key"])
      if (!columns.some((c) => c.name === name))
        await store.db.exec(`ALTER TABLE intake_pages ADD COLUMN ${name} TEXT`);
    const intakeColumns = await store.db
      .query("PRAGMA table_info(intakes)")
      .all();
    if (!intakeColumns.some((c) => c.name === "processing_until"))
      await store.db.exec(
        "ALTER TABLE intakes ADD COLUMN processing_until INTEGER NOT NULL DEFAULT 0",
      );
    if (!intakeColumns.some((c) => c.name === "photos_removed"))
      await store.db.exec(
        "ALTER TABLE intakes ADD COLUMN photos_removed INTEGER NOT NULL DEFAULT 0",
      );
    await store.db
      .exec(`CREATE TABLE IF NOT EXISTS photo_gc(key TEXT PRIMARY KEY,after_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS photo_uploads(id TEXT PRIMARY KEY,files TEXT NOT NULL,expires INTEGER NOT NULL,intake_id TEXT REFERENCES intakes(id));`);
  }
  async cleanupPhotos() {
    if (!this.photos) return;
    const pending = await this.store.db
      .query("SELECT key FROM photo_gc WHERE after_ms<=? LIMIT 100")
      .all(Date.now());
    if (pending.length) {
      await this.photos.delete(pending.map((p) => p.key));
      await this.store.db.transaction(async () => {
        for (const p of pending)
          await this.store.db
            .query("DELETE FROM photo_gc WHERE key=?")
            .run(p.key);
      })();
    }
    await this.store.db
      .query("DELETE FROM photo_uploads WHERE expires<?")
      .run(Date.now() - 86400000);
  }
  async prepareUpload(input: any) {
    if (!this.photos) return { local: true };
    const files = input.files;
    if (!Array.isArray(files) || !files.length || files.length > 20)
      fail("Upload 1 to 20 invoice photos");
    let size = 0;
    const id = randomUUID();
    const entries: {
      name: string;
      size: number;
      mime: string;
      hash: string;
      key: string;
    }[] = files.map((f: any) => {
      if (
        !Number.isInteger(f.size) ||
        f.size < 1 ||
        f.size > 12 * 1024 * 1024 ||
        !["image/jpeg", "image/png", "image/webp"].includes(f.mime) ||
        !/^[a-f0-9]{64}$/.test(f.hash)
      )
        fail("Use JPG, PNG or WebP photos, up to 12 MB each");
      size += f.size;
      return {
        name: string(f.name, 250),
        size: f.size,
        mime: f.mime,
        hash: f.hash,
        key: `staging/${id}/${randomUUID()}`,
      };
    });
    if (size > 60 * 1024 * 1024) fail("Use up to 60 MB per invoice");
    if (new Set(entries.map((f) => f.hash)).size !== entries.length)
      fail("The same photo was selected twice");
    await this.store.db.transaction(async () => {
      await this.store.db
        .query("INSERT INTO photo_uploads(id,files,expires) VALUES (?,?,?)")
        .run(id, JSON.stringify(entries), Date.now() + 3600000);
      for (const f of entries)
        await this.store.db
          .query("INSERT INTO photo_gc VALUES (?,?)")
          .run(f.key, Date.now() + 86400000);
    })();
    return {
      id,
      files: await mapAsync(entries, async (f) => ({
        url: await this.photos!.uploadUrl(f.key, f.mime, f.hash),
        headers: {
          "Content-Type": f.mime,
          "x-amz-checksum-sha256": Buffer.from(f.hash, "hex").toString(
            "base64",
          ),
        },
      })),
    };
  }
  async completeUpload(id: string) {
    if (!this.photos) fail("Photo storage is not configured");
    const session = await this.store.db
      .query("SELECT * FROM photo_uploads WHERE id=?")
      .get(id);
    if (!session)
      throw new AppError("Upload expired. Select the photos again", 410);
    if (session.intake_id) return this.get(session.intake_id);
    if (session.expires < Date.now())
      throw new AppError("Upload expired. Select the photos again", 410);
    const files: File[] = [];
    for (const entry of JSON.parse(session.files)) {
      const meta = await this.photos!.head(entry.key);
      if (meta.size !== entry.size || meta.mime !== entry.mime)
        fail("Photo upload is incomplete. Try again");
      const bytes = await this.photos!.read(entry.key);
      if (createHash("sha256").update(bytes).digest("hex") !== entry.hash)
        fail("Photo upload is incomplete. Try again");
      files.push(
        new File([bytes as BlobPart], entry.name, { type: entry.mime }),
      );
    }
    const intake = await this.create(files);
    await this.store.db
      .query("UPDATE photo_uploads SET intake_id=? WHERE id=?")
      .run(intake.id, id);
    for (const entry of JSON.parse(session.files))
      await this.store.db
        .query("UPDATE photo_gc SET after_ms=? WHERE key=?")
        .run(Date.now(), entry.key);
    await this.cleanupPhotos().catch(() => {});
    return intake;
  }
  async list() {
    return (
      await this.store.db
        .query(
          "SELECT id,status,draft,created,revision,purchase_id FROM intakes ORDER BY created DESC",
        )
        .all()
    ).map((r: any) => ({ ...r, draft: JSON.parse(r.draft) }));
  }
  async get(id: string) {
    const r = (await this.store.db
      .query("SELECT * FROM intakes WHERE id=?")
      .get(id)) as any;
    if (!r) throw new AppError("Invoice not found", 404);
    const pages = await this.store.db
      .query(
        "SELECT id,position,filename,error,(ocr IS NOT NULL) AS processed FROM intake_pages WHERE intake_id=? ORDER BY position",
      )
      .all(id);
    const draft = JSON.parse(r.draft) as IntakeDraft;
    return {
      ...r,
      draft,
      pages,
      processing: r.processing_until > Date.now(),
      issues: draftIssues(draft, pages.length),
      ...draftValidation(draft, pages.length),
    };
  }
  async page(id: string, page: string, original = false) {
    const r = (await this.store.db
      .query(
        "SELECT p.* FROM intake_pages p JOIN intakes i ON i.id=p.intake_id WHERE p.id=? AND p.intake_id=? AND i.photos_removed=0",
      )
      .get(page, id)) as any;
    if (!r) throw new AppError("Photos are removed after approval", 410);
    const objectKey = original ? r.object_key : r.preview_key || r.object_key;
    if (objectKey && this.photos)
      return {
        url: await this.photos.downloadUrl(objectKey),
        bytes: null,
        mime: r.mime,
      };
    return {
      url: null,
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
    for (const r of (await this.store.db
      .query(
        "SELECT intake_id,group_concat(hash,':') hashes FROM (SELECT intake_id,hash FROM intake_pages ORDER BY hash) GROUP BY intake_id",
      )
      .all()) as any[])
      if (r.hashes === signature) return await this.get(r.intake_id);
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
    if (this.photos)
      for (const f of uploads) {
        const objectKey = `drafts/${id}/${f.id}`;
        await this.store.db
          .query("INSERT INTO photo_gc VALUES (?,?)")
          .run(objectKey, Date.now() + 86400000);
        await this.photos.put(objectKey, f.raw, f.mime);
      }
    const chosen = await this.store.db.transaction(async () => {
      // Recheck under the cross-instance write lock, including overlapping upload retries.
      const prior = await this.store.db
        .query(
          "SELECT intake_id,group_concat(hash,':') hashes FROM (SELECT intake_id,hash FROM intake_pages ORDER BY hash) GROUP BY intake_id",
        )
        .all();
      const duplicate = prior.find((r) => r.hashes === signature);
      if (duplicate) return duplicate.intake_id as string;

      await this.store.db
        .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
        .run(id, JSON.stringify(draft), new Date().toISOString());
      await mapAsync(
        uploads,
        async (f, i) =>
          await this.store.db
            .query(
              "INSERT INTO intake_pages(id,intake_id,position,filename,mime,hash,raw,object_key) VALUES (?,?,?,?,?,?,?,?)",
            )
            .run(
              f.id,
              id,
              i,
              f.filename,
              f.mime,
              f.hash,
              this.photos ? new Uint8Array() : f.raw,
              this.photos ? `drafts/${id}/${f.id}` : null,
            ),
      );
      if (this.photos)
        for (const f of uploads)
          await this.store.db
            .query("DELETE FROM photo_gc WHERE key=?")
            .run(`drafts/${id}/${f.id}`);
      return id;
    })();
    return await this.get(chosen);
  }
  async process(id: string) {
    const before = await this.get(id);
    if (before.status !== "draft")
      fail("Received invoices cannot be processed again");
    if (before.draft.lines.length)
      fail("This draft is already processed. Review its extracted items");
    const leaseUntil = Date.now() + 330000;
    const lease = await this.store.db
      .query(
        "UPDATE intakes SET processing_until=? WHERE id=? AND processing_until<? AND status='draft' AND revision=?",
      )
      .run(leaseUntil, id, Date.now(), before.revision);
    if (!lease.changes)
      throw new AppError(
        "This invoice is being processed. Try again shortly",
        409,
      );
    try {
      const pages = (await this.store.db
        .query("SELECT * FROM intake_pages WHERE intake_id=? ORDER BY position")
        .all(id)) as any[];
      const parsed = [];
      let processedNew = false;
      for (const p of pages) {
        if (!p.ocr && processedNew)
          return { ...(await this.get(id)), processing: false, more: true };
        try {
          const cached = p.ocr ? JSON.parse(p.ocr) : null;
          const result = cached
            ? Array.isArray(cached)
              ? { blocks: cached }
              : {
                  blocks: cached.blocks,
                  extracted: extractedPage.parse(cached.extracted),
                }
            : await recognizePhoto(
                p.object_key && this.photos
                  ? await this.photos.read(p.object_key)
                  : new Uint8Array(p.raw),
              );
          const page =
            "extracted" in result && result.extracted
              ? parseExtractedPage(result.extracted, p.position)
              : parseSupplierPage(result.blocks, p.position);
          if (!page.lines.length)
            throw new AppError(
              "No items could be read. Use a clearer photo and try again.",
              422,
            );
          if ("preview" in result) {
            processedNew = true;
            const previewKey = this.photos
              ? `drafts/${id}/${p.id}-preview`
              : null;
            if (previewKey) {
              await this.store.db
                .query(
                  "INSERT INTO photo_gc VALUES (?,?) ON CONFLICT(key) DO UPDATE SET after_ms=excluded.after_ms",
                )
                .run(previewKey, Date.now() + 86400000);
              await this.photos!.put(previewKey, result.preview, "image/jpeg");
            }
            await this.store.db.transaction(async () => {
              await this.store.db
                .query(
                  "UPDATE intake_pages SET preview=?,preview_key=?,ocr=?,error='' WHERE id=?",
                )
                .run(
                  this.photos ? null : result.preview,
                  previewKey,
                  JSON.stringify(
                    "extracted" in result && result.extracted
                      ? { blocks: result.blocks, extracted: result.extracted }
                      : result.blocks,
                  ),
                  p.id,
                );
              if (previewKey)
                await this.store.db
                  .query("DELETE FROM photo_gc WHERE key=?")
                  .run(previewKey);
            })();
          }
          parsed.push(page);
        } catch (error) {
          await this.store.db
            .query("UPDATE intake_pages SET error=?,ocr=NULL WHERE id=?")
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
        const mapping = (await this.store.db
          .query(
            "SELECT product_id FROM supplier_products WHERE tin=? AND code=?",
          )
          .get(draft.tin, key(line.code))) as any;
        if (mapping && (await this.store.product(mapping.product_id)))
          line.productId = mapping.product_id;
      }
      await this.store.db
        .query(
          "UPDATE intakes SET draft=?,revision=revision+1 WHERE id=? AND revision=?",
        )
        .run(JSON.stringify(draft), id, before.revision);
      return await this.get(id);
    } finally {
      await this.store.db
        .query(
          "UPDATE intakes SET processing_until=0 WHERE id=? AND processing_until=?",
        )
        .run(id, leaseUntil);
    }
  }
  async save(id: string, input: any) {
    return this.store.db.transaction(async () => this.saveLocked(id, input))();
  }
  private async saveLocked(id: string, input: any) {
    const existing = await this.get(id);
    if (existing.status !== "draft") fail("Received invoices cannot be edited");
    if (existing.processing) fail("Wait for photo processing to finish");
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
    // Receipt acknowledgement is written by the server only after posting.
    delete d.warningAcceptance;
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
        if (v !== null && (!finite(v) || !Number.isInteger(v)))
          fail("Quantities must be whole numbers");
      for (const v of [l.amount, l.unitPrice, l.mrp]) if (v !== null) cents(v);
      if (l.productId && !(await this.store.product(l.productId)))
        fail("Select an active product");
    }
    const updated = await this.store.db
      .query(
        "UPDATE intakes SET draft=?,revision=revision+1 WHERE id=? AND revision=? AND status='draft' AND processing_until<?",
      )
      .run(JSON.stringify(d), id, existing.revision, Date.now());
    if (!updated.changes)
      throw new AppError("This draft changed. Reopen it before saving", 409);
    return await this.get(id);
  }
  async receive(id: string, revision: number, acceptedWarnings: unknown = []) {
    const received = await this.store.db.transaction(async () => {
      const intake = await this.get(id);
      if (intake.status === "received") return intake;
      if (intake.revision !== revision)
        throw new AppError(
          "This draft changed. Reopen it before receiving",
          409,
        );
      const d: IntakeDraft = intake.draft;
      const { blockers, warnings } = draftValidation(d, intake.pages.length);
      if (blockers.length) fail(blockers[0]!);
      if (
        !Array.isArray(acceptedWarnings) ||
        acceptedWarnings.length !== warnings.length ||
        new Set(acceptedWarnings).size !== warnings.length ||
        warnings.some((warning) => !acceptedWarnings.includes(warning.code))
      )
        fail("Review and accept the invoice warnings before adding stock");
      // Reserve every acknowledged number so a later scan using the other
      // page's spelling cannot receive this same invoice a second time.
      const invoiceNumbers = [
        ...new Set(
          [d.number, ...d.pages.map((p) => p.invoice)].map(key).filter(Boolean),
        ),
      ];
      for (const number of invoiceNumbers) {
        if (
          await this.store.db
            .query(
              "SELECT intake_id FROM received_supplier_invoices WHERE tin=? AND number=?",
            )
            .get(d.tin, number)
        )
          fail("This supplier invoice has already been received");
      }
      const costs = invoiceCosts(d);
      if (!costs) fail("Check invoice amounts before receiving");
      const shares = costs!.map((c) => c.discountCents);
      const resolved = new Map<string, string>();
      const lines = await mapAsync(d.lines, async (l, index) => {
        const mapping = (await this.store.db
          .query(
            "SELECT product_id FROM supplier_products WHERE tin=? AND code=?",
          )
          .get(d.tin, l.code)) as any;
        let productId =
          resolved.get(l.code) || mapping?.product_id || l.productId;
        if (productId && l.productId && productId !== l.productId)
          fail(`Product code ${l.code} is already linked to another product`);
        if (productId) {
          const p = await this.store.product(productId);
          if (!p || p.unit !== "PKT")
            fail(`Select an active packet product for ${l.code}`);
          // A reviewed, explicit selection can link a replacement supplier code.
          // Unknown codes are never merged by name or price automatically.
        } else {
          // Codes are supplier-scoped. Never merge products by name or price.
          const sku = `${d.tin}-${l.code}`;
          if (
            await this.store.db
              .query("SELECT id FROM products WHERE upper(sku)=?")
              .get(sku.toUpperCase())
          )
            fail(`SKU ${sku} exists. Select its stock item explicitly`);
          productId = await this.store.saveProduct({
            name: l.description,
            sku,
            unit: "PKT",
            stock: 0,
          });
        }
        resolved.set(l.code, productId);
        await this.store.db
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
      const purchase = await this.store.inventory.savePurchase({
        supplier: `${d.supplier} (${d.tin})`,
        number: d.number,
        received: d.date,
        note: "From reviewed supplier invoice photos. Cost includes VAT and allocated invoice discount.",
        lines,
      });
      await this.store.inventory.postPurchase(purchase.id);
      for (const number of invoiceNumbers)
        await this.store.db
          .query("INSERT INTO received_supplier_invoices VALUES (?,?,?)")
          .run(d.tin, number, id);
      if (warnings.length)
        d.warningAcceptance = {
          at: new Date().toISOString(),
          revision,
          invoiceNumber: d.number,
          warnings,
        };
      else delete d.warningAcceptance;
      // Keep reviewed source amounts and exact discount shares for audit; rounded unit costs are separate.
      d.lines.forEach((l, i) => {
        l.productId = lines[i]!.productId;
      });
      await this.store.db
        .query(
          "UPDATE intakes SET status='received',purchase_id=?,draft=?,revision=revision+1 WHERE id=?",
        )
        .run(
          purchase.id,
          JSON.stringify({ ...d, allocatedDiscountCents: shares }),
          id,
        );
      const photos = await this.store.db
        .query(
          "SELECT object_key,preview_key FROM intake_pages WHERE intake_id=?",
        )
        .all(id);
      for (const photo of photos)
        for (const objectKey of [photo.object_key, photo.preview_key])
          if (objectKey)
            await this.store.db
              .query(
                "INSERT INTO photo_gc VALUES (?,?) ON CONFLICT(key) DO UPDATE SET after_ms=excluded.after_ms",
              )
              .run(objectKey, Date.now());
      await this.store.db
        .query(
          "UPDATE intake_pages SET raw=?,preview=NULL,ocr=NULL,object_key=NULL,preview_key=NULL WHERE intake_id=?",
        )
        .run(new Uint8Array(), id);
      await this.store.db
        .query("UPDATE intakes SET photos_removed=1 WHERE id=?")
        .run(id);
      return await this.get(id);
    })();
    await this.cleanupPhotos().catch(() => {});
    return received;
  }
}
