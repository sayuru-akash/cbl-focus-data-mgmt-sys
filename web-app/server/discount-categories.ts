export const discountCategories = [
  { key: "chocolate", label: "Chocolate" },
  { key: "candyBar", label: "Candy Bar" },
  { key: "cerealBars", label: "Cereal Bars" },
] as const;
export type CategoryDiscounts = Record<
  (typeof discountCategories)[number]["key"],
  number
>;
export function categoryDiscounts(receipt: any): CategoryDiscounts {
  if (receipt?.categoryDiscounts)
    return {
      chocolate: 0,
      candyBar: 0,
      cerealBars: 0,
      ...receipt.categoryDiscounts,
    };
  const result = { chocolate: 0, candyBar: 0, cerealBars: 0 };
  for (const total of receipt?.totals || []) {
    const label = String(total.label).trim().toUpperCase().replace(/\s+/g, " ");
    const key =
      label === "CHOCOLATE"
        ? "chocolate"
        : label === "CANDY BAR"
          ? "candyBar"
          : /^(CERIAL|CEREAL) BARS?$/.test(label)
            ? "cerealBars"
            : null;
    if (key) result[key] = Math.round((result[key] + total.amount) * 100) / 100;
  }
  return result;
}
export function categoryDifference(receipt: any) {
  const categories = categoryDiscounts(receipt);
  return (
    (Math.round((receipt?.accounting?.discount || 0) * 100) +
      Math.round((receipt?.accounting?.skuDiscount || 0) * 100) -
      Object.values(categories).reduce(
        (n, value) => n + Math.round(value * 100),
        0,
      )) /
    100
  );
}
export function colomboDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
