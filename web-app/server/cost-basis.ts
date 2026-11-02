import type { DataConnection } from "./db";
import { invoiceCosts } from "./intake-costs";

// The ledger's cost remains the net amount recorded when stock was posted.
// This separate, evidence-backed basis drives before-discount displays/valuation.
export const beforeDiscountSql =
  "CASE WHEN cb.lot_id IS NULL THEN l.cost ELSE cb.before_discount END";
export const costBasisSchema =
  "CREATE TABLE IF NOT EXISTS stock_lot_costs(lot_id TEXT PRIMARY KEY REFERENCES stock_lots(id) ON DELETE CASCADE,before_discount INTEGER CHECK(before_discount>=0),source TEXT NOT NULL);";

export function invoiceLotCosts(
  draftText: string,
  linesText: string,
  lots: any[],
): (number | null)[] | null {
  try {
    const draft = JSON.parse(draftText),
      lines = JSON.parse(linesText),
      costs = invoiceCosts(draft);
    if (
      !costs ||
      lines.length !== lots.length ||
      draft.lines.length !== lines.length ||
      !lines.every((line: any, i: number) => {
        const lot = lots[i],
          source = draft.lines[i];
        return (
          line.productId === lot.product_id &&
          source.productId === line.productId &&
          line.quantity * 1000 === lot.received_qty &&
          source.sold * source.packSize === line.quantity &&
          (line.mrp == null ? null : Math.round(line.mrp * 100)) === lot.mrp &&
          (line.costPrice == null ? null : Math.round(line.costPrice * 100)) ===
            lot.cost &&
          costs[i]!.netCostPrice === line.costPrice
        );
      })
    )
      return null;
    return costs.map((c) =>
      c.costPrice === null ? null : Math.round(c.costPrice * 100),
    );
  } catch {
    return null;
  }
}

export async function backfillInvoiceCostBasis(db: DataConnection) {
  const invoices = await db
    .query(
      `SELECT i.id,i.purchase_id,i.draft,p.lines FROM intakes i
    JOIN purchases p ON p.id=i.purchase_id WHERE i.status='received'
    AND EXISTS(SELECT 1 FROM stock_lots l LEFT JOIN stock_lot_costs cb ON cb.lot_id=l.id
      WHERE l.purchase_id=i.purchase_id AND cb.lot_id IS NULL)`,
    )
    .all();
  for (const invoice of invoices) {
    const lots = await db
      .query(
        "SELECT * FROM stock_lots WHERE purchase_id=? ORDER BY created,rowid",
      )
      .all(invoice.purchase_id);
    // Posting creates one lot per line, sequentially. Validate the complete
    // correspondence, including repeated products, before recovering costs.
    const bases =
      invoiceLotCosts(invoice.draft, invoice.lines, lots) ||
      lots.map(() => null);
    for (let start = 0; start < lots.length; start += 100) {
      const batch = lots.slice(start, start + 100);
      await db
        .query(
          `INSERT INTO stock_lot_costs(lot_id,before_discount,source)
      VALUES ${batch.map(() => "(?,?,?)").join(",")} ON CONFLICT(lot_id) DO NOTHING`,
        )
        .run(
          ...batch.flatMap((lot, i) => [lot.id, bases[start + i], invoice.id]),
        );
    }
  }
}
