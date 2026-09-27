import type { CategoryDiscounts } from "./discount-categories";
export const RECEIPT_VERSION = 2;
export type LineKind = "sale" | "free" | "fresh_return" | "market_return";
export const lineKind = (bill: any, item: any): LineKind =>
  bill.receipt?.items[item.sourceLine]?.kind || "sale";
export const lineKindLabel: Record<LineKind, string> = {
  sale: "Sale",
  free: "Free item",
  fresh_return: "Fresh return",
  market_return: "Market return",
};
export type ReceiptLine = {
  discount?: number;
  kind: LineKind;
  section: string;
  name: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  mrp?: number;
};
export type Receipt = {
  categoryDiscounts?: CategoryDiscounts;
  edited?: boolean;
  reviewed?: boolean;
  version: number;
  accounting: {
    gross: number;
    discount: number;
    skuDiscount: number;
    returnGross: number;
    returnReversal: number;
    returns: number;
    calculatedNet: number;
    difference: number | null;
  };
  number: string;
  shop: string;
  date: string;
  outletId: string;
  customerAddress: string;
  customerPhone: string;
  distributor: { name: string; address: string; phone: string };
  territory: string;
  printedBy: string;
  printedAt: string;
  copyType: string;
  totals: { label: string; amount: number }[];
  total: number | null;
  items: ReceiptLine[];
  warnings: string[];
};

// Decode the text layer only. Original bytes remain the source of truth.
export function decodePrint(raw: Uint8Array) {
  const text: number[] = [];
  let unknown = false;
  for (let i = 0; i < raw.length && text.length < 100000;) {
    const b = raw[i],
      c = raw[i + 1];
    if (b === 0x1b || b === 0x1d) {
      let length = 2;
      if (b === 0x1d && c === 0x28)
        length = 5 + (raw[i + 3] || 0) + 256 * (raw[i + 4] || 0);
      else if (b === 0x1d && c === 0x38)
        length =
          7 +
          (raw[i + 3] || 0) +
          256 * (raw[i + 4] || 0) +
          65536 * (raw[i + 5] || 0) +
          16777216 * (raw[i + 6] || 0);
      else if (b === 0x1d && c === 0x76)
        length =
          8 +
          ((raw[i + 4] || 0) + 256 * (raw[i + 5] || 0)) *
            ((raw[i + 6] || 0) + 256 * (raw[i + 7] || 0));
      else if (b === 0x1b && c === 0x2a)
        length =
          5 +
          ((raw[i + 3] || 0) + 256 * (raw[i + 4] || 0)) *
            (raw[i + 2] >= 32 ? 3 : 1);
      else if (b === 0x1d && c === 0x6b) {
        if (raw[i + 2] > 6) length = 4 + (raw[i + 3] || 0);
        else {
          const end = raw.indexOf(0, i + 3);
          length = end < 0 ? raw.length - i : end - i + 1;
        }
      } else if (
        [0x24, 0x5c].includes(c) ||
        (b === 0x1d && [0x4c, 0x50, 0x57].includes(c))
      )
        length = 4;
      else if (b === 0x1b && c === 0x57) length = 10;
      else if (
        (b === 0x1b &&
          [
            0x20, 0x21, 0x2d, 0x33, 0x45, 0x47, 0x4a, 0x4d, 0x52, 0x54, 0x61,
            0x64, 0x74, 0x7b,
          ].includes(c)) ||
        (b === 0x1d &&
          [0x21, 0x42, 0x48, 0x49, 0x61, 0x66, 0x68, 0x72, 0x77].includes(c))
      )
        length = 3;
      else if (!(b === 0x1b && [0x32, 0x40, 0x4c, 0x53].includes(c)))
        unknown = true;
      if (i + length > raw.length) unknown = true;
      i += length;
    } else if (b === 0x10 && c === 0x04) i += 3;
    else {
      if (b === 9 || b === 10 || b === 13 || b >= 32) text.push(b);
      i++;
    }
  }
  const preview = new TextDecoder()
    .decode(new Uint8Array(text))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return { preview, uncertain: unknown || preview.includes("\ufffd") };
}

