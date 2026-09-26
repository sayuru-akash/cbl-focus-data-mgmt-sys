import type { IntakeDraft } from "./supplier-parser";

// Allocate whole cents by largest remainder so preview and posted costs agree.
export function invoiceCosts(draft: IntakeDraft) {
  const money = (n: number | null) =>
    n !== null && Number.isFinite(n) && n >= 0 && n <= 1e8;
  if (
    !money(draft.gross) ||
    !money(draft.discount) ||
    !money(draft.total) ||
    draft.lines.some((l) => !money(l.amount))
  )
    return null;
  const amounts = draft.lines.map((l) => Math.round(l.amount! * 100));
  const gross = Math.round(draft.gross! * 100);
  const discount = Math.round(draft.discount! * 100);
  if (
    !gross ||
    discount > gross ||
    amounts.reduce((a, b) => a + b, 0) !== gross ||
    gross - discount !== Math.round(draft.total! * 100)
  )
    return null;
  const shares = amounts.map((a) =>
    Number((BigInt(a) * BigInt(discount)) / BigInt(gross)),
  );
  let remainder = discount - shares.reduce((a, b) => a + b, 0);
  const order = amounts
    .map((a, i) => ({
      i,
      fraction: Number((BigInt(a) * BigInt(discount)) % BigInt(gross)),
    }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (const { i } of order) {
    if (!remainder) break;
    shares[i]!++;
    remainder--;
  }
  return draft.lines.map((line, i) => {
    const quantity = (line.sold || 0) * (line.packSize || 0);
    const netCents = amounts[i]! - shares[i]!;
    return {
      discountCents: shares[i]!,
      netAmount: netCents / 100,
      costPrice:
        quantity > 0 && Number.isSafeInteger(quantity)
          ? Math.round(netCents / quantity) / 100
          : null,
    };
  });
}
