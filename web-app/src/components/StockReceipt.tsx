import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, type Product, type Purchase, type PurchaseLine } from "../api";
import { ErrorText, Modal } from "./UI";

export const newStockLine = (): PurchaseLine => ({
  productId: "",
  newProduct: { sku: "", name: "", unit: "PKT" },
  quantity: 1,
  costPrice: null,
  mrp: null,
});
export default function StockReceipt({
  products,
  initial,
  onClose,
  onSaved,
}: {
  products: Product[];
  initial?: Purchase;
  onClose: () => void;
  onSaved: (purchase: Purchase, received: boolean) => void;
}) {
  const [purchase, setPurchase] = useState<Purchase>(
    initial || {
      number: "",
      supplier: "",
      received: new Date().toLocaleDateString("en-CA"),
      lines: [newStockLine()],
      note: "",
    },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const locked = purchase.status === "received";
  const change = (index: number, values: Partial<PurchaseLine>) =>
    setPurchase({
      ...purchase,
      lines: purchase.lines.map((line, i) =>
        i === index ? { ...line, ...values } : line,
      ),
    });
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const receive =
      (e.nativeEvent as SubmitEvent).submitter?.getAttribute("data-action") ===
      "receive";
    setBusy(true);
    setError("");
    try {
      const saved = await api<Purchase>(
        "/purchases" + (purchase.id ? "/" + purchase.id : ""),
        {
          method: purchase.id ? "PUT" : "POST",
          body: JSON.stringify(purchase),
        },
      );
      setPurchase(saved);
      const result = receive
        ? await api<Purchase>(`/purchases/${saved.id}/receive`, {
            method: "POST",
          })
        : saved;
      onSaved(result, receive);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={locked ? `Stock in · ${purchase.number}` : "Receive stock"}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form onSubmit={submit}>
        <div className="fields three">
          <label>
            Reference
            <input
              autoFocus
              name="reference"
              value={purchase.number}
              required
              maxLength={100}
              disabled={busy || locked}
              onChange={(e) =>
                setPurchase({ ...purchase, number: e.target.value })
              }
            />
          </label>
          <label>
            Supplier
            <input
              name="supplier"
              value={purchase.supplier}
              required
              maxLength={200}
              disabled={busy || locked}
              onChange={(e) =>
                setPurchase({ ...purchase, supplier: e.target.value })
              }
            />
          </label>
          <label>
            Date
            <input
              name="received"
              type="date"
              value={purchase.received}
              required
              disabled={busy || locked}
              onChange={(e) =>
                setPurchase({ ...purchase, received: e.target.value })
              }
            />
          </label>
        </div>
        <div className="stock-receipt-lines">
          {purchase.lines.map((line, index) => {
            const product = products.find((p) => p.id === line.productId);
            return (
              <section className="stock-receipt-line" key={index}>
                <div className="receive-product-row">
                  <label>
                    Item {index + 1}
                    <select
                      aria-label={`Receive item ${index + 1}`}
                      value={line.productId}
                      disabled={busy || locked}
                      onChange={(e) =>
                        change(index, {
                          productId: e.target.value,
                          ...(!e.target.value
                            ? { newProduct: { sku: "", name: "", unit: "PKT" } }
                            : { newProduct: undefined }),
                        })
                      }
                    >
                      <option value="">New item</option>
                      {line.productId && !product && (
                        <option value={line.productId}>
                          {line.newProduct?.name || "Archived item"}
                        </option>
                      )}
                      {products.map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.name} · {p.sku}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!locked && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove received item ${index + 1}`}
                      disabled={busy || purchase.lines.length === 1}
                      onClick={() =>
                        setPurchase({
                          ...purchase,
                          lines: purchase.lines.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
                {!line.productId && (
                  <div className="fields three new-stock-fields">
                    <label>
                      Name
                      <input
                        aria-label={`New item name ${index + 1}`}
                        required
                        maxLength={200}
                        disabled={busy}
                        value={line.newProduct?.name || ""}
                        onChange={(e) =>
                          change(index, {
                            newProduct: {
                              ...line.newProduct!,
                              name: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      SKU
                      <input
                        aria-label={`New SKU ${index + 1}`}
                        placeholder="Auto"
                        maxLength={80}
                        disabled={busy}
                        value={line.newProduct?.sku || ""}
                        onChange={(e) =>
                          change(index, {
                            newProduct: {
                              ...line.newProduct!,
                              sku: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Stock unit
                      <input
                        aria-label={`Stock unit ${index + 1}`}
                        required
                        maxLength={30}
                        disabled={busy}
                        value={line.newProduct?.unit || ""}
                        onChange={(e) =>
                          change(index, {
                            newProduct: {
                              ...line.newProduct!,
                              unit: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                <div className="fields three">
                  <label>
                    Quantity (
                    {product?.unit || line.newProduct?.unit || "units"})
                    <input
                      aria-label={`Received quantity ${index + 1}`}
                      type="number"
                      min="0.001"
                      step="0.001"
                      required
                      disabled={busy || locked}
                      value={line.quantity}
                      onChange={(e) =>
                        change(index, { quantity: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Cost / unit
                    <input
                      aria-label={`Unit cost ${index + 1}`}
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Optional"
                      disabled={busy || locked}
                      value={line.costPrice ?? ""}
                      onChange={(e) =>
                        change(index, {
                          costPrice:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    MRP
                    <input
                      aria-label={`Received MRP ${index + 1}`}
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Optional"
                      disabled={busy || locked}
                      value={line.mrp ?? ""}
                      onChange={(e) =>
                        change(index, {
                          mrp:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              </section>
            );
          })}
        </div>
        {!locked && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              setPurchase({
                ...purchase,
                lines: [...purchase.lines, newStockLine()],
              })
            }
          >
            <Plus size={16} />
            Add item
          </button>
        )}
        <div className="receipt-cost">
          <span>
            {purchase.lines.some((l) => l.costPrice === null)
              ? "Known cost"
              : "Cost total"}
          </span>
          <strong>
            Rs{" "}
            {(
              purchase.lines.reduce(
                (sum, l) =>
                  sum + Math.round((l.costPrice || 0) * 100 * l.quantity),
                0,
              ) / 100
            ).toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </strong>
        </div>
        <label className="note-label">
          Note
          <textarea
            rows={2}
            maxLength={1000}
            value={purchase.note}
            disabled={busy || locked}
            onChange={(e) => setPurchase({ ...purchase, note: e.target.value })}
          />
        </label>
        <ErrorText message={error} />
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
          {!locked && (
            <>
              <button type="submit" disabled={busy} data-action="draft">
                Save draft
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy}
                data-action="receive"
              >
                {busy ? "Saving…" : "Receive stock"}
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