const money = (s: string) => Number(s.replace(/,/g, ""));
export function parseReceipt(
  preview: string,
  uncertain = false,
): Receipt | null {
  const number = preview.match(/^\s*Serial No\s*:\s*(\d+)\s*$/m)?.[1];
  const shop = preview.match(/^\s*Customer\s*:\s*\n([^\n]+)/m)?.[1]?.trim();
  if (!number || !shop || !/^\s*(?:INVOICE|Delivery Note)\s*$/m.test(preview))
    return null;
  const warnings: string[] = [];
  const warn = (s: string) => {
    if (!warnings.includes(s)) warnings.push(s);
  };
  if (uncertain)
    warn(
      "Check the original: some print commands or characters could not be decoded.",
    );
  if ((preview.match(/^\s*Serial No\s*:/gm) || []).length > 1)
    warn(
      "Multiple invoice copies detected. Review quantities before accepting.",
    );
  const items: ReceiptLine[] = [];
  const lines = preview.split("\n");
  const totals = [
    ...preview.matchAll(
      /^\s*Net(?:\s*\(Rs\.?\)|\s+Total\s*\(Rs\.?\))\s*:\s*(-?[\d,]+\.\d{2})\s*$/gim,
    ),
  ];
  const total = totals.length ? money(totals[totals.length - 1][1]) : null;
  let kind: LineKind = "sale",
    section = "Sale",
    inItems = false;
  let reverseCents = 0;
  const moneyPattern = "(-?[\\d,]+\\.\\d{2})";
  const lastSummary = (label: string): number | null => {
    const matches = [
      ...preview.matchAll(
        new RegExp(`^\\s*${label}\\s*:\\s*${moneyPattern}\\s*$`, "gim"),
      ),
    ];
    return matches.length ? Math.round(money(matches.at(-1)![1]) * 100) : null;
  };
  const detailPattern =
    /^\s*([A-Z][A-Z0-9./-]*)\s+(-?[\d,]+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$/;
  const knownSection = (label: string): LineKind | null => {
    if (/^FREE(?:\s+(?:ISSUE|ITEMS?|PRODUCTS?))?$/.test(label)) return "free";
    if (/^FRESH(?:\s+RETURNS?)?$/.test(label)) return "fresh_return";
    if (
      /^(?:EXPIRY|EXPIRED|MARKET(?:\s+RETURNS?)?|DAMAGE[D]?(?:\s+RETURNS?)?)$/.test(
        label,
      )
    )
      return "market_return";
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^\s*([A-Z][A-Z ]+?)\s*:\s*$/);
    if (/PRODUCTS.*VAT|SKU\s+UNIT\s+QTY/i.test(line)) {
      inItems = true;
      kind = "sale";
      section = "Sale";
    }
    if (heading && knownSection(heading[1].trim())) {
      kind = knownSection(heading[1].trim())!;
      section = heading[1].trim();
      inItems = true;
      continue;
    }
    if (heading && inItems && !/PRODUCTS/.test(heading[1])) {
      warn(`Unknown item section: ${heading[1].trim()}. Check the original.`);
      inItems = false;
    }
    const reverse = line.match(
      /^\s*REVERSE GRTS\s+(?:\(([\d,]+\.\d{2})\)|(-?[\d,]+\.\d{2}))\s*$/i,
    );
    if (reverse)
      reverseCents += Math.round(
        Math.abs(money(reverse[1] || reverse[2])) * 100,
      );
    const numbered = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    const detail = lines[i + 1]?.match(detailPattern);
    // Return and free rows have no serial; numbered sales can have one space after 9.
    const name = numbered ? numbered[2] : line.trim();
    if (!detail || !name || !inItems) {
      if (
        inItems &&
        ((numbered && /[A-Za-z]/.test(numbered[2])) ||
          /\bMRP\s+[\d,.]+\s*$/.test(line))
      )
        warn("Some item rows need manual review.");
      if (line.match(detailPattern))
        warn(
          "An item quantity has no recognized product or section. Check the original.",
        );
      continue;
    }
    const mrp = name.match(/\s+MRP\s+([\d,]+\.\d{2})\s*$/i);
    const quantity = money(detail[2]),
      rate = money(detail[3]),
      amount = money(detail[4]);
    if (quantity <= 0 || amount < 0)
      warn("Negative or zero item quantities need manual review.");
    if (
      Math.abs(Math.round(quantity * rate * 100) - Math.round(amount * 100)) > 1
    )
      warn("An item amount differs from quantity × rate.");
    if (kind === "free" && (rate !== 0 || amount !== 0))
      warn("A free item has a nonzero price. Check the original.");
    items.push({
      kind,
      section,
      name: name.replace(/\s+MRP\s+[\d,]+\.\d{2}\s*$/i, "").trim(),
      unit: detail[1],
      quantity,
      rate,
      amount,
      ...(mrp ? { mrp: money(mrp[1]) } : {}),
    });
    i++;
  }
  const sum = (kinds: LineKind[]) =>
    items
      .filter((i) => kinds.includes(i.kind))
      .reduce((n, i) => n + Math.round(i.amount * 100), 0);
  const sales = sum(["sale"]),
    returnGross = sum(["fresh_return", "market_return"]);
  const gross = lastSummary("Gross") ?? sales,
    discount = lastSummary("Discount") ?? 0,
    skuDiscount = lastSummary("SkuDiscount") ?? 0,
    returnCredit = lastSummary("Returns") ?? returnGross - reverseCents;
  if (Math.abs(gross - sales) > 0)
    warn("Sale items do not match the printed gross total.");
  if (
    Math.abs(returnGross - reverseCents - returnCredit) > 0 ||
    reverseCents > returnGross
  )
    warn("Returns do not match the printed return credit.");
  if ([gross, discount, skuDiscount, returnCredit].some((n) => n < 0))
    warn("Negative summary amounts need manual review.");
  if (discount + skuDiscount > gross) warn("Discounts exceed the sale amount.");
  const calculated = gross - discount - skuDiscount - returnCredit;
  if (!items.length) warn("No item quantities could be extracted.");
  if (total === null) warn("The invoice total could not be extracted.");
  else if (Math.abs(calculated - Math.round(total * 100)) > 0)
    warn(
      "The calculated net total does not match the print. Check discounts and returns.",
    );
  const accounting = {
    gross: gross / 100,
    discount: discount / 100,
    skuDiscount: skuDiscount / 100,
    returnGross: returnGross / 100,
    returnReversal: reverseCents / 100,
    returns: returnCredit / 100,
    calculatedNet: calculated / 100,
    difference:
      total === null ? null : (calculated - Math.round(total * 100)) / 100,
  };
  const sectionAfter = (pattern: RegExp) => {
    const start = lines.findIndex((line) => pattern.test(line));
    if (start < 0) return [];
    const section: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\s*[.*-]{5,}\s*$/.test(line)) break;
      if (line.trim()) section.push(line.trim());
    }
    return section;
  };
  const contact = (section: string[]) => ({
    phone: section.find((line) => /^\+?[\d ()-]{7,}$/.test(line)) || "",
    address: section
      .filter(
        (line) => !/^\+?[\d ()-]{7,}$/.test(line) && !/^N\/A$/i.test(line),
      )
      .join(", "),
  });
  const customer = contact(sectionAfter(/^\s*Customer\s*:\s*$/).slice(1));
  const distributorLines = sectionAfter(/^\s*(?:INVOICE|Delivery Note)\s*$/),
    distributorContact = contact(distributorLines.slice(1));
  const summary = [
    ...preview.matchAll(
      /^\s*([A-Za-z#][A-Za-z ()/.#-]*?)(?:\s*:\s*|\s{2,})(-?[\d,]+\.\d{2})\s*$/gm,
    ),
  ].map((m) => ({ label: m[1].trim(), amount: money(m[2]) }));
  return {
    version: RECEIPT_VERSION,
    accounting,
    number,
    shop,
    date: preview.match(/^\s*Bill date\s*:\s*(\d{4}-\d{2}-\d{2})/m)?.[1] || "",
    outletId: preview.match(/^\s*OUTLET ID\s*:\s*(\d+)/m)?.[1] || "",
    customerAddress: customer.address,
    customerPhone: customer.phone,
    distributor: { name: distributorLines[0] || "", ...distributorContact },
    territory: sectionAfter(/^\s*Serial No\s*:/)[0] || "",
    printedBy: preview.match(/^\s*printed by\s*:\s*(.+)$/im)?.[1]?.trim() || "",
    printedAt:
      preview.match(/^\s*(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2})\s*$/m)?.[1] || "",
    copyType: preview.includes("[DUPLICATE]")
      ? "duplicate"
      : preview.includes("[ORIGINAL]")
        ? "original"
        : "",
    totals: summary,
    total,
    items,
    warnings,
  };
}

