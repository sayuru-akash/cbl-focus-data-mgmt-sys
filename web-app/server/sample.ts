import { mapAsync } from "./db";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./store";
// Deliberately fixed, isolated path: never seed DATA_DIR or the real workspace.
export const sampleDirectory = resolve(import.meta.dir, "../data/sample");
export const samplePassword = "focus-sample-2026";
export async function prepareSample() {
  mkdirSync(sampleDirectory, { recursive: true, mode: 0o700 });
  const store = await Store.open(resolve(sampleDirectory, "focus.sqlite"));
  try {
    if (await store.setting("sampleVersion")) return;
    const existing = (await store.db
      .query(
        `SELECT
      (SELECT count(*) FROM bills) + (SELECT count(*) FROM products) +
      (SELECT count(*) FROM purchases) + (SELECT count(*) FROM settings WHERE key <> 'inventoryLotsMigrated') AS n`,
      )
      .get()) as {
      n: number;
    };
    assert.equal(
      existing.n,
      0,
      "Sample folder already contains data; refusing to overwrite it.",
    );
    const passwordHash = Bun.password.hashSync(samplePassword);
    await store.db.transaction(async () => {
      const catalog = await mapAsync(
        [
          ["CHOC-O-FRUIT 7G", 20],
          ["TROPICA 26G", 70],
          ["SPONGE LAYER VANILLA 310G", 580],
          ["CREAM CRACKER 190G", 240],
          ["LEMON PUFF 200G", 300],
          ["CHOCOLATE PUFF 200G", 320],
          ["GINGER BISCUITS 170G", 220],
          ["MARIE BISCUITS 200G", 200],
          ["NICE BISCUITS 100G", 150],
          ["MILK SHORTCAKE 200G", 260],
          ["CHOCOLATE CREAM 100G", 180],
          ["VANILLA CREAM 100G", 180],
          ["COCONUT COOKIES 150G", 280],
          ["CHOCOLATE COOKIES 150G", 350],
          ["WAFER VANILLA 100G", 160],
          ["WAFER CHOCOLATE 100G", 160],
          ["LAYER CAKE CHOCOLATE 310G", 600],
          ["LAYER CAKE ORANGE 310G", 580],
          ["SWISS ROLL VANILLA 200G", 450],
          ["SWISS ROLL CHOCOLATE 200G", 480],
          ["RICE CRACKER 100G", 190],
          ["SAVOURY CRACKER 170G", 250],
          ["BUTTER BISCUITS 100G", 170],
          ["FRUIT CAKE 350G", 650],
        ],
        async ([name, mrp], index) => ({
          name: String(name),
          mrp: Number(mrp),
          id: await store.saveProduct({
            sku: `DEMO${String(index + 1).padStart(3, "0")}`,
            name,
            unit: "PKT",
            minimum: 60,
          }),
        }),
      );
      const shops = [
        "Sunrise Stores",
        "Lake View Grocery",
        "Green Mart",
        "City Mini Market",
        "Temple Road Stores",
        "Hilltop Grocery",
        "Family Food Centre",
        "New Town Stores",
        "Station Road Mart",
        "Village Super",
        "Market Lane Grocery",
        "Riverside Stores",
        "Garden Mini Mart",
        "Central Food Shop",
        "School Road Stores",
        "Palm Grove Grocery",
      ];
      const money = (n: number) =>
        n.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      const date = (day: number) => `2026-09-${String(day).padStart(2, "0")}`;
      // Two FIFO batches at the original MRP, followed by a newer MRP variant.
      for (let batch = 0; batch < 3; batch++) {
        for (let group = 0; group < 4; group++) {
          const received = date(1 + batch * 3);
          const purchase = await store.inventory.savePurchase({
            supplier: "Sample Distribution Supplies",
            number: `DEMO-IN-${batch * 4 + group + 1}`,
            received,
            note: "Synthetic stock receipt",
            lines: catalog.slice(group * 6, group * 6 + 6).map((p, offset) => ({
              productId: p.id,
              quantity: group * 6 + offset === 23 ? 8 : batch === 0 ? 120 : 180,
              costPrice:
                Math.round(
                  (p.mrp + (batch === 2 ? 10 : 0)) *
                    (0.69 + batch * 0.015) *
                    100,
                ) / 100,
              mrp: p.mrp + (batch === 2 ? 10 : 0),
            })),
          });
          await store.inventory.postPurchase(purchase.id);
          await store.db
            .query("UPDATE purchases SET created=?,posted=? WHERE id=?")
            .run(
              `${received}T03:00:00.000Z`,
              `${received}T03:10:00.000Z`,
              purchase.id,
            );
        }
      }
      for (let i = 0; i < 3; i++) {
        await store.inventory.savePurchase({
          supplier: "Sample Distribution Supplies",
          number: `DEMO-DRAFT-${i + 1}`,
          received: date(27),
          note: "Sample delivery awaiting receipt",
          lines: catalog.slice(i * 4, i * 4 + 4).map((p) => ({
            productId: p.id,
            quantity: 120,
            costPrice: p.mrp * 0.7,
            mrp: p.mrp,
          })),
        });
      }
      for (let i = 0; i < 80; i++) {
        const billDate = date(10 + Math.floor(i / 5)),
          shop = i % shops.length;
        const lines = Array.from({ length: 3 + (i % 5) }, (_, line) => {
          const p = catalog[(i + line * 3) % 23]!;
          return {
            ...p,
            mrp: p.mrp + (i % 4 === 0 ? 10 : 0),
            quantity: [1, 3, 6, 12][(i + line) % 4]!,
          };
        });
        // Deliberate review cases among pending bills; earlier bills remain ordinary invoices.
        if (i >= 74 && i <= 75) lines[0] = { ...catalog[23]!, quantity: 48 };
        if (i >= 76 && i <= 77)
          lines[0] = { ...catalog[0]!, mrp: 40, quantity: 12 };
        if (i >= 78)
          lines[0] = {
            id: "",
            name: "SAMPLE OAT COOKIES 120G",
            mrp: 290,
            quantity: 12,
          };
        const priced = lines.map((p) => ({
          ...p,
          rate: Math.round(p.mrp * 90) / 100,
        }));
        const total =
          priced.reduce(
            (sum, p) => sum + Math.round(p.rate * p.quantity * 100),
            0,
          ) / 100;
        const number = String(900001 + i),
          printed = `${billDate.slice(8)}-09-2026 10:${String(i % 60).padStart(2, "0")}`;
        const text = [
          "...............................................",
          "INVOICE",
          "SAMPLE DISTRIBUTOR",
          "No. 1, Sample Road, Kottawa",
          "N/A",
          "................................",
          "  [DUPLICATE] Copy",
          `Bill date : ${billDate}`,
          `Serial No : ${number}`,
          "SAMPLE ROUTE A",
          "................................",
          `OUTLET ID : ${880001 + shop}`,
          "Customer :",
          shops[shop]!.toUpperCase(),
          `No. ${10 + shop * 7}, Sample Road, Kottawa`,
          "N/A",
          "...............................................",
          "    SKU    UNIT   QTY    RATE      AMOUNT",
          "***********************************************",
          `  Net(Rs)             :           ${money(total)}`,
          "***********************************************",
          "",
          "VAT LIABLE PRODUCTS(inclusive VAT)  : ",
          ...priced.flatMap((p, index) => [
            ` ${index + 1}  ${p.name}   MRP ${money(p.mrp)}`,
            `          PKT     ${p.quantity}    ${money(p.rate)}      ${money(p.rate * p.quantity)}`,
          ]),
          "                                  ------------",
          `                                   ${money(total)}`,
          "",
          `NET TOTAL B/F RETURN               ${money(total)}`,
          "...............................................",
          `  Gross               :           ${money(total)}`,
          "  Returns             :               0.00",
          "...............................................",
          `  Net(Rs)             :           ${money(total)}`,
          "...............................................",
          "",
          "Customer Signature :.....................",
          "",
          "                CBL IT POS - 2021",
          "            printed by : SAMPLE ROUTE A",
          `               ${printed}`,
          "                    12.428",
          "              All Rights Reserved",
          "...............................................",
          "",
          "",
        ].join("\r\n");
        const raw = Buffer.concat([
          Buffer.from(
            "1d61001d49431d49451d61ff1b45001b2d001d42001d21001b61001b47001b4d001b4d001d21001b7400",
            "hex",
          ),
          Buffer.from(text),
          Buffer.from("1d49421d6100", "hex"),
        ]);
        const { id } = await store.ingest(
          raw,
          `sample-${number}.bin`,
          "application/octet-stream",
          "Sample CBL tablet",
        );
        const bill = await store.bill(id);
        assert.deepEqual(
          bill.receipt.warnings,
          [],
          `Invoice ${number} must parse cleanly`,
        );
        assert.equal(bill.receipt.items.length, lines.length);
        assert.equal(bill.receipt.total, total);
        assert.equal(bill.receipt.outletId, String(880001 + shop));
        bill.items.forEach((item: any, index: number) => {
          item.productId = lines[index]!.id;
        });
        await store.saveBill(id, bill);
        if (i < 48) await store.decide(id, "accepted");
        else if (i < 56) await store.decide(id, "rejected");
        const received = `${billDate}T04:${String(i % 60).padStart(2, "0")}:00.000Z`;
        await store.db
          .query(
            "UPDATE bills SET received=?,decided=CASE WHEN status='pending' THEN NULL ELSE ? END WHERE id=?",
          )
          .run(received, received, id);
        await store.db
          .query("UPDATE movements SET created=? WHERE bill_id=?")
          .run(received, id);
        assert.equal(
          (await store.ingest(raw, "retry.bin", "", "Sample retry")).duplicate,
          true,
        );
      }
      for (const product of catalog) {
        const stock = (await store.product(product.id)).stock;
        const lots = (await store.db
          .query("SELECT sum(remaining) n FROM stock_lots WHERE product_id=?")
          .get(product.id)) as {
          n: number;
        };
        const movements = (await store.db
          .query("SELECT sum(delta) n FROM movements WHERE product_id=?")
          .get(product.id)) as {
          n: number;
        };
        assert.equal(stock, lots.n);
        assert.equal(stock, movements.n);
      }
      assert.equal((await store.bills()).length, 80);
      await store.set("password", passwordHash);
      await store.set("sampleVersion", "1");
    })();
    console.log(
      "Sample data ready: 80 bills, 24 products, 16 shops, 15 stock receipts.",
    );
  } finally {
    await store.db.close();
  }
}
if (import.meta.main) await prepareSample();
