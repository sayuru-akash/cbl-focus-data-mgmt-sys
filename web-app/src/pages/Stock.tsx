import { useEffect, useState } from "react";
import { Plus, Package, MoreHorizontal } from "lucide-react";
import { api, date, type Product, type Purchase } from "../api";
import StockReceipt from "../components/StockReceipt";
import { Empty, SearchBox, Modal, ErrorText } from "../components/UI";
export default function Stock({
  products,
  refresh,
}: {
  products: Product[];
  refresh: () => void;
}) {
  const [search, setSearch] = useState(""),
    [mode, setMode] = useState<
      "new" | "edit" | "adjust" | "history" | "delete" | "batches" | null
    >(null),
    [selected, setSelected] = useState<Product | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<any[]>([]);
  const [tab, setTab] = useState("items"),
    [purchases, setPurchases] = useState<Purchase[]>([]),
    [receiving, setReceiving] = useState<Purchase | true | null>(null);
  const loadPurchases = () =>
    api<Purchase[]>("/purchases")
      .then(setPurchases)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void loadPurchases();
  }, []);
  function open(mode: any, p: Product | null = null) {
    setMode(mode);
    setSelected(p);
    setError("");
    setHistory([]);
    if (mode === "history" && p)
      api("/products/" + p.id + "/history")
        .then(setHistory)
        .catch((e) => setError(e.message));
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (mode === "delete")
        await api("/products/" + selected!.id, { method: "DELETE" });
      else if (mode === "adjust")
        await api("/products/" + selected!.id + "/adjust", {
          method: "POST",
          body: JSON.stringify({
            quantity: Number(values.quantity),
            reason: values.reason,
            mrp: values.mrp ? Number(values.mrp) : null,
            costPrice: values.costPrice ? Number(values.costPrice) : null,
          }),
        });
      else
        await api("/products" + (selected ? "/" + selected.id : ""), {
          method: selected ? "PUT" : "POST",
          body: JSON.stringify({
            ...values,
            stock: Number(values.stock || 0),
            minimum: Number(values.minimum || 0),
            mrp: values.mrp ? Number(values.mrp) : null,
            costPrice: values.costPrice ? Number(values.costPrice) : null,
          }),
        });
      refresh();
      setMode(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const visible = products.filter((p) =>
    `${p.name} ${p.sku}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Stock</h1>
          <p>
            {products.length} {products.length === 1 ? "item" : "items"}
          </p>
        </div>
        <div className="header-actions">
          <button onClick={() => setReceiving(true)}>Receive stock</button>
          <button className="primary" onClick={() => open("new")}>
            <Plus size={18} />
            Add item
          </button>
        </div>
      </header>
      <div className="tabs">
        <button
          className={tab === "items" ? "active" : ""}
          onClick={() => setTab("items")}
        >
          Items
        </button>
        <button
          className={tab === "received" ? "active" : ""}
          onClick={() => setTab("received")}
        >
          Stock in
        </button>
      </div>
      {tab === "items" ? (
        <>
          <div className="table-tools">
            <SearchBox value={search} onChange={setSearch} />
          </div>
          {visible.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>SKU</th>
                    <th>Available</th>
                    <th>Low at</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                      </td>
                      <td className="muted">{p.sku}</td>
                      <td>
                        <span
                          className={p.stock <= p.minimum ? "low-stock" : ""}
                        >
                          {p.stock.toLocaleString()}{" "}
                          <span className="muted">{p.unit}</span>
                        </span>
                      </td>
                      <td className="muted">{p.minimum}</td>
                      <td>
                        <div className="row-actions">
                          <button onClick={() => open("adjust", p)}>
                            Adjust
                          </button>
                          <details>
                            <summary aria-label={`Actions for ${p.name}`}>
                              <MoreHorizontal size={20} />
                            </summary>
                            <div className="menu">
                              <button onClick={() => open("edit", p)}>
                                Edit
                              </button>
                              <button onClick={() => open("history", p)}>
                                History
                              </button>
                              <button onClick={() => open("batches", p)}>
                                Batches & prices
                              </button>
                              <button
                                className="danger-text"
                                onClick={() => open("delete", p)}
                              >
                                Delete
                              </button>
                            </div>
                          </details>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="stock-empty">
              <Empty
                icon={<Package />}
                heading={
                  search ? "No matching items" : "Your stock starts here"
                }
              >
                {search ? "Try another search." : "Add your first item."}
              </Empty>
            </div>
          )}
        </>
      ) : purchases.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Supplier</th>
                <th>Date</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.number}</strong>
                  </td>
                  <td>{p.supplier}</td>
                  <td>{p.received}</td>
                  <td>
                    <span
                      className={
                        "status " +
                        (p.status === "received" ? "accepted" : "pending")
                      }
                    >
                      {p.status}
                    </span>
                  </td>
                  <td>
                    <button onClick={() => setReceiving(p)}>Open</button>
                    {p.status === "draft" && (
                      <button
                        className="danger-text"
                        onClick={async () => {
                          try {
                            await api(`/purchases/${p.id}`, {
                              method: "DELETE",
                            });
                            void loadPurchases();
                          } catch (e: any) {
                            setError(e.message);
                          }
                        }}
                      >
                        Delete draft
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="stock-empty">
          <Empty icon={<Package />} heading="No stock bills yet">
            Receive a delivery to add stock.
          </Empty>
        </div>
      )}
      <ErrorText message={!mode ? error : ""} />
      {receiving && (
        <StockReceipt
          products={products}
          initial={receiving === true ? undefined : receiving}
          onClose={() => setReceiving(null)}
          onSaved={() => {
            setReceiving(null);
            refresh();
            void loadPurchases();
            setTab("received");
          }}
        />
      )}
      {mode && (
        <Modal
          title={
            {
              new: "Add item",
              edit: "Edit item",
              adjust: "Adjust stock",
              history: "Stock history",
              delete: "Delete item",
              batches: "Batches & prices",
            }[mode]
          }
          onClose={() => {
            if (!busy) setMode(null);
          }}
        >
          {mode === "history" ? (
            <>
              <p>{selected?.name}</p>
              <ErrorText message={error} />
              {history.length ? (
                <div className="history-list">
                  {history.map((h) => (
                    <div key={h.id}>
                      <span>
                        <strong>{h.reason}</strong>
                        <small>{date(h.created)}</small>
                      </span>
                      <b className={h.delta > 0 ? "positive" : ""}>
                        {h.delta > 0 ? "+" : ""}
                        {h.delta}
                      </b>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No stock movements.</p>
              )}
            </>
          ) : mode === "batches" ? (
            <div className="batch-list">
              <p>{selected?.name}</p>
              {selected?.lots.length ? (
                selected.lots.map((lot) => (
                  <form
                    key={lot.id}
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setBusy(true);
                      setError("");
                      const fields = new FormData(e.currentTarget);
                      try {
                        await api(`/products/${selected.id}/lots/${lot.id}`, {
                          method: "PUT",
                          body: JSON.stringify({
                            costPrice:
                              fields.get("costPrice") === ""
                                ? null
                                : Number(fields.get("costPrice")),
                            mrp:
                              fields.get("mrp") === ""
                                ? null
                                : Number(fields.get("mrp")),
                          }),
                        });
                        refresh();
                        setMode(null);
                      } catch (e: any) {
                        setError(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <div className="section-title">
                      <strong>
                        {lot.remaining} {selected.unit}
                      </strong>
                      <span className="muted">{lot.received}</span>
                    </div>
                    <div className="two">
                      <label>
                        Cost / unit
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          name="costPrice"
                          defaultValue={lot.costPrice ?? ""}
                          disabled={
                            busy ||
                            lot.remaining !== lot.received_qty ||
                            !!lot.purchase_id
                          }
                        />
                      </label>
                      <label>
                        MRP
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          name="mrp"
                          defaultValue={lot.mrp ?? ""}
                          disabled={
                            busy ||
                            lot.remaining !== lot.received_qty ||
                            !!lot.purchase_id
                          }
                        />
                      </label>
                    </div>
                    {lot.remaining === lot.received_qty && !lot.purchase_id ? (
                      <button disabled={busy}>Save prices</button>
                    ) : (
                      <small className="muted">Recorded prices</small>
                    )}
                  </form>
                ))
              ) : (
                <p className="muted">No batches yet.</p>
              )}
              <ErrorText message={error} />
            </div>
          ) : (
            <form onSubmit={submit}>
              {(mode === "new" || mode === "edit") && (
                <div className="fields">
                  <label>
                    Name
                    <input
                      name="name"
                      autoFocus
                      required
                      maxLength={200}
                      defaultValue={selected?.name}
                    />
                  </label>
                  <div className="two">
                    <label>
                      SKU
                      <input
                        name="sku"
                        maxLength={80}
                        placeholder="Auto"
                        defaultValue={selected?.sku}
                      />
                    </label>
                    <label>
                      Unit
                      <input
                        name="unit"
                        required
                        maxLength={30}
                        defaultValue={selected?.unit || "PKT"}
                      />
                    </label>
                  </div>
                  <div className="two">
                    {mode === "new" && (
                      <label>
                        Opening stock
                        <input
                          name="stock"
                          type="number"
                          min="0"
                          step="0.001"
                          defaultValue="0"
                          required
                        />
                      </label>
                    )}
                    <label>
                      Low stock at
                      <input
                        name="minimum"
                        type="number"
                        min="0"
                        step="0.001"
                        defaultValue={selected?.minimum || 0}
                        required
                      />
                    </label>
                  </div>
                </div>
              )}
              {(mode === "new" || mode === "adjust") && (
                <div className="fields two price-fields">
                  <label>
                    MRP
                    <input
                      name="mrp"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Optional"
                    />
                  </label>
                  <label>
                    Cost / unit
                    <input
                      name="costPrice"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Optional"
                    />
                  </label>
                </div>
              )}
              {mode === "adjust" && (
                <div className="fields">
                  <p>
                    {selected?.name}{" "}
                    <span className="muted">
                      · {selected?.stock} {selected?.unit} available
                    </span>
                  </p>
                  <label>
                    Quantity
                    <input
                      name="quantity"
                      type="number"
                      step="0.001"
                      autoFocus
                      required
                      placeholder="e.g. 24 or -6"
                    />
                  </label>
                  <label>
                    Reason
                    <input
                      name="reason"
                      required
                      maxLength={300}
                      placeholder="Stock received"
                    />
                  </label>
                </div>
              )}
              {mode === "delete" && (
                <p>
                  Delete {selected?.name}? Its movement history will be kept.
                </p>
              )}
              <ErrorText message={error} />
              <div className="modal-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setMode(null)}
                >
                  Cancel
                </button>
                <button
                  className={mode === "delete" ? "danger" : "primary"}
                  disabled={busy}
                >
                  {busy ? "Saving…" : mode === "delete" ? "Delete" : "Save"}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
