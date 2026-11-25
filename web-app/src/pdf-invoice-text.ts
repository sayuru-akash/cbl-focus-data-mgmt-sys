import { readMoney } from "../server/supplier-parser";

export type PdfText = { text: string; x: number; y: number };

// Text positions are fractions of the page width and height, with y increasing
// down the sheet. Read the printed columns of the CBL supplier layout.
export function readPdfInvoicePage(text: PdfText[]) {
  const rows: PdfText[][] = [];
  for (const token of [...text].sort((a, b) => a.y - b.y)) {
    const previous = rows.at(-1);
    if (previous && token.y - previous[0]!.y < 0.002) previous.push(token);
    else rows.push([token]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  const join = (row: PdfText[]) =>
    row
      .map((part) => part.text)
      .join(" ")
      .trim();
  const values = rows.map(join);
  const header = (pattern: RegExp) => values.find((row) => pattern.test(row));
  const invoice = header(/Tax Invoice (?:Number|No\.?):/i)?.match(
    /Tax Invoice (?:Number|No\.?):\s*([\w/-]+)/i,
  )?.[1];
  const date = header(/Date of Invoice:/i)?.match(
    /Date of Invoice:\s*(\d{2})\/(\d{2})\/(\d{4})/i,
  );
  const page = header(/Page:\s*\d+\s+of\s+\d+/i)?.match(
    /Page:\s*(\d+)\s+of\s+(\d+)/i,
  );
  const tin = header(/^Supplier.s TIN/i)?.match(
    /^Supplier.s TIN\s+(\d{6,20})\b/i,
  )?.[1];
  const supplier = text.find(
    (part) =>
      part.x < 0.5 &&
      /^(?:CBL FOODS INTERNATIONAL|PLENTY FOODS)\s*\(PVT\)\s*LTD$/i.test(
        part.text,
      ),
  )?.text;
  if (!invoice || !date || !page || !tin || !supplier) return null;
  const total = (pattern: RegExp) => {
    const value = header(pattern)?.match(/([\d,]+\.\d{2})$/)?.[1];
    return value ? readMoney(value) : null;
  };
  const document =
    header(/Document No\.?\s*:?[ \t]*\d+/i)?.match(
      /Document No\.?\s*:?\s*(\d+)/i,
    )?.[1] || "";
  const items: {
    code: string;
    description: string;
    weight: string;
    unit: string;
    sold: number | null;
    boxes: number | null;
    unitPrice: number | null;
    amount: number | null;
  }[] = [];
  const table = values.findIndex((row) =>
    /Description of Goods.*Unit Price.*Amount Including VAT/i.test(row),
  );
  if (table >= 0) {
    for (const row of rows.slice(table + 2)) {
      if (/^(?:Total Order Value|Total Value of Supply)/i.test(join(row)))
        break;
      const col = (left: number, right: number) =>
        join(row.filter(({ x }) => x >= left && x < right));
      const code = col(0, 0.13);
      const description = col(0.13, 0.419);
      if (
        !code &&
        description &&
        row.every(({ x }) => x >= 0.13 && x < 0.419)
      ) {
        const last = items.at(-1);
        if (!last) return null;
        last.description += " " + description;
        continue;
      }
      if (!/^[A-Z0-9][A-Z0-9._/-]{1,79}$/i.test(code) || !description)
        return null;
      items.push({
        code,
        description,
        weight: col(0.419, 0.49),
        boxes: readMoney(col(0.49, 0.56)),
        sold: readMoney(col(0.56, 0.65)),
        unit: col(0.65, 0.72),
        unitPrice: readMoney(col(0.72, 0.83)),
        amount: readMoney(col(0.83, 1)),
      });
    }
  }
  return {
    supplier,
    tin,
    invoice,
    document,
    date: `${date[3]}-${date[1]}-${date[2]}`,
    page: Number(page[1]),
    count: Number(page[2]),
    rotation: 0 as const,
    gross: total(/^Total Order Value/i),
    discount: total(/^Less Discount/i),
    total: total(/^Total Amount including VAT/i),
    items,
  };
}
