// Normalize documented print/supplier spelling and outer-case notation only.
// Keep weights, flavours, formulation, and unrecognized suffixes distinct.
export function printedIdentity(name: string): string {
  let value = name
    .toUpperCase()
    .replace(/×/g, "X")
    .replace(/CHOCO[ -]?LA\b/g, "CHOCOLA")
    .replace(/CHOCO[ -]?LE\b/g, "CHOCOLE")
    .replace(/\bL\s*\/\s*CAKE\b/g, "LAYER CAKE")
    .replace(/(\d)\s+(KG|G|ML|L)\b/g, "$1$2")
    .replace(/\bNET(?=X|\b)\.?/g, " ")
    .replace(
      /(\d+(?:\.\d+)?(?:KG|G|ML|L))\s*\.?\s*(?:X\s*\d+\s*)+(?:DZ|EA)?\b/g,
      "$1",
    )
    .replace(/\b(?:CHO|CHOC|CHOCO)\b\.?/g, "CHOCOLATE")
    .replace(/\bSPONGE LAYER(?: CAKE)?\b/g, "SPONGE LAYER CAKE")
    .replace(/\bCHUNKY(?: CHOCOLATE)? TRIO\b/g, "CHUNKY CHOCOLATE TRIO")
    .replace(/\bB\/B\b/g, "BB")
    .replace(/\bCRISPY\b/g, "CRISPIES")
    .replace(/\bRITZBURY UNO\b/g, "UNO")
    .replace(/[^A-Z0-9.]+/g, " ")
    .trim();
  // These labels are packaging/print suffixes, never flavours or weights.
  value = value
    .replace(/\b(?:SPS|SACMI|PP)\b/g, " ")
    .replace(/\bCHOCOLATE A NUT\b/g, "CHOC A NUT")
    .replace(/\bBB\b/g, " ");
  if (/^BUBBLES\b/.test(value)) value = value.replace(/\b(?:NEW|BTL)\b/g, " ");
  if (/^CHOCOLE\b/.test(value))
    value = value.replace(/\b(?:BAG|BOTTLE)\b/g, " ");
  if (/^CHUNKY CHOCOLATE TRIO\b/.test(value))
    value = value.replace(/\bA\b/g, " ");
  return value.split(/\s+/).filter(Boolean).sort().join(" ");
}
const tokens = (name: string) =>
  printedIdentity(name).split(" ").filter(Boolean);
const grams = (s: string) =>
  new Set(
    Array.from({ length: Math.max(0, s.length - 1) }, (_, i) =>
      s.slice(i, i + 2),
    ),
  );
function similarity(a: string, b: string) {
  if (a === b) return 1;
  const x = grams(a),
    y = grams(b);
  return x.size + y.size
    ? (2 * [...x].filter((t) => y.has(t)).length) / (x.size + y.size)
    : 0;
}
// Fuzzy scores order suggestions only. They never select or merge a product.
export function productRelevance(query: string, name: string): number {
  const a = tokens(query),
    b = tokens(name);
  if (!a.length || !b.length) return 0;
  if (a.join(" ") === b.join(" ")) return 1000;
  const weights = (t: string[]) =>
    t.filter((v) => /^\d+(?:\.\d+)?(?:KG|G|ML|L)$/.test(v));
  const aw = weights(a),
    bw = weights(b);
  const namesA = a.filter((t) => !aw.includes(t)),
    namesB = b.filter((t) => !bw.includes(t));
  const score =
    namesA.length && namesB.length
      ? namesA.reduce(
          (sum, word) =>
            sum + Math.max(...namesB.map((other) => similarity(word, other))),
          0,
        ) / namesA.length
      : 0;
  const weightMatch = !aw.length || aw.every((w) => bw.includes(w));
  return (
    Math.round(score * 100) +
    (weightMatch && aw.length ? 10 : 0) -
    (aw.length && bw.length && !weightMatch ? 15 : 0)
  );
}