// Source quantities, prices and dispositions are authoritative for recognized prints.
export function billReviewErrors(bill: any): string[] {
  const receipt: Receipt | null = bill.receipt;
  if (!receipt) return [];
  if (!Array.isArray(receipt.items) || !Array.isArray(receipt.warnings))
    return [
      "Print details are incomplete. Restore printed items before accepting.",
    ];
  const errors = receipt.reviewed ? [] : [...receipt.warnings];
  if (receipt.accounting?.difference)
    errors.push("Correct the amounts so the bill total reconciles.");
  if (
    receipt.items.some(
      (item) => !Number.isInteger(item.quantity) || item.quantity <= 0,
    )
  )
    errors.push("Quantities must be positive whole numbers.");
  if (receipt.version !== RECEIPT_VERSION)
    errors.push("Reload the extracted print before accepting.");
  if (bill.number !== receipt.number)
    errors.push("Save the updated bill details before accepting.");
  const seen = new Set<number>();
  for (const item of bill.items) {
    const source = receipt.items[item.sourceLine];
    if (!source || seen.has(item.sourceLine)) {
      errors.push("Each bill item needs one stock or return entry.");
      continue;
    }
    seen.add(item.sourceLine);
    if (Math.round(item.quantity * 1000) !== Math.round(source.quantity * 1000))
      errors.push("Save the updated quantities before accepting.");
  }
  if (seen.size !== receipt.items.length)
    errors.push("Some bill items are missing their stock or return entry.");
  return [...new Set(errors)];
}

export function recalculateReceipt(receipt: Receipt): Receipt {
  const sum = (kinds: LineKind[]) =>
    receipt.items
      .filter((i) => kinds.includes(i.kind))
      .reduce((n, i) => n + Math.round(i.amount * 100), 0);
  const gross = sum(["sale"]),
    returnGross = sum(["fresh_return", "market_return"]),
    discount = Math.round((receipt.accounting.discount || 0) * 100),
    skuDiscount = Math.round((receipt.accounting.skuDiscount || 0) * 100),
    reversal = Math.round((receipt.accounting.returnReversal || 0) * 100),
    returns = returnGross - reversal;
  const total = (gross - discount - skuDiscount - returns) / 100;
  return {
    ...receipt,
    total,
    accounting: {
      gross: gross / 100,
      discount: discount / 100,
      skuDiscount: skuDiscount / 100,
      returnGross: returnGross / 100,
      returnReversal: reversal / 100,
      returns: returns / 100,
      calculatedNet: total,
      difference: 0,
    },
  };
}
