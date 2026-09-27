"use client";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
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
import {
  categoryDiscounts,
  categoryDifference,
  discountCategories,
} from "../../server/discount-categories";
import { useStock } from "../features/Providers";
import PaymentBadge from "../components/PaymentBadge";
import {
  paymentTypes,
  paymentLabels,
  type PaymentType,
} from "../../server/payment";
import ProductPicker from "../components/ProductPicker";
import { api, date, type Bill, type Product } from "../api";
import { Empty, SearchBox, ErrorText, Modal } from "../components/UI";
import InvoiceIntake from "../components/InvoiceIntake";
import BillLineEditor, { editLine } from "../components/BillLineEditor";
import {
  billReviewErrors,
  lineKindLabel,
  recalculateReceipt,
  type Receipt,
  type ReceiptLine,
} from "../../server/receipt";
const money = (n: number) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export type BillNavigationGuard = ((next: () => void) => void) | null;
const unsavedBills = new Map<string, Bill>();
const editableValue = (b: Bill) =>
  JSON.stringify([
    b.number,
    b.shop,
    b.items,
    b.note,
    b.receipt,
    b.payment_type,
  ]);

export default function BillReview({
  id,
  products,
  onClose,
  onUpdate,
  navigationGuard,
  panel = false,
  backLabel = "Back to bills",
}: {
  id: string;
  products: Product[];
  onClose: () => void;
  onUpdate: () => void;
  navigationGuard?: MutableRefObject<BillNavigationGuard>;
  panel?: boolean;
  backLabel?: string;
}) {
  const router = useRouter();
  const { notify } = useStock();
  const baseline = useRef("");
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [remote, setRemote] = useState<Bill | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteStep, setDeleteStep] = useState(0);
  const [deleteText, setDeleteText] = useState("");

  const [bill, setBill] = useState<Bill | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [source, setSource] = useState(true),
    [saved, setSaved] = useState("");
  const [issues, setIssues] = useState<any[] | null>(null),
    [restock, setRestock] = useState(false);
  const current = useRef<Bill | null>(null);
  current.current = bill;
  const dirty =
    !!bill &&
    bill.status === "pending" &&
    editableValue(bill) !== baseline.current;
  function apply(received: Bill) {
    current.current = received;
    baseline.current = editableValue(received);
    unsavedBills.delete(id);
    setBill(received);
    setRemote(null);
  }
  function navigate(next: () => void) {
    if (busy) return;
    if (dirty) setLeaveAction(() => next);
    else next();
  }
  useEffect(() => {
    if (navigationGuard) navigationGuard.current = navigate;
    return () => {
      if (navigationGuard) navigationGuard.current = null;
    };
  }, [dirty, busy, navigationGuard]);
  useEffect(() => {
    if (dirty && bill) unsavedBills.set(id, bill);
    else if (bill) unsavedBills.delete(id);
  }, [dirty, bill, id]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const links = (e: MouseEvent) => {
      const link = (e.target as Element).closest?.("a[href]");
      if (
        !(link instanceof HTMLAnchorElement) ||
        e.button !== 0 ||
        link.origin !== window.location.origin ||
        link.target === "_blank" ||
        link.hasAttribute("download") ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      navigate(() => router.push(link.pathname + link.search));
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", links, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", links, true);
    };
  }, [dirty, busy]);
  useEffect(() => {
    let cancelled = false;
    setBill(null);
    setError("");
    setRemote(null);
    api<Bill>("/bills/" + id)
      .then((received) => {
        if (cancelled) return;
        baseline.current = editableValue(received);
        const retained = unsavedBills.get(id);
        setBill(retained || received);
        if (retained && retained.revision !== received.revision)
          setRemote(received);
        setSource(!received.receipt || received.receipt.warnings.length > 0);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    const timer = setInterval(async () => {
      if (!current.current) return;
      try {
        const latest = await api<Bill>("/bills/" + id);
        if (!cancelled && latest.revision !== current.current?.revision)
          setRemote(latest);
      } catch {
        /* Keep edits visible during a network interruption. */
      }
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, reloadKey]);
  function editReceipt(change: (r: Receipt) => Receipt) {
    setBill((b) => {
      if (!b?.receipt) return b;
      const receipt = {
        ...recalculateReceipt(change(b.receipt)),
        edited: true,
      };
      return {
        ...b,
        receipt,
        items: b.items.map((i) => {
          const line = receipt.items[i.sourceLine!];
          const previous = b.receipt!.items[i.sourceLine!];
          return line
            ? {
                ...i,
                ...(i.automaticMatch &&
                (line.mrp !== previous?.mrp ||
                  line.name !== previous?.name ||
                  line.unit !== previous?.unit)
                  ? { productId: "" }
                  : {}),
                quantity: line.quantity,
                mrp: line.mrp ?? null,
                sellingPrice: line.rate,
                createReturnProduct:
                  line.kind === "fresh_return" ? i.createReturnProduct : false,
              }
            : i;
        }),
      };
    });
  }
  function editReceiptLine(index: number, line: ReceiptLine) {
    editReceipt((r) => ({
      ...r,
      items: r.items.map((v, j) => (j === index ? line : v)),
    }));
  }
  function addLine() {
    if (!bill) return;
    if (!bill.receipt) {
      setBill({
        ...bill,
        items: [...bill.items, { productId: "", quantity: 1 }],
      });
      return;
    }
    const sourceLine = bill.receipt.items.length;
    setBill({
      ...bill,
      receipt: recalculateReceipt({
        ...bill.receipt,
        edited: true,
        items: [
          ...bill.receipt.items,
          {
            name: "New item",
            unit: "PKT",
            quantity: 1,
            rate: 0,
            amount: 0,
            kind: "sale",
            section: "Sale",
          },
        ],
      }),
      items: [
        ...bill.items,
        { productId: "", quantity: 1, sourceLine, mrp: null, sellingPrice: 0 },
      ],
    });
  }
  function removeLine(index: number) {
    if (!bill) return;
    const sourceLine = bill.items[index].sourceLine;
    if (sourceLine === undefined || !bill.receipt) {
      setBill({ ...bill, items: bill.items.filter((_, i) => i !== index) });
      return;
    }
    setBill({
      ...bill,
      receipt: recalculateReceipt({
        ...bill.receipt,
        edited: true,
        items: bill.receipt.items.filter((_, i) => i !== sourceLine),
      }),
      items: bill.items
        .filter((_, i) => i !== index)
        .map((i) => ({
          ...i,
          sourceLine:
            i.sourceLine! > sourceLine ? i.sourceLine! - 1 : i.sourceLine,
        })),
    });
  }
  async function changePayment(payment: PaymentType) {
    if (!bill || busy) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const update = await api<{ revision: number; payment_type: PaymentType }>(
        `/bills/${id}/payment`,
        {
          method: "PATCH",
          body: JSON.stringify({
            payment_type: payment,
            revision: bill.revision,
          }),
        },
      );
      apply({ ...bill, ...update });
      setSaved("Payment type updated.");
      onUpdate();
    } catch (e: any) {
      setError(e.message);
      const latest = await api<Bill>(`/bills/${id}`).catch(() => null);
      if (latest) apply(latest);
    } finally {
      setBusy(false);
    }
  }
  async function act(action: "save" | "accept" | "reject") {
    if (!bill) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      let revision = bill.revision;
      if (action !== "reject") {
        const saved = await api<{ revision: number }>("/bills/" + id, {
          method: "PUT",
          body: JSON.stringify(bill),
        });
        revision = saved.revision;
        apply({ ...bill, revision });
      }
      if (action === "accept") {
        const check = await api<{ issues: any[] }>(`/bills/${id}/availability`);
        if (check.issues.length) {
          setIssues(check.issues);
          return;
        }
      }
      if (action !== "save") {
        await api(`/bills/${id}/${action}`, {
          method: "POST",
          body: JSON.stringify({ revision }),
        });
        // The mutation is committed. Do not let a follow-up read failure hide success.
        apply({
          ...bill,
          revision,
          status: action === "accept" ? "accepted" : "rejected",
        });
        onUpdate();
        notify(
          action === "accept"
            ? `Bill #${bill.number} accepted. Stock updated.`
            : `Bill #${bill.number} rejected.`,
        );
        onClose();
      } else {
        apply(await api("/bills/" + id));
        setSaved("Saved.");
        onUpdate();
      }
      return true;
    } catch (e: any) {
      setError(e.message);
      try {
        const latest = await api<Bill>("/bills/" + id);
        if (latest.revision !== bill.revision) setRemote(latest);
      } catch {}
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!bill)
    return (
      <div className="detail-body">
        <ErrorText message={error} />
        {!error && "Loading…"}
        {error && (
          <button onClick={() => setReloadKey((k) => k + 1)}>Try again</button>
        )}
      </div>
    );
  const editable = bill.status === "pending";
  const canDelete =
    bill.status !== "accepted" ||
    (bill.decided && Date.now() <= Date.parse(bill.decided) + 10 * 86400000);
  async function removeBill() {
    if (!bill || deleteText !== (bill.number || "DELETE")) return;
    setBusy(true);
    setError("");
    try {
      await api(`/bills/${id}`, {
        method: "DELETE",
        body: JSON.stringify({
          revision: bill.revision,
          confirmation: "DELETE",
        }),
      });
      unsavedBills.delete(id);
      baseline.current = editableValue(bill);
      setDeleteStep(0);
      notify(
        bill.status === "accepted"
          ? "Bill deleted. Stock restored."
          : "Bill deleted.",
      );
      onUpdate();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const reviewErrors = editable
    ? billReviewErrors(bill)
    : bill.receipt?.warnings || [];
  const accounting = bill.receipt?.accounting;
  const editSummary = (
    field: "discount" | "skuDiscount" | "returnReversal",
    value: number,
  ) =>
    editReceipt((r) => ({
      ...r,
      accounting: { ...r.accounting, [field]: value },
    }));
  async function restorePrint() {
    const bill = current.current;
    if (!bill) return;
    setBusy(true);
    setError("");
    try {
      await api(`/bills/${id}/restore`, {
        method: "POST",
        body: JSON.stringify({ revision: bill.revision }),
      });
      apply(await api(`/bills/${id}`));
      onUpdate();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="detail-header">
        {!panel && (
          <button
            className="icon-button"
            aria-label={backLabel}
            onClick={() => navigate(onClose)}
          >
            <ArrowLeft size={19} />
          </button>
        )}
        <div>
          <strong>
            {bill.number ? `Bill #${bill.number}` : "Review bill"}
          </strong>
          <small>
            {date(bill.received)} · {bill.source}
          </small>
        </div>
        <span className={"status " + bill.status}>{bill.status}</span>
        <PaymentBadge value={bill.payment_type} />
        <button
          className="icon-button danger-text"
          aria-label="Delete bill"
          title={
            canDelete
              ? "Delete bill"
              : "Deletion closed: more than 10 days since approval"
          }
          disabled={busy || !canDelete}
          onClick={() => {
            setError("");
            setDeleteText("");
            setDeleteStep(1);
          }}
        >
          <Trash2 size={18} />
        </button>
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
                !bill.payment_type ||
                reviewErrors.length > 0 ||
                !bill.items.length ||
                bill.items.some(
                  (item) =>
                    item.quantity <= 0 || !Number.isInteger(item.quantity),
                ) ||
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
        {(editable || bill.status === "accepted") && (
          <label className="bill-payment-field">
            Payment type
            <select
              required
              value={bill.payment_type || ""}
              disabled={busy}
              onChange={(e) =>
                editable
                  ? setBill({
                      ...bill,
                      payment_type: (e.target.value ||
                        null) as PaymentType | null,
                    })
                  : void changePayment(e.target.value as PaymentType)
              }
            >
              <option value="" disabled={!editable}>
                Select type
              </option>
              {paymentTypes.map((type) => (
                <option key={type} value={type}>
                  {paymentLabels[type]}
                </option>
              ))}
            </select>
            {editable && !bill.payment_type && (
              <small className="muted">Required to accept</small>
            )}
          </label>
        )}

        {!editable && <ErrorText message={error} />}
        {!editable && saved && (
          <p className="notice" role="status">
            {saved}
          </p>
        )}
        {remote && (
          <div className="notice" role="status">
            This bill changed in another window.{" "}
            <button
              className="text-button"
              onClick={() => navigate(() => apply(remote))}
            >
              Reload bill
            </button>
          </div>
        )}
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
            {reviewErrors.map((warning) => (
              <p className="receipt-warning" key={warning}>
                {warning}
              </p>
            ))}
          </>
        )}
        {bill.receipt && accounting && (
          <details className="bill-customer-editor">
            <summary>Discount categories</summary>
            <div className="fields three">
              {discountCategories.map(({ key, label }) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    disabled={!editable || busy}
                    value={categoryDiscounts(bill.receipt)[key]}
                    onChange={(e) =>
                      editReceipt((r) => ({
                        ...r,
                        categoryDiscounts: {
                          ...categoryDiscounts(r),
                          [key]: Number(e.target.value),
                        },
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            {categoryDifference(bill.receipt) !== 0 && (
              <p className="receipt-warning">
                Category difference: Rs{" "}
                {money(categoryDifference(bill.receipt))}. Match bill + SKU
                discounts.
              </p>
            )}
          </details>
        )}
        {accounting && (
          <dl className="bill-accounting" aria-label="Bill totals">
            <div>
              <dt>Gross</dt>
              <dd>Rs {money(accounting.gross)}</dd>
            </div>
            {(editable || accounting.discount !== 0) && (
              <div>
                <dt>Discount</dt>
                <dd>
                  {editable ? (
                    <input
                      aria-label="Bill discount"
                      type="number"
                      min="0"
                      step="0.01"
                      disabled={busy}
                      value={accounting.discount}
                      onChange={(e) =>
                        editSummary("discount", Number(e.target.value))
                      }
                    />
                  ) : (
                    `- ${money(accounting.discount)}`
                  )}
                </dd>
              </div>
            )}
            {(editable || accounting.skuDiscount !== 0) && (
              <div>
                <dt>SKU discount</dt>
                <dd>
                  {editable ? (
                    <input
                      aria-label="SKU discount"
                      type="number"
                      min="0"
                      step="0.01"
                      disabled={busy}
                      value={accounting.skuDiscount}
                      onChange={(e) =>
                        editSummary("skuDiscount", Number(e.target.value))
                      }
                    />
                  ) : (
                    `- ${money(accounting.skuDiscount)}`
                  )}
                </dd>
              </div>
            )}
            {(accounting.returnGross !== 0 || accounting.returns !== 0) && (
              <div>
                <dt>
                  <details className="return-breakdown">
                    <summary>Return credit</summary>
                    <p>Item value: {money(accounting.returnGross)}</p>
                    <p>
                      Reverse GRTS:{" "}
                      {editable ? (
                        <input
                          aria-label="Reverse GRTS"
                          type="number"
                          min="0"
                          step="0.01"
                          disabled={busy}
                          value={accounting.returnReversal}
                          onChange={(e) =>
                            editSummary(
                              "returnReversal",
                              Number(e.target.value),
                            )
                          }
                        />
                      ) : (
                        `- ${money(accounting.returnReversal)}`
                      )}
                    </p>
                  </details>
                </dt>
                <dd>- {money(accounting.returns)}</dd>
              </div>
            )}
            <div className="bill-net">
              <dt>Net payable</dt>
              <dd>Rs {money(accounting.calculatedNet)}</dd>
            </div>
            {accounting.difference !== 0 && (
              <div className="error">
                <dt>Difference from print</dt>
                <dd>
                  {accounting.difference === null
                    ? "Missing total"
                    : money(accounting.difference)}
                </dd>
              </div>
            )}
          </dl>
        )}
        {bill.receipt?.edited && bill.originalReceipt?.total != null && (
          <p className="receipt-address">
            Original total: Rs {money(bill.originalReceipt.total)}
          </p>
        )}
        {editable && !!bill.receipt?.warnings.length && (
          <label className="bill-review-check">
            <input
              type="checkbox"
              disabled={busy}
              checked={bill.receipt.reviewed || false}
              onChange={(e) =>
                setBill({
                  ...bill,
                  receipt: { ...bill.receipt!, reviewed: e.target.checked },
                })
              }
            />
            I checked the bill against the original.
          </label>
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
              onChange={(e) =>
                setBill({
                  ...bill,
                  number: e.target.value,
                  receipt: bill.receipt
                    ? { ...bill.receipt, number: e.target.value, edited: true }
                    : null,
                })
              }
            />
          </label>
          <label>
            Shop
            <input
              disabled={!editable || busy}
              value={bill.shop}
              onChange={(e) =>
                setBill({
                  ...bill,
                  shop: e.target.value,
                  receipt: bill.receipt
                    ? { ...bill.receipt, shop: e.target.value, edited: true }
                    : null,
                })
              }
            />
          </label>
        </div>
        {bill.receipt && (
          <details className="bill-customer-editor">
            <summary>Bill &amp; customer details</summary>
            <div className="fields two">
              <label>
                Date
                <input
                  type="date"
                  disabled={!editable || busy}
                  value={bill.receipt.date}
                  onChange={(e) =>
                    editReceipt((r) => ({ ...r, date: e.target.value }))
                  }
                />
              </label>
              <label>
                Outlet ID
                <input
                  disabled={!editable || busy}
                  value={bill.receipt.outletId}
                  onChange={(e) =>
                    editReceipt((r) => ({ ...r, outletId: e.target.value }))
                  }
                />
              </label>
              <label>
                Address
                <input
                  disabled={!editable || busy}
                  value={bill.receipt.customerAddress}
                  onChange={(e) =>
                    editReceipt((r) => ({
                      ...r,
                      customerAddress: e.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Phone
                <input
                  disabled={!editable || busy}
                  value={bill.receipt.customerPhone}
                  onChange={(e) =>
                    editReceipt((r) => ({
                      ...r,
                      customerPhone: e.target.value,
                    }))
                  }
                />
              </label>
            </div>
          </details>
        )}
        <div className="section-title">
          <h3>Items</h3>
          {editable && bill.receipt && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => navigate(() => void restorePrint())}
            >
              Restore printed items
            </button>
          )}
          {editable && (
            <button className="text-button" disabled={busy} onClick={addLine}>
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
          const kind = original?.kind || "sale";
          const market = kind === "market_return";
          return (
            <div className={"receipt-item receipt-kind-" + kind} key={i}>
              <div className="bill-line-effect">
                <span>
                  {lineKindLabel[kind]}
                  {market && original?.section === "EXPIRY" ? " · Expired" : ""}
                </span>
                <small>
                  {kind === "fresh_return"
                    ? "+ Returns to stock"
                    : market
                      ? "No sellable stock added"
                      : "Deducts stock"}
                </small>
              </div>
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
                {!item.createReturnProduct && (
                  <ProductPicker
                    label={`Item ${i + 1}`}
                    emptyLabel={
                      market
                        ? "Link stock item (optional)"
                        : "Choose stock item"
                    }
                    showStock={kind === "sale" || kind === "free"}
                    suggestedName={original?.name}
                    unit={original?.unit}
                    mrp={original?.mrp ?? item.mrp}
                    disabled={!editable || busy}
                    value={item.productId}
                    onChange={(productId) =>
                      setBill({
                        ...bill,
                        items: bill.items.map((v, j) =>
                          i === j
                            ? {
                                ...v,
                                productId,
                                automaticMatch: false,
                                createReturnProduct: false,
                              }
                            : v,
                        ),
                      })
                    }
                  />
                )}
                {item.createReturnProduct && (
                  <div className="new-return-item">
                    <strong>{original?.name}</strong>
                    <small>
                      New item on acceptance · MRP {original?.mrp?.toFixed(2)}
                    </small>
                  </div>
                )}
                {
                  <input
                    type="number"
                    aria-label={`Quantity ${i + 1}`}
                    min="1"
                    step="1"
                    disabled={!editable || busy}
                    value={item.quantity}
                    onChange={(e) =>
                      original
                        ? editReceiptLine(
                            item.sourceLine!,
                            editLine(original, {
                              quantity: Number(e.target.value),
                            }),
                          )
                        : setBill({
                            ...bill,
                            items: bill.items.map((v, j) =>
                              i === j
                                ? { ...v, quantity: Number(e.target.value) }
                                : v,
                            ),
                          })
                    }
                  />
                }
                {!original && (
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
                    onClick={() => removeLine(i)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              {editable && original && (
                <BillLineEditor
                  line={original}
                  disabled={busy}
                  onChange={(line) => editReceiptLine(item.sourceLine!, line)}
                />
              )}
              {editable && kind === "fresh_return" && !item.productId && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    setBill({
                      ...bill,
                      items: bill.items.map((v, j) =>
                        j === i
                          ? {
                              ...v,
                              createReturnProduct: !v.createReturnProduct,
                            }
                          : v,
                      ),
                    })
                  }
                >
                  {item.createReturnProduct
                    ? "Choose existing item"
                    : "Receive as new item"}
                </button>
              )}
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
        {editable && <ErrorText message={error} />}
        {editable && saved && (
          <p className="notice" role="status">
            {saved}
          </p>
        )}
      </div>
      {deleteStep > 0 && (
        <Modal
          title={deleteStep === 1 ? "Delete bill?" : "Confirm deletion"}
          onClose={() => {
            if (!busy) setDeleteStep(0);
          }}
        >
          <p>
            <strong>Bill #{bill.number || "Untitled"}</strong> · {bill.shop}
          </p>
          {deleteStep === 1 ? (
            <>
              <p className="delete-description">
                {bill.status === "accepted"
                  ? "Sales and free items return to their original stock batches. Fresh returns are removed. Market returns do not change stock."
                  : "This bill and its original print will be removed. Stock will not change."}
              </p>
              <div className="modal-actions">
                <button onClick={() => setDeleteStep(0)}>Cancel</button>
                <button
                  className="danger-text"
                  onClick={() => setDeleteStep(2)}
                >
                  Continue
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="delete-description">
                This cannot be undone. Type{" "}
                <strong>{bill.number || "DELETE"}</strong> to confirm.
              </p>
              <label>
                Bill number
                <input
                  autoFocus
                  value={deleteText}
                  disabled={busy}
                  onChange={(e) => setDeleteText(e.target.value)}
                />
              </label>
              <ErrorText message={error} />
              <div className="modal-actions">
                <button disabled={busy} onClick={() => setDeleteStep(0)}>
                  Cancel
                </button>
                <button
                  className="danger-text"
                  disabled={busy || deleteText !== (bill.number || "DELETE")}
                  onClick={() => void removeBill()}
                >
                  {busy ? "Deleting…" : "Delete permanently"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {leaveAction && (
        <Modal title="Unsaved bill" onClose={() => setLeaveAction(null)}>
          <p>Save your changes before switching?</p>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setLeaveAction(null)}>
              Keep editing
            </button>
            <button
              disabled={busy}
              onClick={() => {
                unsavedBills.delete(id);
                const next = leaveAction;
                setLeaveAction(null);
                next();
              }}
            >
              Discard changes
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                if (await act("save")) {
                  const next = leaveAction;
                  setLeaveAction(null);
                  next();
                }
              }}
            >
              Save and continue
            </button>
          </div>
          <ErrorText message={error} />
        </Modal>
      )}
      {issues && !restock && (
        <Modal title="Review needed" onClose={() => setIssues(null)}>
          <div className="stock-issues">
            {issues.map((issue, index) => (
              <div key={issue.line ?? `review-${index}`}>
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
                (i) =>
                  !["shortage", "missing"].includes(i.kind) ||
                  i.message?.includes("fresh return"),
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
          onReceived={() => {
            setRestock(false);
            setIssues(null);
            // Re-resolve new matching stock only when no local edits would be lost.
            void api<Bill>(`/bills/${id}`)
              .then((latest) => {
                const draft = current.current;
                if (
                  draft &&
                  latest.revision === draft.revision &&
                  editableValue(draft) === baseline.current
                )
                  apply(latest);
              })
              .catch(() => {
                /* The stock receipt has already succeeded. */
              });
            setSaved("Stock received. Review stock mappings before accepting.");
          }}
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
