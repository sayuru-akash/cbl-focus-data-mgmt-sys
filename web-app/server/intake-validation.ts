import { packFrom, type IntakeDraft, type IntakeLine } from "./supplier-parser";
const key = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");
const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e8;
export function lineIssues(line: IntakeLine): string[] {
  const issues: string[] = [];
  if (!/^[A-Z0-9][A-Z0-9._/-]{1,79}$/i.test(line.code))
    issues.push("Check product code");
  if (!line.description.trim()) issues.push("Enter the product description");
  if (!finite(line.boxes) || !line.boxes || !Number.isInteger(line.boxes))
    issues.push("Box count must be a whole number");
  if (!finite(line.sold) || !line.sold || !Number.isInteger(line.sold))
    issues.push("Sold quantity must be a whole number");
  if (!["DZ", "MC", "PKT", "EA", "PCS"].includes(line.unit))
    issues.push("Check invoice unit");
  if (
    !Number.isInteger(line.packSize) ||
    !line.packSize ||
    line.packSize > 10000
  )
    issues.push("Check packets per invoice unit");
  if (line.unit === "DZ" && line.packSize !== 12)
    issues.push("A dozen must contain 12 packets");
  if (["PKT", "EA", "PCS"].includes(line.unit) && line.packSize !== 1)
    issues.push("Individual units must contain 1 packet");
  const packaging = packFrom(line.description, "MC").size;
  if (
    packaging &&
    line.boxes &&
    line.sold &&
    line.packSize &&
    Math.abs(line.boxes * packaging - line.sold * line.packSize) > 0.001
  )
    issues.push("Boxes and description pack size do not match packet quantity");
  if (line.unit === "MC" && line.boxes !== line.sold)
    issues.push("MC quantity must match boxes");
  if (
    line.sold &&
    line.packSize &&
    !Number.isInteger(line.sold * line.packSize)
  )
    issues.push("Stock must contain whole packets");
  if (!finite(line.unitPrice) || !finite(line.amount))
    issues.push("Check printed price and amount");
  // Printed unit prices are rounded; allow at most half a cent per sold unit.
  if (
    finite(line.amount) &&
    finite(line.sold) &&
    finite(line.unitPrice) &&
    Math.abs(line.amount! - line.sold! * line.unitPrice!) >
      line.sold! * 0.005 + 0.021
  )
    issues.push("Quantity × unit price does not match line amount");
  if (!finite(line.mrp) || !line.mrp) issues.push("Enter packet MRP");
  return issues;
}
export function draftIssues(d: IntakeDraft, pages: number): string[] {
  const issues: string[] = [];
  if (!d.supplier.trim() || !/^\d{6,20}$/.test(d.tin))
    issues.push("Check supplier and TIN");
  if (!d.number.trim()) issues.push("Enter tax invoice number");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
    !Number.isFinite(Date.parse(d.date)) ||
    new Date(d.date).toISOString().slice(0, 10) !== d.date
  )
    issues.push("Check invoice date");
  if (d.pages.length !== pages) issues.push("Every uploaded page needs review");
  const numbers = d.pages
    .map((p) => p.page)
    .sort((a, b) => (a || 0) - (b || 0));
  if (
    d.pages.some((p) => p.count !== pages) ||
    numbers.some((n, i) => n !== i + 1)
  )
    issues.push("Check page numbers: include each invoice page once");
  if (d.pages.some((p) => key(p.invoice) !== key(d.number)))
    issues.push("All pages must have the same tax invoice number");
  if (d.pages.some((p) => !p.document.trim()))
    issues.push("Check each page's document number");
  if (new Set(d.pages.map((p) => key(p.document))).size !== pages)
    issues.push("Duplicate document page");
  if (d.pages.some((p) => !p.reviewed) || !d.headerReviewed)
    issues.push("Confirm page details and invoice totals");
  if (!d.lines.length)
    issues.push("No items found. Add the missing rows from the photos");
  if (d.pages.some((_, i) => !d.lines.some((l) => l.page === i)))
    issues.push("Check items on every page");
  if (d.lines.some((l) => !l.reviewed)) issues.push("Review every item");
  d.lines.forEach((l, i) => {
    for (const issue of lineIssues(l)) issues.push(`Item ${i + 1}: ${issue}`);
  });
  if ([d.gross, d.discount, d.total].some((v) => !finite(v)))
    issues.push("Enter invoice totals and discount (0 if none)");
  else {
    const sum = d.lines.reduce(
      (s, l) => s + Math.round((l.amount || 0) * 100),
      0,
    );
    if (sum !== Math.round(d.gross! * 100))
      issues.push("Line amounts do not equal total order value");
    if (
      Math.round(d.gross! * 100) - Math.round(d.discount! * 100) !==
      Math.round(d.total! * 100)
    )
      issues.push("Order value minus discount does not equal invoice total");
    if (d.discount! > d.gross! || !d.total)
      issues.push("Check invoice discount and total");
  }
  return issues;
}
