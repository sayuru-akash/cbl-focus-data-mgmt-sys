import { categoryDiscounts, discountCategories } from "./discount-categories";
import { AppError, string, units } from "./store";
import { cents } from "./inventory";
import {
  recalculateReceipt,
  RECEIPT_VERSION,
  type Receipt,
  type ReceiptLine,
} from "./receipt";
const fail = (message: string): never => {
  throw new AppError(message);
};
export function reviewedReceipt(
  input: any,
  current: Receipt,
  number: string,
  shop: string,
): Receipt {
  if (!input || !Array.isArray(input.items) || input.items.length > 500)
    fail("Invalid bill details");
  const date = string(input.date || "", 10);
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  )
    fail("Enter a valid bill date");
  const price = (n: unknown) => {
    const value = cents(n);
    if (value === null) fail("Enter a price");
    return value! / 100;
  };
  const items: ReceiptLine[] = input.items.map((item: any) => {
    if (!["sale", "free", "fresh_return", "market_return"].includes(item.kind))
      fail("Choose a valid item type");
    const name = string(item.name, 200),
      unit = string(item.unit, 30).toUpperCase();
    if (!name || !unit) fail("Enter each item name and unit");
    const quantity = units(item.quantity) / 1000;
    if (!quantity) fail("Quantity must be greater than zero");
    const rate = price(item.rate),
      discount = price(item.discount ?? 0),
      amount = price(item.amount);
    if (
      Math.abs(
        Math.round(quantity * rate * 100) -
          Math.round(discount * 100) -
          Math.round(amount * 100),
      ) > 1
    )
      fail("Line total must equal quantity × rate minus line discount");
    if (item.kind === "free" && (rate !== 0 || amount !== 0 || discount !== 0))
      fail("Free items must have zero price");
    const mrp = cents(item.mrp);
    return {
      kind: item.kind,
      section: string(item.section || item.kind, 40),
      name,
      unit,
      quantity,
      rate,
      amount,
      discount,
      ...(mrp === null ? {} : { mrp: mrp / 100 }),
    };
  });
  const accounting = {
    ...current.accounting,
    discount: price(input.accounting?.discount ?? 0),
    skuDiscount: price(input.accounting?.skuDiscount ?? 0),
    returnReversal: price(input.accounting?.returnReversal ?? 0),
  };
  const fields = {
    number,
    shop,
    date,
    outletId: string(input.outletId || "", 100),
    customerAddress: string(input.customerAddress || "", 1000),
    customerPhone: string(input.customerPhone || "", 100),
    items,
    categoryDiscounts: Object.fromEntries(
      discountCategories.map(({ key }) => [
        key,
        price(categoryDiscounts(input)[key]),
      ]),
    ) as ReturnType<typeof categoryDiscounts>,
    accounting,
  };
  const comparable = (r: any) =>
    JSON.stringify([
      r.number,
      r.shop,
      r.date,
      r.outletId,
      r.customerAddress,
      r.customerPhone,
      r.items.map((i: any) => [
        i.kind,
        i.name,
        i.unit,
        i.quantity,
        i.rate,
        i.amount,
        i.discount || 0,
        i.mrp ?? null,
      ]),
      categoryDiscounts(r),
      r.accounting?.discount || 0,
      r.accounting?.skuDiscount || 0,
      r.accounting?.returnReversal || 0,
    ]);
  const changed = comparable(fields) !== comparable(current);
  if (!changed) return { ...current, reviewed: input.reviewed === true };
  const result = recalculateReceipt({
    ...current,
    ...fields,
    version: RECEIPT_VERSION,
    edited: true,
    reviewed: input.reviewed === true,
  });
  if (
    result.accounting.discount + result.accounting.skuDiscount >
    result.accounting.gross
  )
    fail("Discounts exceed the sale amount");
  if (result.accounting.returnReversal > result.accounting.returnGross)
    fail("Reverse GRTS exceeds the return value");
  return result;
}
