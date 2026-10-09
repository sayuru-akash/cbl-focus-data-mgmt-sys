const normalize = (unit: string) => unit.trim().toUpperCase();

// CBL's UNIT label counts sellable items. It is not a carton/pack conversion.
// Keep this sales-only: supplier pack conversion and product identity stay strict.
export function isGenericSalesUnit(unit: string): boolean {
  return ["UNIT", "UNITS"].includes(normalize(unit));
}

export function salesUnitCompatible(printed: string, stock: string): boolean {
  const source = normalize(printed),
    target = normalize(stock);
  return (
    source === target ||
    (isGenericSalesUnit(source) &&
      ["UNIT", "UNITS", "PKT", "BOX", "BTL"].includes(target))
  );
}
