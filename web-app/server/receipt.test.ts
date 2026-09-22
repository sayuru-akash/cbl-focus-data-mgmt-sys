import { expect, test } from "bun:test";
import { decodePrint, parseReceipt } from "./receipt";
import { Store } from "./store";
export const receiptText = `INVOICE
Example Distributor
Bill date : 2026-09-22
Serial No : 10001
OUTLET ID : 123
Customer :
Example Shop
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
  expect(parsed).toMatchObject({ number: "10001", shop: "Example Shop", total: 1681, date: "2026-09-22", outletId: "123", warnings: [] });
  expect(parsed.items.map(i => [i.quantity, i.rate, i.amount, i.mrp])).toEqual([[24,18,432,20],[12,63,756,70],[1,493,493,580]]);
});
test("removes handshake commands and skips query-like bytes inside QR data", () => {
  const raw = Buffer.concat([Buffer.from([29,97,0,29,73,67,29,73,69,29,97,255,27,69,0,27,116,0,29,40,107,3,0,29,73,67]),Buffer.from(receiptText),Buffer.from([29,73,66,29,97,0])]);
  const decoded = decodePrint(raw);
  expect(decoded.preview).toBe(receiptText);
  expect(decoded.uncertain).toBe(false);
});
test("flags returns, duplicate copies, truncated rows, and mismatched totals", () => {
  expect(parseReceipt(receiptText.replace("Returns             :               0.00", "Returns             :              20.00"))!.warnings.join(" ")).toContain("Returns");
  expect(parseReceipt(receiptText+receiptText)!.warnings.join(" ")).toContain("Multiple");
  expect(parseReceipt(receiptText.replace("PKT     24", "???     24"))!.warnings.join(" ")).toContain("manual review");
  expect(parseReceipt(receiptText.replace("1,681.00", "1,600.00"))!.warnings.join(" ")).toContain("net total");
});
test("received bill stays pending and cannot deduct unmapped stock; differing reprint is retained", () => {
  const store = new Store(":memory:");
  try {
    const raw = Buffer.from(receiptText), {id} = store.ingest(raw,"capture","","Test");
    const bill = store.bill(id);
    expect(bill.number).toBe("10001");
    expect(bill.items).toHaveLength(3);
    expect(bill.status).toBe("pending");
    expect(() => store.decide(id,"accepted")).toThrow("Choose a stock item");
    expect(Buffer.from(bill.raw)).toEqual(raw);
    store.saveBill(id,bill);
    const reprint = store.ingest(Buffer.from(receiptText+"\n"),"reprint","","Test");
    expect(store.bill(reprint.id).receipt.warnings.join(" ")).toContain("already exists");
    expect(store.bill(reprint.id).number).toBe("");
  } finally { store.db.close(); }
});
