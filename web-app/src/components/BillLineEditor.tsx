import type { ReceiptLine } from "../../server/receipt";
const round = (n: number) => Math.round(n * 100) / 100;
export function editLine(
  line: ReceiptLine,
  patch: Partial<ReceiptLine>,
): ReceiptLine {
  const next = { ...line, ...patch };
  if (patch.kind === "free")
    return { ...next, rate: 0, amount: 0, discount: 0 };
  if (patch.amount !== undefined)
    next.discount = round(next.quantity * next.rate - next.amount);
  else if (
    patch.quantity !== undefined ||
    patch.rate !== undefined ||
    patch.discount !== undefined
  )
    next.amount = round(next.quantity * next.rate - (next.discount || 0));
  return next;
}
export default function BillLineEditor({
  line,
  onChange,
  disabled,
}: {
  line: ReceiptLine;
  onChange: (line: ReceiptLine) => void;
  disabled: boolean;
}) {
  const change = (patch: Partial<ReceiptLine>) =>
    onChange(editLine(line, patch));
  return (
    <details className="bill-line-editor">
      <summary>Edit details</summary>
      <div className="fields two">
        <label>
          Item name
          <input
            value={line.name}
            disabled={disabled}
            onChange={(e) => change({ name: e.target.value })}
          />
        </label>
        <label>
          Type
          <select
            value={line.kind}
            disabled={disabled}
            onChange={(e) =>
              change({
                kind: e.target.value as ReceiptLine["kind"],
                section:
                  e.target.value === "market_return"
                    ? "MARKET"
                    : e.target.value.toUpperCase(),
              })
            }
          >
            <option value="sale">Sale</option>
            <option value="free">Free item</option>
            <option value="fresh_return">Fresh return</option>
            <option value="market_return">Market / expiry return</option>
          </select>
        </label>
        <label>
          Unit
          <input
            value={line.unit}
            disabled={disabled}
            onChange={(e) => change({ unit: e.target.value })}
          />
        </label>
        <label>
          MRP
          <input
            type="number"
            min="0"
            step="0.01"
            value={line.mrp ?? ""}
            disabled={disabled}
            onChange={(e) =>
              change({
                mrp: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Rate
          <input
            type="number"
            min="0"
            step="0.01"
            value={line.rate}
            disabled={disabled || line.kind === "free"}
            onChange={(e) => change({ rate: Number(e.target.value) })}
          />
        </label>
        <label>
          Line discount
          <input
            type="number"
            min="0"
            step="0.01"
            value={line.discount || 0}
            disabled={disabled || line.kind === "free"}
            onChange={(e) => change({ discount: Number(e.target.value) })}
          />
        </label>
        <label>
          Line total
          <input
            type="number"
            min="0"
            step="0.01"
            value={line.amount}
            disabled={disabled || line.kind === "free"}
            onChange={(e) => change({ amount: Number(e.target.value) })}
          />
        </label>
      </div>
    </details>
  );
}
