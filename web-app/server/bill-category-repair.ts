import type { DataConnection } from "./db";
import { categoryDiscounts, categoryDifference } from "./discount-categories";
import { parseReceipt } from "./receipt";

// Operator-authorized repair only, never called by startup or normal bill review.
// Existing reviewed lines, financial deductions, original evidence and ledger stay intact.
export async function repairRepeatedCopyCategories(
  db: DataConnection,
  id: string,
  revision: number,
) {
  return db.transaction(async () => {
    const bill = await db.query("SELECT * FROM bills WHERE id=?").get(id);
    if (!bill || bill.status !== "accepted")
      throw new Error("Expected an accepted bill");
    if (bill.revision !== revision) throw new Error("Bill revision changed");
    const receipt = JSON.parse(bill.receipt || "null");
    const original = JSON.parse(bill.original_receipt || "null");
    const parsed = parseReceipt(bill.preview);
    if (
      !parsed?.printCopies?.identical ||
      parsed.printCopies.count < 2 ||
      parsed.number !== bill.number ||
      original?.number !== parsed.number
    )
      throw new Error("Identical complete copies were not proven");
    const corrected = categoryDiscounts(parsed);
    if (
      categoryDifference(receipt) === 0 &&
      JSON.stringify(categoryDiscounts(receipt)) === JSON.stringify(corrected)
    )
      return { unchanged: true };
    const current = categoryDiscounts(receipt);
    const printed = categoryDiscounts({
      ...original,
      categoryDiscounts: undefined,
    });
    for (const key of Object.keys(corrected) as (keyof typeof corrected)[]) {
      const repeated =
        Math.round(corrected[key] * 100) * parsed.printCopies.count;
      if (
        Math.round(current[key] * 100) !== repeated ||
        Math.round(printed[key] * 100) !== repeated
      )
        throw new Error(
          "Category values are not the repeated printed breakdown",
        );
    }
    const updated = { ...receipt, categoryDiscounts: corrected };
    if (categoryDifference(updated) !== 0)
      throw new Error(
        "Corrected categories do not reconcile to the reviewed discounts",
      );
    await db
      .query(
        "INSERT INTO bill_parse_history(id,bill_id,receipt,items,revision,created,metadata) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        id,
        bill.receipt,
        bill.items,
        bill.revision,
        new Date().toISOString(),
        JSON.stringify({
          operation: "repeated-copy-category-repair",
          reason:
            "Identical distributor/customer print copies counted twice in category breakdown",
          number: bill.number,
          shop: bill.shop,
          note: bill.note,
          payment_type: bill.payment_type,
          copies: parsed.printCopies.count,
          before: current,
          after: corrected,
        }),
      );
    const result = await db
      .query(
        "UPDATE bills SET receipt=?,revision=revision+1 WHERE id=? AND revision=?",
      )
      .run(JSON.stringify(updated), id, revision);
    if (result.changes !== 1) throw new Error("Bill revision changed");
    return { unchanged: false, categories: corrected, revision: revision + 1 };
  })();
}
