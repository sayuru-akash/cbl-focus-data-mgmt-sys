import { expect, test } from "bun:test";
import { decodePrint, parseReceipt } from "./receipt";
import { Store } from "./store";
export const receiptText = `INVOICE
Example Distributor
No. 1, Example Road
0112345678
................................
Bill date : 2026-09-22
Serial No : 10001
EXAMPLE TERRITORY
................................
OUTLET ID : 123
Customer :
Example Shop
No. 2, Shop Road
N/A
................................
    SKU    UNIT   QTY    RATE      AMOUNT
 1  EXAMPLE BISCUITS 7G   MRP 20.00
          PKT     24    18.00      432.00
 2  EXAMPLE CAKE 26G MRP 70.00
          PKT     12    63.00      756.00
 3  EXAMPLE LARGE CAKE 310G MRP 580.00
          PKT     1     493.00     493.00
  Returns             :               0.00
  Net(Rs)             :           1,681.00
`;
test("extracts the observed two-line CBL layout without confusing distributor and customer", () => {
  const parsed = parseReceipt(receiptText)!;
  expect(parsed).toMatchObject({
    number: "10001",
    shop: "Example Shop",
    total: 1681,
    date: "2026-09-22",
    outletId: "123",
    warnings: [],
  });
  expect(
    parsed.items.map((i) => [i.quantity, i.rate, i.amount, i.mrp]),
  ).toEqual([
    [24, 18, 432, 20],
    [12, 63, 756, 70],
    [1, 493, 493, 580],
  ]);
  expect(parsed.distributor).toEqual({
    name: "Example Distributor",
    address: "No. 1, Example Road",
    phone: "0112345678",
  });
  expect(parsed.customerAddress).toBe("No. 2, Shop Road");
});
test("customer is linked by outlet ID while historical bill snapshots stay intact", () => {
  const store = new Store(":memory:");
  try {
    const first = store.ingest(Buffer.from(receiptText), "first", "", "Test");
    const second = store.ingest(
      Buffer.from(
        receiptText
          .replace("10001", "10002")
          .replace("Example Shop", "Renamed Shop")
          .replace("No. 2, Shop Road", "New Address"),
      ),
      "second",
      "",
      "Test",
    );
    expect(store.bill(first.id).customer_id).toBe(
      store.bill(second.id).customer_id,
    );
    expect(store.db.query("SELECT count(*) n FROM customers").get()).toEqual({
      n: 1,
    });
    expect(store.bill(first.id).receipt.shop).toBe("Example Shop");
    expect(store.bill(first.id).receipt.customerAddress).toBe(
      "No. 2, Shop Road",
    );
    expect(store.bill(second.id).receipt.customerAddress).toBe("New Address");
  } finally {
    store.db.close();
  }
});
test("accepted mappings carry forward by printed name and unit, never by price alone", () => {
  const store = new Store(":memory:");
  try {
    const first = store.ingest(Buffer.from(receiptText), "first", "", "Test"),
      bill = store.bill(first.id);
    for (const item of bill.items) {
      const source = bill.receipt.items[item.sourceLine];
      item.productId = store.saveProduct({
        name: source.name,
        unit: source.unit,
        stock: 100,
        mrp: source.mrp,
      });
    }
    store.saveBill(first.id, bill);
    store.decide(first.id, "accepted");
    const second = store.ingest(
      Buffer.from(receiptText.replace("10001", "10002")),
      "second",
      "",
      "Test",
    );
    expect(store.bill(second.id).items.map((i: any) => i.productId)).toEqual(
      bill.items.map((i: any) => i.productId),
    );
    expect(store.bill(second.id).status).toBe("pending");
  } finally {
    store.db.close();
  }
});
test("successive prints are independent, retries deduplicate, and reprints cannot deduct twice", () => {
  const store = new Store(":memory:");
  try {
    for (let i = 0; i < 20; i++) {
      const raw = Buffer.from(
        receiptText.replace("Serial No : 10001", `Serial No : ${10001 + i}`),
      );
      const first = store.ingest(raw, `print-${i}`, "", "Test");
      expect(store.ingest(raw, `retry-${i}`, "", "Test")).toEqual({
        id: first.id,
        duplicate: true,
      });
    }
    expect(store.bills()).toHaveLength(20);
    expect(store.bills().every((b) => b.status === "pending")).toBe(true);
    expect(store.db.query("SELECT count(*) n FROM movements").get()).toEqual({
      n: 0,
    });
    expect(store.db.query("SELECT count(*) n FROM customers").get()).toEqual({
      n: 1,
    });
  } finally {
    store.db.close();
  }
});
test("removes handshake commands and skips query-like bytes inside QR data", () => {
  const raw = Buffer.concat([
    Buffer.from([
      29, 97, 0, 29, 73, 67, 29, 73, 69, 29, 97, 255, 27, 69, 0, 27, 116, 0, 29,
      40, 107, 3, 0, 29, 73, 67,
    ]),
    Buffer.from(receiptText),
    Buffer.from([29, 73, 66, 29, 97, 0]),
  ]);
  const decoded = decodePrint(raw);
  expect(decoded.preview).toBe(receiptText);
  expect(decoded.uncertain).toBe(false);
});
test("flags returns, duplicate copies, truncated rows, and mismatched totals", () => {
  expect(
    parseReceipt(
      receiptText.replace(
        "Returns             :               0.00",
        "Returns             :              20.00",
      ),
    )!.warnings.join(" "),
  ).toContain("Returns");
  expect(parseReceipt(receiptText + receiptText)!.warnings.join(" ")).toContain(
    "Multiple",
  );
  expect(
    parseReceipt(
      receiptText.replace("PKT     24", "???     24"),
    )!.warnings.join(" "),
  ).toContain("manual review");
  expect(
    parseReceipt(receiptText.replace("1,681.00", "1,600.00"))!.warnings.join(
      " ",
    ),
  ).toContain("net total");
});
test("received bill stays pending and cannot deduct unmapped stock; differing reprint is retained", () => {
  const store = new Store(":memory:");
  try {
    const raw = Buffer.from(receiptText),
      { id } = store.ingest(raw, "capture", "", "Test");
    const bill = store.bill(id);
    expect(bill.number).toBe("10001");
    expect(bill.items).toHaveLength(3);
    expect(bill.status).toBe("pending");
    expect(() => store.decide(id, "accepted")).toThrow("Choose a stock item");
    expect(Buffer.from(bill.raw)).toEqual(raw);
    store.saveBill(id, bill);
    const reprint = store.ingest(
      Buffer.from(receiptText + "\n"),
      "reprint",
      "",
      "Test",
    );
    expect(store.bill(reprint.id).receipt.warnings.join(" ")).toContain(
      "already exists",
    );
    expect(store.bill(reprint.id).number).toBe("");
  } finally {
    store.db.close();
  }
});
