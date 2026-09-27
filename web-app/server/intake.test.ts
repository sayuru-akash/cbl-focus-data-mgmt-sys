import { openTestStore } from "./test-store";
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
async function setup(draft?: IntakeDraft) {
  const store = await openTestStore(),
    intakes = await Intakes.open(store),
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
  await store.db
    .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
    .run(id, JSON.stringify(d), new Date().toISOString());
  await store.db
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
test("one reviewed invoice atomically creates products, converts packets, allocates discount and posts once", async () => {
  const { store, intakes, id } = await setup();
  try {
    expect(await store.products()).toHaveLength(0);
    const received = await intakes.receive(id, 1);
    expect(received.status).toBe("received");
    expect((await store.products())[0]).toMatchObject({
      sku: "114309834-CK001",
      stock: 9,
      unit: "PKT",
    });
    expect((await store.products())[0].lots[0]).toMatchObject({
      costPrice: 1333.33,
      mrp: 600,
    });
    await intakes.receive(id, 1);
    expect((await store.products())[0].stock).toBe(9);
    expect(
      await store.db.query("SELECT count(*) n FROM purchases").get(),
    ).toEqual({
      n: 1,
    });
  } finally {
    await store.db.close();
  }
});
test("unreviewed rows, missing pages, duplicate pages and mismatched invoice numbers block receiving", async () => {
  const { store, intakes, id, d } = await setup();
  try {
    d.lines[0]!.reviewed = false;
    await intakes.save(id, { revision: 1, draft: d });
    await expect(intakes.receive(id, 2)).rejects.toThrow("Review every item");
    expect(await store.products()).toHaveLength(0);
    d.pages[0]!.count = 2;
    expect(draftIssues(d, 1).join(" ")).toContain("page numbers");
    d.pages[0]!.invoice = "ANOTHER";
    expect(draftIssues(d, 1).join(" ")).toContain("same tax invoice");
    d.pages.push({ ...d.pages[0]! });
    expect(draftIssues(d, 2).join(" ")).toContain("Duplicate document");
  } finally {
    await store.db.close();
  }
});
test("missing MRP, incompatible conversion and inconsistent totals cannot add stock", async () => {
  const { store, d } = await setup();
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
    await store.db.close();
  }
});
test("same names with different supplier codes are distinct products; price variants are separate lots", async () => {
  const { store, intakes, id, d } = await setup();
  try {
    d.lines.push({ ...line("CK002"), amount: 12600 });
    d.gross = 25200;
    d.total = 24600;
    await intakes.save(id, { revision: 1, draft: d });
    await intakes.receive(id, 2);
    expect(await store.products()).toHaveLength(2);
    const second = crypto.randomUUID();
    d.number = "TAX002";
    d.pages[0]!.invoice = "TAX002";
    d.pages[0]!.document = "D2";
    d.lines = [line("CK001", "MC", 650)];
    d.gross = 12600;
    d.total = 12000;
    await store.db
      .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
      .run(second, JSON.stringify(d), "2026");
    await store.db
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
    await intakes.receive(second, 1);
    expect(await store.products()).toHaveLength(2);
    const p = (await store.products()).find((p: any) =>
      p.sku.endsWith("CK001"),
    )!;
    expect(p.stock).toBe(18);
    expect(p.lots.map((l: any) => l.mrp)).toEqual([600, 650]);
  } finally {
    await store.db.close();
  }
});
test("a supplier code cannot be reassigned; failures roll back earlier rows", async () => {
  const { store, intakes, id, d } = await setup();
  try {
    const productId = await store.saveProduct({
      sku: "EXISTING",
      name: "Cake",
      unit: "PKT",
    });
    const otherId = await store.saveProduct({
      sku: "OTHER",
      name: "Different cake",
      unit: "PKT",
    });
    d.lines = [
      { ...line("CK001"), productId },
      { ...line("CK001"), productId: otherId },
    ];
    d.gross = 25200;
    d.total = 24600;
    await intakes.save(id, { revision: 1, draft: d });
    await expect(intakes.receive(id, 2)).rejects.toThrow("already linked");
    expect((await store.products())[0].stock).toBe(0);
    expect(await store.inventory.purchases()).toHaveLength(0);
    expect(
      await store.db.query("SELECT count(*) n FROM supplier_products").get(),
    ).toEqual({ n: 0 });
  } finally {
    await store.db.close();
  }
});
test("review can explicitly link changed supplier codes to one item while keeping prices separate", async () => {
  const { store, intakes, id, d } = await setup();
  try {
    const productId = await store.saveProduct({
      sku: "STABLE",
      name: "LAYER CAKE 480G",
      unit: "PKT",
    });
    d.lines = [
      { ...line("OLD-CODE"), productId },
      { ...line("NEW-CODE", "MC", 650), productId },
    ];
    d.gross = 25200;
    d.total = 24600;
    await intakes.save(id, { revision: 1, draft: d });
    await intakes.receive(id, 2);
    expect(await store.products()).toHaveLength(1);
    expect((await store.products())[0].sku).toBe("STABLE");
    expect((await store.products())[0].stock).toBe(18);
    expect((await store.products())[0].lots.map((l: any) => l.mrp)).toEqual([
      600, 650,
    ]);
    expect(
      await store.db
        .query("SELECT count(*) n FROM supplier_products WHERE product_id=?")
        .get(productId!),
    ).toEqual({ n: 2 });
  } finally {
    await store.db.close();
  }
});
test("stale drafts cannot overwrite current review, and duplicate tax invoices cannot post twice", async () => {
  const { store, intakes, id, d } = await setup();
  try {
    await intakes.save(id, { revision: 1, draft: d });
    await expect(intakes.save(id, { revision: 1, draft: d })).rejects.toThrow(
      "changed",
    );
    await expect(intakes.receive(id, 1)).rejects.toThrow("changed");
    await intakes.receive(id, 2);
    const duplicate = crypto.randomUUID();
    await store.db
      .query("INSERT INTO intakes(id,draft,created) VALUES (?,?,?)")
      .run(duplicate, JSON.stringify(d), "2026");
    await store.db
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
    await expect(intakes.receive(duplicate, 1)).rejects.toThrow(
      "already been received",
    );
    expect((await store.products())[0].stock).toBe(9);
  } finally {
    await store.db.close();
  }
});
test("carton conversion distinguishes weight, nested packs and incomplete counts", () => {
  expect(packFrom("CAKE 480G × 6EA", "MC").size).toBe(6);
  expect(packFrom("DRINK 200ML X24EA", "MC").size).toBe(24);
  expect(packFrom("CAKE 480G", "MC").size).toBeNull();
  expect(packFrom("CAKE 480GX0EA", "MC").size).toBeNull();
  expect(packFrom("CAKE 480GX10001EA", "MC").size).toBeNull();
  expect(packFrom("CAKE 480GX6EA / 480GX12EA", "MC").size).toBeNull();
  expect(packFrom("CAKE 30GX18X12EA", "DZ").size).toBe(12);
  expect(
    lineIssues({ ...line(), description: "CAKE 480GX6EA", packSize: 3 }),
  ).toContain("Boxes and description pack size do not match packet quantity");
  expect(lineIssues({ ...line(), unit: "PKT", packSize: 3 })).toContain(
    "Individual units must contain 1 packet",
  );
});
test("photo selection validation rejects duplicates and oversize uploads without drafts", async () => {
  const store = await openTestStore();
  const intakes = await Intakes.open(store);
  try {
    const photo = new File([new Uint8Array([1, 2, 3])], "page.jpg", {
      type: "image/jpeg",
    });
    await expect(intakes.create([photo, photo])).rejects.toThrow("same photo");
    await expect(
      intakes.create([
        new File([new Uint8Array(12 * 1024 * 1024 + 1)], "large.jpg", {
          type: "image/jpeg",
        }),
      ]),
    ).rejects.toThrow("12 MB");
    await expect(
      intakes.create([new File(["text"], "page.txt", { type: "text/plain" })]),
    ).rejects.toThrow("JPG");
    expect(await intakes.list()).toHaveLength(0);
    const created = await intakes.create([photo]);
    expect(created.pages).toHaveLength(1);
    expect((await intakes.create([photo])).id).toBe(created.id);
  } finally {
    await store.db.close();
  }
});

