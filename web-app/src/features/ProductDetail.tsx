"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Product } from "../api";
import { ErrorText, Modal } from "../components/UI";
import DataTable from "../components/DataTable";
import { useStock } from "./Providers";
import { money } from "./Lists";
export function ProductDetail({ id }: { id: string }) {
  const router = useRouter(),
    params = useSearchParams(),
    { refresh } = useStock();
  const data = useQuery({
    queryKey: ["product", id],
    queryFn: () => api<Product>(`/products/${id}`),
    refetchInterval: 10000,
  });
  const [mode, setMode] = useState<"" | "edit" | "adjust" | "archive">(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const item = data.data,
    history = params.get("tab") === "history";
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (mode === "archive") {
        await api(`/products/${id}`, { method: "DELETE" });
        refresh();
        router.push("/stock");
        return;
      }
      const body =
        mode === "edit"
          ? {
              ...values,
              minimum: Number(values.minimum),
              unit: item!.unit,
              sku: item!.sku,
            }
          : {
              quantity: Number(values.quantity),
              reason: values.reason,
              mrp: values.mrp ? Number(values.mrp) : null,
              costPrice: values.costPrice ? Number(values.costPrice) : null,
            };
      await api(`/products/${id}${mode === "adjust" ? "/adjust" : ""}`, {
        method: mode === "adjust" ? "POST" : "PUT",
        body: JSON.stringify(body),
      });
      refresh();
      setMode("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="back-link" href="/stock">
        Back to stock
      </Link>
      <ErrorText message={data.error?.message || ""} />
      {item && (
        <>
          <header className="page-header">
            <div>
              <h1>{item.name}</h1>
              <p>
                {item.sku}
                {item.archived ? " · Archived" : ""}
              </p>
            </div>
            <div className="header-actions">
              <button
                disabled={!!item.archived}
                onClick={() => {
                  setError("");
                  setMode("edit");
                }}
              >
                Edit item
              </button>
              <button
                disabled={!!item.archived}
                onClick={() => {
                  setError("");
                  setMode("adjust");
                }}
              >
                Correct stock
              </button>
              <button
                disabled={item.stock > 0 || !!item.archived}
                title={
                  item.stock > 0
                    ? "Stock must be zero before archiving"
                    : undefined
                }
                onClick={() => {
                  setError("");
                  setMode("archive");
                }}
              >
                Archive
              </button>
            </div>
          </header>
          <div className="item-summary">
            <strong>
              {item.stock.toLocaleString()} <span>{item.unit} available</span>
            </strong>
            <span>Low stock at {item.minimum}</span>
            <Link href="/stock/invoices/new">Receive invoice</Link>
          </div>
          {!!item.supplierCodes?.length && (
            <details className="product-code-details">
              <summary>Supplier codes ({item.supplierCodes.length})</summary>
              {item.supplierCodes.map(({ tin, code }) => (
                <p key={`${tin}:${code}`}>
                  <strong>{code}</strong> · Supplier {tin}
                </p>
              ))}
            </details>
          )}
          <div className="tabs">
            <Link
              className={!history ? "active" : ""}
              href={`/stock/items/${id}`}
            >
              Batches
            </Link>
            <Link
              className={history ? "active" : ""}
              href={`/stock/items/${id}?tab=history`}
            >
              History
            </Link>
          </div>
          {history ? (
            <DataTable
              endpoint="/tables/movements"
              label="Movements"
              defaultSort="created"
              dates
              extra={{ product: id }}
              columns={[
                {
                  accessorKey: "created",
                  header: "Date",
                  cell: ({ getValue }) => new Date(getValue()).toLocaleString(),
                },
                { accessorKey: "reason", header: "Reason" },
                {
                  accessorKey: "delta",
                  header: "Quantity",
                  cell: ({ getValue }) =>
                    `${getValue() > 0 ? "+" : ""}${getValue()}`,
                },
                {
                  id: "bill",
                  header: "Bill",
                  enableSorting: false,
                  cell: ({ row }) =>
                    row.original.bill_id ? (
                      <Link href={`/bills/${row.original.bill_id}`}>
                        Open bill
                      </Link>
                    ) : (
                      "Stock in / correction"
                    ),
                },
              ]}
            />
          ) : (
            <DataTable
              endpoint="/tables/lots"
              label="Batches"
              defaultSort="received"
              dates
              extra={{ product: id }}
              statuses={[
                ["all", "All"],
                ["available", "Available"],
                ["empty", "Used"],
              ]}
              columns={[
                { accessorKey: "received", header: "Received" },
                { accessorKey: "received_qty", header: "Original quantity" },
                { accessorKey: "remaining", header: "Available" },
                {
                  accessorKey: "cost",
                  header: "Cost / packet",
                  cell: ({ getValue }) => money(getValue()),
                },
                {
                  accessorKey: "mrp",
                  header: "MRP",
                  cell: ({ getValue }) => money(getValue()),
                },
                {
                  id: "source",
                  header: "Source",
                  enableSorting: false,
                  cell: ({ row }) =>
                    row.original.intake_id ? (
                      <Link href={`/stock/invoices/${row.original.intake_id}`}>
                        Invoice
                      </Link>
                    ) : row.original.purchase_id ? (
                      <Link
                        href={`/stock/receipts/${row.original.purchase_id}`}
                      >
                        Receipt
                      </Link>
                    ) : (
                      "Opening stock / correction"
                    ),
                },
              ]}
            />
          )}
        </>
      )}
      {mode && item && (
        <Modal
          title={
            mode === "edit"
              ? "Edit item"
              : mode === "adjust"
                ? "Correct stock"
                : "Archive item"
          }
          onClose={() => {
            if (!busy) setMode("");
          }}
        >
          <form onSubmit={submit}>
            {mode === "edit" ? (
              <div className="fields">
                <label>
                  Name
                  <input
                    name="name"
                    required
                    maxLength={200}
                    defaultValue={item.name}
                  />
                </label>
                <label>
                  Low stock at
                  <input
                    name="minimum"
                    type="number"
                    min="0"
                    step="1"
                    required
                    defaultValue={item.minimum}
                  />
                </label>
                <p className="muted">
                  SKU {item.sku} · {item.unit}
                </p>
              </div>
            ) : mode === "adjust" ? (
              <div className="fields">
                <p>
                  Use invoice photos for deliveries. Corrections keep a movement
                  record.
                </p>
                <label>
                  Quantity change
                  <input
                    name="quantity"
                    type="number"
                    step="1"
                    required
                    placeholder="e.g. -6"
                  />
                </label>
                <label>
                  MRP
                  <input
                    name="mrp"
                    type="number"
                    min=".01"
                    step=".01"
                    required
                  />
                </label>
                <label>
                  Cost / packet
                  <input name="costPrice" type="number" min="0" step=".01" />
                </label>
                <label>
                  Reason
                  <input name="reason" required minLength={3} maxLength={300} />
                </label>
              </div>
            ) : (
              <p>
                Archive {item.name}? Its invoices and movement history remain
                available.
              </p>
            )}
            <ErrorText message={error} />
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={() => setMode("")}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : mode === "archive" ? "Archive" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
