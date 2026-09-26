export type OcrBlock = {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type IntakeLine = {
  id: string;
  page: number;
  code: string;
  description: string;
  weight: string;
  boxes: number | null;
  sold: number | null;
  unit: string;
  unitPrice: number | null;
  amount: number | null;
  packSize: number | null;
  packEvidence: string;
  mrp: number | null;
  productId: string;
  reviewed: boolean;
};
export type PageFields = {
  page: number | null;
  count: number | null;
  invoice: string;
  document: string;
  reviewed: boolean;
};
export type IntakeDraft = {
  supplier: string;
  tin: string;
  number: string;
  date: string;
  gross: number | null;
  discount: number | null;
  total: number | null;
  pages: PageFields[];
  lines: IntakeLine[];
  headerReviewed: boolean;
};
const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
export const readMoney = (s: string): number | null => {
  const cleaned = s.trim().replace(/[.,]$/, "");
  if (!/^\d[\d,.]*$/.test(cleaned)) return null;
  const last = cleaned.lastIndexOf(".");
  const value =
    last >= 0
      ? cleaned.slice(0, last).replace(/[,.]/g, "") + cleaned.slice(last)
      : cleaned.replace(/,/g, "");
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export function packFrom(description: string, unit: string) {
  const text = plain(description).replace(/\s/g, "");
  if (plain(unit) === "DZ") return { size: 12, evidence: "1 DZ = 12 packets" };
  if (["PKT", "EA", "PCS"].includes(plain(unit)))
    return { size: 1, evidence: `1 ${unit} = 1 packet` };
  if (plain(unit) !== "MC")
    return { size: null, evidence: "Check the invoice unit" };
  // Weight is not a pack count. Read only an explicit packaging suffix.
  const match = text.match(/\d+(?:\.\d+)?(?:KG|G|C|ML|L)((?:X\d+)+)EA\b/);
  if (!match)
    return { size: null, evidence: "Pack size is unclear in the photo" };
  const values = match[1]!.slice(1).split("X").map(Number);
  const size = values.reduce((a, b) => a * b, 1);
  return { size: size > 0 && size <= 10000 ? size : null, evidence: match[0] };
}
const center = (b: OcrBlock) => b.y + b.height / 2;
export function parseSupplierPage(blocks: OcrBlock[], index: number) {
  const header = (label: RegExp, side = 0) =>
    blocks.find((b) => label.test(b.text) && (side === 0 || b.x > side));
  const value = (label: RegExp) => {
    const b = header(label);
    if (!b) return "";
    return (
      blocks
        .filter(
          (v) =>
            v.x >= b.x + b.width - 0.015 &&
            (b.x > 0.5 || v.x < 0.52) &&
            !/:/.test(v.text) &&
            Math.abs(center(v) - center(b)) < 0.014 &&
            v !== b,
        )
        .sort(
          (left, right) =>
            Math.abs(center(left) - center(b)) -
              Math.abs(center(right) - center(b)) || left.x - right.x,
        )[0]?.text || ""
    );
  };
  const pageLabel = header(/^Page\s*:/i);
  const pageText = pageLabel
    ? blocks
        .filter(
          (b) =>
            b.x >= pageLabel.x &&
            Math.abs(center(b) - center(pageLabel)) < 0.012,
        )
        .sort((a, b) => a.x - b.x)
        .map((b) => b.text)
        .join(" ")
    : "";
  const pageMatch =
    blocks
      .map((b) => b.text.match(/Page\s*:?\s*(\d+)\s*of\s*(\d+)/i))
      .find(Boolean) || pageText.match(/Page\s*:?\s*(\d+)\s*of\s*(\d+)/i);
  const partialPage = blocks
    .map((b) => b.text.match(/^Page\s*:\s*(\d+)$/i)?.[1])
    .find(Boolean);
  const doc =
    header(/Document No/i)?.text.match(/No\.?\s*(\d+)/i)?.[1] ||
    value(/Document No/i).replace(/\s/g, "");
  const invoice = value(/^Tax Invoice No/i);
  const dt = (value(/^Date of Invoice/i) || value(/^Date of Delivery/i)).match(
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
  );
  const date = dt
    ? `${dt[3]}-${dt[1]!.padStart(2, "0")}-${dt[2]!.padStart(2, "0")}`
    : "";
  const unitHeader = header(/^Unit$/i),
    descHeader = header(/^Description of Goods/i);
  const qtyHeader = header(/^Quantity$/i),
    boxHeader = header(/^Boxes$/i),
    priceHeader = header(/^Unit Price/i);
  const amountHeader = header(/^Amount.*VAT/i),
    weightHeader = header(/^Weight$/i);
  const lines: IntakeLine[] = [];
  if (
    unitHeader &&
    descHeader &&
    qtyHeader &&
    boxHeader &&
    priceHeader &&
    amountHeader &&
    weightHeader
  ) {
    const tableY = Math.max(
      qtyHeader.y + qtyHeader.height,
      descHeader.y + descHeader.height,
    );
    const tableEnd =
      blocks
        .filter(
          (b) =>
            b.y > tableY &&
            /^Total (Order Value|Value of Supply)/i.test(b.text),
        )
        .sort((a, b) => a.y - b.y)[0]?.y || 0.85;
    const anchors = blocks
      .filter(
        (b) =>
          b.y > tableY &&
          b.y < tableEnd &&
          b.x >= qtyHeader.x - 0.018 &&
          b.x < unitHeader.x - 0.02 &&
          readMoney(b.text) !== null,
      )
      .sort((a, b) => a.y - b.y);
    const slopes = anchors
      .flatMap((a) => {
        const match = blocks
          .filter(
            (b) =>
              b.x > amountHeader.x &&
              Math.abs(center(b) - center(a)) < 0.017 &&
              readMoney(b.text) !== null,
          )
          .sort(
            (b, c) =>
              Math.abs(center(b) - center(a)) - Math.abs(center(c) - center(a)),
          )[0];
        return match ? [(center(match) - center(a)) / (match.x - a.x)] : [];
      })
      .sort((a, b) => a - b);
    const slope = slopes[Math.floor(slopes.length / 2)] || 0;
    const yAtUnit = (b: OcrBlock) =>
      center(b) - slope * (b.x - (anchors[0]?.x || qtyHeader.x));
    const bounds = [
      descHeader.x - 0.02,
      weightHeader.x - 0.02,
      boxHeader.x - 0.018,
      qtyHeader.x - 0.018,
      unitHeader.x - 0.02,
      priceHeader.x - 0.015,
      amountHeader.x - 0.01,
    ];
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i]!,
        start = center(anchor) - 0.006,
        end = anchors[i + 1]
          ? center(anchors[i + 1]!) - 0.006
          : center(anchor) + 0.034;
      const row = blocks
        .filter((b) => yAtUnit(b) >= start && yAtUnit(b) < end && b.y > tableY)
        .sort((a, b) => a.y - b.y || a.x - b.x);
      const col = (from: number, to: number) =>
        row.filter((b) => b.x >= from && b.x < to);
      const text = (from: number, to: number) =>
        col(from, to)
          .map((b) => b.text)
          .join(" ");
      const numeric = (from: number, to: number) =>
        col(from, to)
          .map((b) => readMoney(b.text))
          .find((n) => n !== null) ?? null;
      const description = text(bounds[0]!, bounds[1]!);
      const unit = plain(text(bounds[4]!, bounds[5]!)),
        pack = packFrom(description, unit);
      const code = text(0, bounds[0]!).replace(/\s/g, "").replace(/^С/, "C");
      lines.push({
        id: crypto.randomUUID(),
        page: index,
        code,
        description,
        weight: text(bounds[1]!, bounds[2]!),
        boxes: numeric(bounds[2]!, bounds[3]!),
        sold: numeric(bounds[3]!, bounds[4]!),
        unit,
        unitPrice: numeric(bounds[5]!, bounds[6]!),
        amount: numeric(bounds[6]!, 1),
        packSize: pack.size,
        packEvidence: pack.evidence,
        mrp: null,
        productId: "",
        reviewed: false,
      });
    }
  }
  const totalFor = (pattern: RegExp) => {
    const b = header(pattern);
    if (!b) return null;
    // Forms can slope: the rightmost amount is slightly above its left label.
    const candidates = blocks.filter(
      (v) =>
        v.x > 0.75 &&
        center(v) > center(b) - 0.045 &&
        center(v) < center(b) + 0.01 &&
        readMoney(v.text) !== null,
    );
    return candidates.sort(
      (a, c) =>
        Math.abs(center(a) - center(b)) - Math.abs(center(c) - center(b)),
    )[0];
  };
  const gross = totalFor(/^Total Order Value/i),
    discount = totalFor(/^Less Discount/i),
    total = totalFor(/^Total Amount including VAT/i);
  const supplierLabel = header(/^Supplier.s Name/i),
    tinLabel = header(/^Supplier.s TIN/i);
  const supplier =
    blocks.find(
      (b) =>
        b.x > 0.15 &&
        b.x < 0.5 &&
        supplierLabel &&
        Math.abs(b.y - supplierLabel.y) < 0.02 &&
        /FOODS|LTD|LIMITED/i.test(b.text),
    )?.text || value(/^Supplier.s Name/i);
  const tin =
    blocks.find(
      (b) =>
        b.x > 0.15 &&
        b.x < 0.5 &&
        tinLabel &&
        Math.abs(b.y - tinLabel.y) < 0.015 &&
        /^\d{6,20}$/.test(b.text),
    )?.text || value(/^Supplier.s TIN/i);
  return {
    supplier,
    tin,
    invoice,
    date,
    fields: {
      page: pageMatch
        ? Number(pageMatch[1])
        : partialPage
          ? Number(partialPage)
          : null,
      count: pageMatch ? Number(pageMatch[2]) : null,
      invoice,
      document: doc,
      reviewed: false,
    } as PageFields,
    lines,
    gross: gross ? readMoney(gross.text) : null,
    discount: discount ? readMoney(discount.text) : null,
    total: total ? readMoney(total.text) : null,
  };
}