test('approval clears photos after committing stock and retries a failed R2 deletion', async () => {
  const {store,id}=await setup();
  let failures=1; const removed:string[]=[];
  const photos={delete:async(keys:string[])=>{if(failures-->0)throw new Error('Offline');removed.push(...keys);}};
  const intakes=await Intakes.open(store,photos as any);
  try {
    await store.db.query('UPDATE intake_pages SET object_key=?,preview_key=?,preview=?,ocr=? WHERE intake_id=?').run('drafts/test/original','drafts/test/preview',new Uint8Array([2]),'[]',id);
    const before=await intakes.get(id);
    const [first,second]=await Promise.all([intakes.receive(id,before.revision),intakes.receive(id,before.revision)]);
    expect(first.status).toBe('received');expect(second.status).toBe('received');
    expect((await store.products())[0].stock).toBe(9);
    const page=await store.db.query('SELECT raw,preview,ocr,object_key FROM intake_pages WHERE intake_id=?').get(id);
    expect(page.raw.length).toBe(0);expect(page.preview).toBeNull();expect(page.ocr).toBeNull();expect(page.object_key).toBeNull();
    await expect(intakes.page(id,before.pages[0].id)).rejects.toThrow('removed after approval');
    await intakes.cleanupPhotos();
    expect(new Set(removed).size).toBe(2);
    expect((await store.db.query('SELECT count(*) n FROM photo_gc').get()).n).toBe(0);
  } finally {await store.db.close();}
});

test('concurrent photo retries create one draft and concurrent review saves reject stale edits',async()=>{
  const store=await openTestStore();const intakes=await Intakes.open(store);
  try {
    const file=new File([new Uint8Array([1,2,3])],'sample.png',{type:'image/png'});
    const [a,b]=await Promise.all([intakes.create([file]),intakes.create([file])]);
    expect(a.id).toBe(b.id);
    const draft={...a.draft,pages:[{page:1,count:1,document:'D',invoice:'I',reviewed:false}],lines:[]};
    const result=await Promise.allSettled([intakes.save(a.id,{draft,revision:a.revision}),intakes.save(a.id,{draft,revision:a.revision})]);
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
  } finally {await store.db.close();}
});
