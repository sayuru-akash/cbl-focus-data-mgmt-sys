"use client";
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
import ProductPicker from "../components/ProductPicker";
import { api, date, type Bill, type Product } from "../api";
import { Empty, SearchBox, ErrorText, Modal } from "../components/UI";
import InvoiceIntake from "../components/InvoiceIntake";

export default function BillReview({
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
    [restock, setRestock] = useState(false);
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
              disabled={busy}
              onClick={() =>
                setBill({
                  ...bill,
                  items: [...bill.items, { productId: "", quantity: 1 }],
                })
              }
            >
              <Plus size={16} />
              Add item
            </button>
          )}
        </div>
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
                <ProductPicker
                  label={`Item ${i + 1}`}
                  disabled={!editable || busy}
                  value={item.productId}
                  onChange={(productId) =>
                    setBill({
                      ...bill,
                      items: bill.items.map((v, j) =>
                        i === j ? { ...v, productId } : v,
                      ),
                    })
                  }
                />
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
              onClick={() => setRestock(true)}
            >
              Receive invoice
            </button>
          </div>
        </Modal>
      )}
      {restock && (
        <InvoiceIntake
          products={products}
          onClose={() => setRestock(false)}
          onSaved={() => {
            onUpdate();
            setSaved(
              "Invoice draft updated. Review stock mappings before accepting.",
            );
          }}
        />
      )}
    </>
  );
}
