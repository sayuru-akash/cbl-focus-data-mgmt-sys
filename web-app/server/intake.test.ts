import { expect, test } from "bun:test";
import { Store } from "./store";
import { Intakes, draftIssues, lineIssues } from "./intake";
import { packFrom, readMoney, type IntakeDraft } from "./supplier-parser";
const line = (code = "CK001", unit = "MC", mrp = 600) => ({
  id: crypto.randomUUID(),
  page: 0,
  code,
  description: "LAYER CAKE 480GX3EA",
  weight: "480G",
  boxes: 3,
  sold: 3,
  unit,
  unitPrice: 4200,
  amount: 12600,
  packSize: 3,
  packEvidence: "480GX3EA",
  mrp,
  productId: "",
  reviewed: true,
});
function setup(draft?: IntakeDraft) {
  const store = new Store(":memory:"),
    intakes = new Intakes(store),
    id = crypto.randomUUID();
  const d = draft || {
    supplier: "Example Supplier",
    tin: "114309834",
    number: "TAX001",
    date: "2026-08-29",
    gross: 12600,
    discount: 600,
    total: 12000,
    pages: [
      { page: 1, count: 1, document: "D1", invoice: "TAX001", reviewed: true },
    ],
    lines: [line()],
    headerReviewed: true,
  };
  store.db
    .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
    .run(id, JSON.stringify(d), new Date().toISOString());
  store.db
    .query(
      "INSERT INTO intake_pages(id,intake_id,position,filename,mime,hash,raw) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      crypto.randomUUID(),
      id,
      0,
      "page.jpg",
      "image/jpeg",
      "hash",
      new Uint8Array([1]),
    );
  return { store, intakes, id, d };
}
test("MC pack sizes come from explicit descriptions, DZ remains 12", () => {
  expect(packFrom("BUTTER CAKE 240G X12EA", "MC").size).toBe(12);
  expect(packFrom("CAKE 480GX3EA", "MC").size).toBe(3);
  expect(packFrom("CAKE 30G X18 X12EA", "MC").size).toBe(216);
  expect(packFrom("CAKE 480GXGEA", "MC").size).toBeNull();
  expect(packFrom("CAKE 480G", "MC").size).toBeNull();
  expect(packFrom("CAKE 200GX24EA", "DZ").size).toBe(12);
  expect(readMoney("45.679.68")).toBe(45679.68);
});
test("one reviewed invoice atomically creates products, converts packets, allocates discount and posts once", () => {
  const { store, intakes, id } = setup();
  try {
    expect(store.products()).toHaveLength(0);
    const received = intakes.receive(id, 1);
    expect(received.status).toBe("received");
    expect(store.products()[0]).toMatchObject({
      sku: "114309834-CK001",
      stock: 9,
      unit: "PKT",
    });
    expect(store.products()[0].lots[0]).toMatchObject({
      costPrice: 1333.33,
      mrp: 600,
    });
    intakes.receive(id, 1);
    expect(store.products()[0].stock).toBe(9);
    expect(store.db.query("SELECT count(*) n FROM purchases").get()).toEqual({
      n: 1,
    });
  } finally {
    store.db.close();
  }
});
test("unreviewed rows, missing pages, duplicate pages and mismatched invoice numbers block receiving", () => {
  const { store, intakes, id, d } = setup();
  try {
    d.lines[0]!.reviewed = false;
    intakes.save(id, { revision: 1, draft: d });
    expect(() => intakes.receive(id, 2)).toThrow("Review every item");
    expect(store.products()).toHaveLength(0);
    d.pages[0]!.count = 2;
    expect(draftIssues(d, 1).join(" ")).toContain("page numbers");
    d.pages[0]!.invoice = "ANOTHER";
    expect(draftIssues(d, 1).join(" ")).toContain("same tax invoice");
    d.pages.push({ ...d.pages[0]! });
    expect(draftIssues(d, 2).join(" ")).toContain("Duplicate document");
  } finally {
    store.db.close();
  }
});
test("missing MRP, incompatible conversion and inconsistent totals cannot add stock", () => {
  const { store, d } = setup();
  try {
    d.lines[0]!.mrp = null;
    expect(lineIssues(d.lines[0]!).join(" ")).toContain("MRP");
    d.lines[0]!.packSize = 12;
    expect(lineIssues(d.lines[0]!).join(" ")).toContain("do not match");
    d.total = 1;
    expect(draftIssues(d, 1).join(" ")).toContain(
      "does not equal invoice total",
    );
    d.gross = 1;
    expect(draftIssues(d, 1).join(" ")).toContain("Line amounts");
  } finally {
    store.db.close();
  }
});
test("same names with different supplier codes are distinct products; price variants are separate lots", () => {
  const { store, intakes, id, d } = setup();
  try {
    d.lines.push({ ...line("CK002"), amount: 12600 });
    d.gross = 25200;
    d.total = 24600;
    intakes.save(id, { revision: 1, draft: d });
    intakes.receive(id, 2);
    expect(store.products()).toHaveLength(2);
    const second = crypto.randomUUID();
    d.number = "TAX002";
    d.pages[0]!.invoice = "TAX002";
    d.pages[0]!.document = "D2";
    d.lines = [line("CK001", "MC", 650)];
    d.gross = 12600;
    d.total = 12000;
    store.db
      .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
      .run(second, JSON.stringify(d), "2026");
    store.db
      .query(
        "INSERT INTO intake_pages(id,intake_id,position,filename,mime,hash,raw) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        second,
        0,
        "p",
        "image/jpeg",
        "h2",
        new Uint8Array([1]),
      );
    intakes.receive(second, 1);
    expect(store.products()).toHaveLength(2);
    const p = store.products().find((p: any) => p.sku.endsWith("CK001"))!;
    expect(p.stock).toBe(18);
    expect(p.lots.map((l: any) => l.mrp)).toEqual([600, 650]);
  } finally {
    store.db.close();
  }
});
test("two supplier codes cannot merge into one existing product; failures roll back earlier rows", () => {
  const { store, intakes, id, d } = setup();
  try {
    const productId = store.saveProduct({
      sku: "EXISTING",
      name: "Cake",
      unit: "PKT",
    });
    d.lines = [
      { ...line("CK001"), productId },
      { ...line("CK002"), productId },
    ];
    d.gross = 25200;
    d.total = 24600;
    intakes.save(id, { revision: 1, draft: d });
    expect(() => intakes.receive(id, 2)).toThrow("separate products");
    expect(store.products()[0].stock).toBe(0);
    expect(store.inventory.purchases()).toHaveLength(0);
    expect(
      store.db.query("SELECT count(*) n FROM supplier_products").get(),
    ).toEqual({ n: 0 });
  } finally {
    store.db.close();
  }
});
test("stale drafts cannot overwrite current review, and duplicate tax invoices cannot post twice", () => {
  const { store, intakes, id, d } = setup();
  try {
    intakes.save(id, { revision: 1, draft: d });
    expect(() => intakes.save(id, { revision: 1, draft: d })).toThrow(
      "changed",
    );
    expect(() => intakes.receive(id, 1)).toThrow("changed");
    intakes.receive(id, 2);
    const duplicate = crypto.randomUUID();
    store.db
      .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
      .run(duplicate, JSON.stringify(d), "2026");
    store.db
      .query(
        "INSERT INTO intake_pages(id,intake_id,position,filename,mime,hash,raw) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        duplicate,
        0,
        "p",
        "image/jpeg",
        "different-photo",
        new Uint8Array([2]),
      );
    expect(() => intakes.receive(duplicate, 1)).toThrow(
      "already been received",
    );
    expect(store.products()[0].stock).toBe(9);
  } finally {
    store.db.close();
  }
});
