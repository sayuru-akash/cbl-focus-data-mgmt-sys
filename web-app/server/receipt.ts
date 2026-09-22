export type ReceiptLine = { name: string; unit: string; quantity: number; rate: number; amount: number; mrp?: number };
export type Receipt = { number: string; shop: string; date: string; outletId: string; customerAddress:string; customerPhone:string; distributor:{name:string;address:string;phone:string}; territory:string; printedBy:string; printedAt:string; copyType:string; totals:{label:string;amount:number}[]; total: number | null; items: ReceiptLine[]; warnings: string[] };

// Decode the text layer only. Original bytes remain the source of truth.
export function decodePrint(raw: Uint8Array) {
  const text: number[] = [];
  let unknown = false;
  for (let i = 0; i < raw.length && text.length < 100000;) {
    const b = raw[i], c = raw[i + 1];
    if (b === 0x1b || b === 0x1d) {
      let length = 2;
      if (b === 0x1d && c === 0x28) length = 5 + (raw[i + 3] || 0) + 256 * (raw[i + 4] || 0);
      else if (b === 0x1d && c === 0x38) length = 7 + (raw[i + 3] || 0) + 256 * (raw[i + 4] || 0) + 65536 * (raw[i + 5] || 0) + 16777216 * (raw[i + 6] || 0);
      else if (b === 0x1d && c === 0x76) length = 8 + ((raw[i + 4] || 0) + 256 * (raw[i + 5] || 0)) * ((raw[i + 6] || 0) + 256 * (raw[i + 7] || 0));
      else if (b === 0x1b && c === 0x2a) length = 5 + ((raw[i + 3] || 0) + 256 * (raw[i + 4] || 0)) * (raw[i + 2] >= 32 ? 3 : 1);
      else if (b === 0x1d && c === 0x6b) {
        if (raw[i + 2] > 6) length = 4 + (raw[i + 3] || 0);
        else { const end = raw.indexOf(0, i + 3); length = end < 0 ? raw.length - i : end - i + 1; }
      } else if ([0x24, 0x5c].includes(c) || (b === 0x1d && [0x4c, 0x50, 0x57].includes(c))) length = 4;
      else if (b === 0x1b && c === 0x57) length = 10;
      else if ((b === 0x1b && [0x20,0x21,0x2d,0x33,0x45,0x47,0x4a,0x4d,0x52,0x54,0x61,0x64,0x74,0x7b].includes(c)) ||
               (b === 0x1d && [0x21,0x42,0x48,0x49,0x61,0x66,0x68,0x72,0x77].includes(c))) length = 3;
      else if (!(b === 0x1b && [0x32,0x40,0x4c,0x53].includes(c))) unknown = true;
      if (i + length > raw.length) unknown = true;
      i += length;
    } else if (b === 0x10 && c === 0x04) i += 3;
    else { if (b === 9 || b === 10 || b === 13 || b >= 32) text.push(b); i++; }
  }
  const preview = new TextDecoder().decode(new Uint8Array(text)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { preview, uncertain: unknown || preview.includes("\ufffd") };
}

const money = (s: string) => Number(s.replace(/,/g, ""));
export function parseReceipt(preview: string, uncertain = false): Receipt | null {
  const number = preview.match(/^\s*Serial No\s*:\s*(\d+)\s*$/m)?.[1];
  const shop = preview.match(/^\s*Customer\s*:\s*\n([^\n]+)/m)?.[1]?.trim();
  if (!number || !shop || !/^\s*(?:INVOICE|Delivery Note)\s*$/m.test(preview)) return null;
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  if (uncertain) warn("Check the original: some print commands or characters could not be decoded.");
  if ((preview.match(/^\s*Serial No\s*:/gm) || []).length > 1) warn("Multiple invoice copies detected. Review quantities before accepting.");
  const items: ReceiptLine[] = [];
  const lines = preview.split("\n");
  const totals = [...preview.matchAll(/^\s*Net(?:\s*\(Rs\.?\)|\s+Total\s*\(Rs\.?\))\s*:\s*([\d,]+\.\d{2})\s*$/gmi)];
  const total = totals.length ? money(totals[totals.length - 1][1]) : null;
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^\s*\d+\s{2,}(.+?)\s*$/);
    if (!name) continue;
    const detail = lines[i + 1]?.match(/^\s*([A-Z][A-Z0-9./-]*)\s+(-?[\d,]+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$/);
    if (!detail) { warn("Some item rows need manual review."); continue; }
    const mrp = name[1].match(/\s+MRP\s+([\d,]+\.\d{2})\s*$/i);
    const quantity = money(detail[2]), rate = money(detail[3]), amount = money(detail[4]);
    if (quantity <= 0 || amount < 0) warn("Returns or negative quantities need manual stock review.");
    if (Math.abs(quantity * rate - amount) > 0.011) warn("An item amount differs from quantity × rate.");
    items.push({ name: name[1].replace(/\s+MRP\s+[\d,]+\.\d{2}\s*$/i, "").trim(), unit: detail[1], quantity, rate, amount, ...(mrp ? { mrp: money(mrp[1]) } : {}) });
    i++;
  }
  const returns = preview.match(/^\s*Returns\s*:\s*(-?[\d,]+\.\d{2})\s*$/mi);
  if (returns && money(returns[1]) !== 0) warn("Returns need manual stock review.");
  if (/^.*(?:FREE\s+(?:ISSUE|PRODUCT)|RETURN\s+(?:PRODUCT|ITEM)|REBATE).*$/mi.test(preview)) warn("Free issues, returns, or rebates need manual review.");
  if (!items.length) warn("No item quantities could be extracted.");
  if (total === null) warn("The invoice total could not be extracted.");
  else if (Math.abs(items.reduce((sum, item) => sum + item.amount, 0) - total) > 0.011) warn("Item amounts do not match the net total. Check discounts and returns.");
  const sectionAfter = (pattern: RegExp) => {
    const start=lines.findIndex(line=>pattern.test(line));
    if(start<0)return [];
    const section:string[]=[];
    for(const line of lines.slice(start+1)){if(/^\s*[.*-]{5,}\s*$/.test(line))break;if(line.trim())section.push(line.trim());}
    return section;
  };
  const contact = (section:string[]) => ({phone:section.find(line=>/^\+?[\d ()-]{7,}$/.test(line))||"",address:section.filter(line=>!/^\+?[\d ()-]{7,}$/.test(line)&&!/^N\/A$/i.test(line)).join(", ")});
  const customer=contact(sectionAfter(/^\s*Customer\s*:\s*$/).slice(1));
  const distributorLines=sectionAfter(/^\s*(?:INVOICE|Delivery Note)\s*$/),distributorContact=contact(distributorLines.slice(1));
  const summary=[...preview.matchAll(/^\s*([A-Za-z#][A-Za-z ()/.#-]*?)(?:\s*:\s*|\s{2,})(-?[\d,]+\.\d{2})\s*$/gm)].map(m=>({label:m[1].trim(),amount:money(m[2])}));
  return { number, shop, date: preview.match(/^\s*Bill date\s*:\s*(\d{4}-\d{2}-\d{2})/m)?.[1] || "", outletId: preview.match(/^\s*OUTLET ID\s*:\s*(\d+)/m)?.[1] || "", customerAddress:customer.address,customerPhone:customer.phone,distributor:{name:distributorLines[0]||"",...distributorContact},territory:sectionAfter(/^\s*Serial No\s*:/)[0]||"",printedBy:preview.match(/^\s*printed by\s*:\s*(.+)$/mi)?.[1]?.trim()||"",printedAt:preview.match(/^\s*(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2})\s*$/m)?.[1]||"",copyType:preview.includes("[DUPLICATE]")?"duplicate":preview.includes("[ORIGINAL]")?"original":"",totals:summary,total, items, warnings };
}
