import { useEffect, useRef, useState } from "react";
import {
  Upload,
  File,
  FileText,
  Plus,
  Trash2,
  Check,
  ArrowLeft,
  Download,
  Box,
} from "lucide-react";
import { api, date, type Bill, type Product, type Purchase } from "../api";
import { Empty, SearchBox, ErrorText, Modal } from "../components/UI";
import StockReceipt from "../components/StockReceipt";
export default function Bills({
  products,
  refreshStock,
}: {
  products: Product[];
  refreshStock: () => void;
}) {
  const [bills, setBills] = useState<Bill[]>([]),
    [selected, setSelected] = useState(""),
    [filter, setFilter] = useState("pending"),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const refresh = () =>
    api<Bill[]>("/bills")
      .then(setBills)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);
  const visible = bills.filter(
    (b) =>
      b.status === filter &&
      `${b.number} ${b.shop} ${b.filename}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  async function upload(f: File) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("file", f);
      const result = await api("/upload", { method: "POST", body: form });
      await refresh();
      setSelected(result.id);
      const all = await api<Bill[]>("/bills");
      setFilter(all.find((b) => b.id === result.id)?.status || "pending");
      setNotice(
        result.duplicate
          ? "Already received. Opened the existing bill."
          : "File received.",
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Bills</h1>
          <p>Review incoming bills.</p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          <Upload size={18} />
          {busy ? "Importing…" : "Import file"}
        </button>
        <input
          ref={file}
          type="file"
          hidden
          onChange={(e) => {
            if (e.target.files?.[0]) void upload(e.target.files[0]);
            e.target.value = "";
          }}
        />
      </header>
      <ErrorText message={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="tabs">
        {["pending", "accepted", "rejected"].map((s) => (
          <button
            key={s}
            className={s === filter ? "active" : ""}
            onClick={() => {
              setFilter(s);
              setSelected("");
            }}
          >
            {s[0].toUpperCase() + s.slice(1)}
            {s === "pending" && (
              <span className="count">
                {bills.filter((b) => b.status === s).length}
              </span>
            )}
          </button>
        ))}
      </div>
      <section className={"inbox " + (selected ? "has-selection" : "")}>
        <aside className="bill-list">
          <SearchBox value={search} onChange={setSearch} />
          {visible.length ? (
            visible.map((b) => (
              <button
                key={b.id}
                className={"bill-row " + (selected === b.id ? "selected" : "")}
                onClick={() => setSelected(b.id)}
              >
                <div>
                  <strong>{b.shop || b.filename}</strong>
                  <span>{b.number ? `#${b.number}` : "Needs review"}</span>
                </div>
                <small>
                  {b.receipt?.date || date(b.received)}
                  {b.receipt?.total !== null && b.receipt?.total !== undefined
                    ? ` · Rs ${b.receipt.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                    : ""}
                </small>
              </button>
            ))
          ) : (
            <Empty
              icon={<File />}
              heading={search ? "No matching bills" : "No bills yet"}
            >
              {filter === "pending" && !search
                ? "Print a bill to get started."
                : "Bills will appear here."}
            </Empty>
          )}
        </aside>
        <div className="bill-detail">
          {selected ? (
            <BillReview
              key={selected}
              id={selected}
              products={products}
              onClose={() => setSelected("")}
              onUpdate={() => {
                void refresh();
                refreshStock();
              }}
            />
          ) : (
            <Empty icon={<FileText />} heading="Select a bill">
              Review items before accepting.
            </Empty>
          )}
        </div>
      </section>
      <footer className="page-footer">
        <Box size={18} />
        Stock changes only after acceptance.
      </footer>
    </>
  );
}
function BillReview({
  id,
  products,
  onClose,
  onUpdate,
}: {
  id: string;
  products: Product[];
  onClose: () => void;
  onUpdate: () => void;
}) {
  const [bill, setBill] = useState<Bill | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [source, setSource] = useState(true),
    [saved, setSaved] = useState("");
  const [issues, setIssues] = useState<any[] | null>(null),
    [restock, setRestock] = useState<Purchase | null>(null);
  useEffect(() => {
    api<Bill>("/bills/" + id)
      .then((received) => {
        setBill(received);
        setSource(!received.receipt || received.receipt.warnings.length > 0);
      })
      .catch((e) => setError(e.message));
  }, [id]);
  async function act(action: "save" | "accept" | "reject") {
    if (!bill) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      if (action !== "reject")
        await api("/bills/" + id, {
          method: "PUT",
          body: JSON.stringify(bill),
        });
      if (action === "accept") {
        const check = await api<{ issues: any[] }>(`/bills/${id}/availability`);
        if (check.issues.length) {
          setIssues(check.issues);
          return;
        }
      }
      if (action !== "save")
        await api(`/bills/${id}/${action}`, { method: "POST" });
      setBill(await api("/bills/" + id));
      setSaved(
        action === "save"
          ? "Saved."
          : action === "accept"
            ? "Accepted. Stock updated."
            : "Rejected.",
      );
      onUpdate();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!bill)
    return (
      <div className="detail-body">
        <ErrorText message={error} />
        {!error && "Loading…"}
      </div>
    );
  const editable = bill.status === "pending";
  return (
    <>
      <header className="detail-header">
        <button
          className="icon-button"
          aria-label="Back to bills"
          onClick={onClose}
        >
          <ArrowLeft size={19} />
        </button>
        <div>
          <strong>
            {bill.number ? `Bill #${bill.number}` : "Review bill"}
          </strong>
          <small>
            {date(bill.received)} · {bill.source}
          </small>
        </div>
        <span className={"status " + bill.status}>{bill.status}</span>
      </header>
      <div className="detail-body">
        {bill.receipt && (
          <>
            <div className="receipt-summary">
              <div>
                <small>
                  {bill.receipt.date}
                  {bill.receipt.outletId &&
                    ` · Outlet ${bill.receipt.outletId}`}
                </small>
                <span>{bill.receipt.items.length} items</span>
              </div>
              {bill.receipt.total !== null && (
                <strong>
                  Rs{" "}
                  {bill.receipt.total.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                  })}
                </strong>
              )}
            </div>
            {bill.receipt.customerAddress && (
              <p className="receipt-address">{bill.receipt.customerAddress}</p>
            )}
            {bill.receipt.warnings.map((warning) => (
              <p className="receipt-warning" key={warning}>
                {warning}
              </p>
            ))}
          </>
        )}
        <div className="source-title">
          <button className="text-button" onClick={() => setSource(!source)}>
            {source ? "Hide source" : "Show source"}
          </button>
          <a href={`/api/bills/${id}/raw`} target="_blank" rel="noreferrer">
            <Download size={15} />
            Original
          </a>
        </div>
        {source &&
          (bill.mime === "application/pdf" ? (
            <iframe
              title="Original bill"
              className="source-pdf"
              src={`/api/bills/${id}/raw`}
            />
          ) : (
            <pre className="source-text">
              {bill.preview ||
                "Binary print data saved. Open the original to inspect it."}
            </pre>
          ))}
        <div className="fields two">
          <label>
            Bill number
            <input
              disabled={!editable || busy}
              value={bill.number}
              onChange={(e) => setBill({ ...bill, number: e.target.value })}
            />
          </label>
          <label>
            Shop
            <input
              disabled={!editable || busy}
              value={bill.shop}
              onChange={(e) => setBill({ ...bill, shop: e.target.value })}
            />
          </label>
        </div>
        <div className="section-title">
          <h3>Items</h3>
          {editable && (
            <button
              className="text-button"
              disabled={busy || !products.length}
              onClick={() =>
                setBill({
                  ...bill,
                  items: [
                    ...bill.items,
                    { productId: products[0]?.id || "", quantity: 1 },
                  ],
                })
              }
            >
              <Plus size={16} />
              Add item
            </button>
          )}
        </div>
        {!products.length && editable && (
          <p className="muted">Receive missing stock when accepting.</p>
        )}
        {bill.items.map((item, i) => {
          const original =
            item.sourceLine === undefined
              ? undefined
              : bill.receipt?.items[item.sourceLine];
          return (
            <div className="receipt-item" key={i}>
              {original && (
                <div className="receipt-item-title">
                  <div>
                    <strong>{original.name}</strong>
                    <small>
                      {original.unit} · Rs {original.rate.toFixed(2)}
                      {original.mrp !== undefined &&
                        ` · MRP ${original.mrp.toFixed(2)}`}
                    </small>
                  </div>
                  <span>
                    Rs{" "}
                    {original.amount.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                    })}
                  </span>
                </div>
              )}
              <div className="line-item">
                <select
                  aria-label={`Item ${i + 1}`}
                  disabled={!editable || busy}
                  value={item.productId}
                  onChange={(e) =>
                    setBill({
                      ...bill,
                      items: bill.items.map((v, j) =>
                        i === j ? { ...v, productId: e.target.value } : v,
                      ),
                    })
                  }
                >
                  <option value="">Choose stock item</option>
                  {item.productId &&
                    !products.some((p) => p.id === item.productId) && (
                      <option value={item.productId}>Archived item</option>
                    )}
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.sku} ({p.stock} {p.unit})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  aria-label={`Quantity ${i + 1}`}
                  min="0.001"
                  step="0.001"
                  disabled={!editable || busy}
                  value={item.quantity}
                  onChange={(e) =>
                    setBill({
                      ...bill,
                      items: bill.items.map((v, j) =>
                        i === j
                          ? { ...v, quantity: Number(e.target.value) }
                          : v,
                      ),
                    })
                  }
                />
                {(!original || original.mrp === undefined) && (
                  <input
                    aria-label={`MRP ${i + 1}`}
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="MRP"
                    disabled={!editable || busy}
                    value={item.mrp ?? ""}
                    onChange={(e) =>
                      setBill({
                        ...bill,
                        items: bill.items.map((v, j) =>
                          i === j
                            ? {
                                ...v,
                                mrp:
                                  e.target.value === ""
                                    ? null
                                    : Number(e.target.value),
                              }
                            : v,
                        ),
                      })
                    }
                  />
                )}
                {editable && (
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`Remove item ${i + 1}`}
                    onClick={() =>
                      setBill({
                        ...bill,
                        items: bill.items.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <label className="note-label">
          Note
          <textarea
            disabled={!editable || busy}
            value={bill.note}
            rows={2}
            onChange={(e) => setBill({ ...bill, note: e.target.value })}
          />
        </label>
        <ErrorText message={error} />
        {saved && (
          <p className="notice" role="status">
            {saved}
          </p>
        )}
        {editable && (
          <div className="review-actions">
            <button
              className="danger-text"
              disabled={busy}
              onClick={() => void act("reject")}
            >
              Reject
            </button>
            <div>
              <button disabled={busy} onClick={() => void act("save")}>
                Save
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  !bill.items.length ||
                  bill.items.some((item) => item.quantity <= 0) ||
                  !bill.number.trim() ||
                  !bill.shop.trim()
                }
                onClick={() => void act("accept")}
              >
                <Check size={17} />
                Accept bill
              </button>
            </div>
          </div>
        )}
      </div>
      {issues && !restock && (
        <Modal title="Stock needed" onClose={() => setIssues(null)}>
          <div className="stock-issues">
            {issues.map((issue) => (
              <div key={issue.line}>
                <strong>{issue.name}</strong>
                <p>
                  {issue.message ||
                    `${issue.available} available · ${issue.shortage} needed${issue.mrp !== null ? ` at MRP ${issue.mrp}` : ""}`}
                </p>
              </div>
            ))}
          </div>
          <ErrorText message={error} />
          <div className="modal-actions">
            <button onClick={() => setIssues(null)}>Review items</button>
            <button
              className="primary"
              disabled={issues.some(
                (i) => i.kind === "unit" || i.kind === "price",
              )}
              onClick={() =>
                setRestock({
                  number: "",
                  supplier: "",
                  received: new Date().toLocaleDateString("en-CA"),
                  note: "",
                  lines: issues.map((issue) => ({
                    productId: issue.productId || "",
                    ...(!issue.productId
                      ? {
                          newProduct: {
                            sku: "",
                            name: issue.name,
                            unit: issue.unit || "PKT",
                          },
                        }
                      : {}),
                    quantity: issue.shortage,
                    mrp: issue.mrp ?? null,
                    costPrice: null,
                    billLine: issue.line,
                  })),
                })
              }
            >
              Receive stock
            </button>
          </div>
        </Modal>
      )}
      {restock && (
        <StockReceipt
          products={products}
          initial={restock}
          onClose={() => setRestock(null)}
          onSaved={async (purchase, received) => {
            setRestock(null);
            setIssues(null);
            try {
              if (received) {
                const updated = {
                  ...bill,
                  items: bill.items.map((item, index) => {
                    const line = purchase.lines.find(
                      (l) => l.billLine === index,
                    );
                    return line ? { ...item, productId: line.productId } : item;
                  }),
                };
                await api(`/bills/${id}`, {
                  method: "PUT",
                  body: JSON.stringify(updated),
                });
                setBill(await api<Bill>(`/bills/${id}`));
                setSaved("Stock received. Ready to accept.");
                onUpdate();
              } else setSaved("Stock bill saved as a draft.");
            } catch (e: any) {
              setError(e.message);
              onUpdate();
            }
          }}
        />
      )}
    </>
  );
}
