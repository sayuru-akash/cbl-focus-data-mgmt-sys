import { test, expect } from "bun:test";
import { openTestStore } from "./test-store";
import { recalculateReceipt } from "./receipt";
async function draft(
  s: any,
  number: string,
  productId: string,
  kinds = ["sale", "free", "fresh_return", "market_return"],
) {
  const raw = Buffer.from(
    `INVOICE\nDistributor\n................\nBill date : 2026-09-28\nSerial No : ${number}\nOUTLET ID : 12\nCustomer :\nExample shop\n................\nSKU UNIT QTY RATE AMOUNT\n 1  ITEM MRP 20.00\n PKT 2 18.00 36.00\nGross : 36.00\nNet(Rs) : 36.00\n`,
  );
  const { id } = await s.ingest(raw, "print", "", "Test");
  const b = await s.bill(id);
  const base = b.receipt.items[0];
  b.receipt = recalculateReceipt({
    ...b.receipt,
    items: kinds.map((kind) => ({
      ...base,
      kind,
      quantity: kind === "fresh_return" ? 3 : 2,
      rate: kind === "free" ? 0 : 18,
      amount: kind === "free" ? 0 : kind === "fresh_return" ? 54 : 36,
    })),
  });
  b.items = b.receipt.items.map((line: any, sourceLine: number) => ({
    productId,
    sourceLine,
    quantity: line.quantity,
    mrp: 20,
    sellingPrice: line.rate,
  }));
  await s.saveBill(id, { ...b, payment_type: "cash" });
  return { ...(await s.bill(id)), raw };
}
test("deleting accepted mixed bills restores exact batches, removes bill data and is retry-safe", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({
      name: "ITEM",
      unit: "PKT",
      stock: 10,
      mrp: 20,
      costPrice: 12,
    });
    const originalLots = await s.inventory.lots(p);
    const b = await draft(s, "92001", p);
    await s.decide(b.id, "accepted");
    expect((await s.product(p)).stock / 1000).toBe(9);
    const approved = await s.bill(b.id);
    await expect(s.deleteBill(b.id, b.revision, "DELETE")).rejects.toThrow(
      "changed",
    );
    await expect(s.deleteBill(b.id, approved.revision, "")).rejects.toThrow(
      "Confirm",
    );
    await s.deleteBill(b.id, approved.revision, "DELETE");
    expect((await s.product(p)).stock / 1000).toBe(10);
    expect(await s.inventory.lots(p)).toEqual(originalLots);
    await expect(s.bill(b.id)).rejects.toThrow("not found");
    for (const table of [
      "allocations",
      "bill_returns",
      "movements",
      "bill_parse_history",
    ])
      expect(
        await s.db.query(`SELECT * FROM ${table} WHERE bill_id=?`).all(b.id),
      ).toEqual([]);
    expect(await s.deleteBill(b.id, approved.revision, "DELETE")).toEqual({
      unchanged: true,
    });
    expect(await s.ingest(b.raw, "retry", "", "Test")).toMatchObject({
      duplicate: true,
      deleted: true,
    });
    expect(await s.bills()).toEqual([]);
  } finally {
    await s.db.close();
  }
});
test("fresh returns used by another bill block deletion atomically until dependent bill is deleted", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({ name: "ITEM", unit: "PKT", stock: 0 });
    const returned = await draft(s, "92002", p, ["fresh_return"]);
    await s.decide(returned.id, "accepted");
    const sale = await draft(s, "92003", p, ["sale"]);
    await s.decide(sale.id, "accepted");
    const before = JSON.stringify(await s.products());
    await expect(
      s.deleteBill(returned.id, (await s.bill(returned.id)).revision, "DELETE"),
    ).rejects.toThrow("used or adjusted");
    expect(JSON.stringify(await s.products())).toBe(before);
    expect((await s.bill(returned.id)).status).toBe("accepted");
    await s.deleteBill(sale.id, (await s.bill(sale.id)).revision, "DELETE");
    await s.deleteBill(
      returned.id,
      (await s.bill(returned.id)).revision,
      "DELETE",
    );
    expect((await s.product(p)).stock / 1000).toBe(0);
    expect(await s.inventory.lots(p)).toEqual([]);
  } finally {
    await s.db.close();
  }
});
test("deletion enforces approval time, keeps later sales and allows old drafts and rejected bills", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({
      name: "ITEM",
      unit: "PKT",
      stock: 10,
      mrp: 20,
    });
    const first = await draft(s, "92004", p, ["sale"]);
    await s.decide(first.id, "accepted");
    const later = await draft(s, "92005", p, ["sale"]);
    await s.decide(later.id, "accepted");
    const closed = await s.bill(first.id);
    await s.db
      .query("UPDATE bills SET decided=? WHERE id=?")
      .run(new Date(Date.now() - 10 * 86400000 - 1000).toISOString(), first.id);
    await expect(
      s.deleteBill(first.id, closed.revision, "DELETE"),
    ).rejects.toThrow("10 days");
    expect((await s.product(p)).stock / 1000).toBe(6);
    await s.db
      .query("UPDATE bills SET decided=? WHERE id=?")
      .run(new Date(Date.now() - 9 * 86400000).toISOString(), first.id);
    const deleted = await Promise.all([
      s.deleteBill(first.id, closed.revision, "DELETE"),
      s.deleteBill(first.id, closed.revision, "DELETE"),
    ]);
    expect(deleted.filter((r) => !r.unchanged)).toHaveLength(1);
    expect((await s.product(p)).stock / 1000).toBe(8);
    expect((await s.bill(later.id)).status).toBe("accepted");
    for (const status of ["pending", "rejected"]) {
      const b = await draft(s, status === "pending" ? "92006" : "92007", p, [
        "sale",
      ]);
      if (status === "rejected") await s.decide(b.id, "rejected");
      await s.db
        .query("UPDATE bills SET received=?,decided=? WHERE id=?")
        .run("2020-01-01", "2020-01-01", b.id);
      await s.deleteBill(b.id, (await s.bill(b.id)).revision, "DELETE");
    }
    expect((await s.product(p)).stock / 1000).toBe(8);
  } finally {
    await s.db.close();
  }
});
test("same-bill fresh returns consumed by its own sale can be reversed", async () => {
  const s = await openTestStore();
  try {
    const p = await s.saveProduct({ name: "ITEM", unit: "PKT", stock: 0 });
    const b = await draft(s, "92008", p, ["fresh_return", "sale"]);
    await s.decide(b.id, "accepted");
    expect((await s.product(p)).stock / 1000).toBe(1);
    await s.deleteBill(b.id, (await s.bill(b.id)).revision, "DELETE");
    expect((await s.product(p)).stock / 1000).toBe(0);
  } finally {
    await s.db.close();
  }
});
