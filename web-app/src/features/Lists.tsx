"use client";
import Link from "next/link";
import { Plus, ChevronRight } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import DataTable, { type Row } from "../components/DataTable";
import DeleteIntakeButton from "../components/DeleteIntakeButton";
import { useStock } from "./Providers";
export const money = (value: number | null | undefined) =>
  value == null
    ? "Not recorded"
    : `Rs ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const statusCell = ({ getValue }: any) => (
  <span
    className={
      "status " +
      ({ received: "accepted", draft: "pending" }[getValue() as string] ||
        getValue())
    }
  >
    {getValue()}
  </span>
);
const open = (href: (r: Row) => string): ColumnDef<Row> => ({
  id: "open",
  header: "",
  enableSorting: false,
  cell: ({ row }) => (
    <Link
      className="record-open"
      aria-label={`Open ${row.original.number || row.original.name || "record"}`}
      href={href(row.original)}
    >
      <ChevronRight size={19} />
    </Link>
  ),
});
export function StockTabs({ active }: { active: "items" | "invoices" }) {
  return (
    <div className="tabs">
      <Link className={active === "items" ? "active" : ""} href="/stock">
        Items
      </Link>
      <Link
        className={active === "invoices" ? "active" : ""}
        href="/stock/invoices"
      >
        Stock in
      </Link>
    </div>
  );
}
export function StockList() {
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Stock</h1>
          <p>Items and stock batches.</p>
        </div>
        <Link className="button primary" href="/stock/invoices/new">
          <Plus size={18} />
          Receive invoice
        </Link>
      </header>
      <StockTabs active="items" />
      <DataTable
        endpoint="/tables/products"
        label="Items"
        defaultSort="name"
        statuses={[
          ["all", "All"],
          ["available", "In stock"],
          ["low", "Low stock"],
          ["empty", "Out of stock"],
        ]}
        columns={[
          {
            accessorKey: "name",
            header: "Item",
            cell: ({ row }) => (
              <Link
                className="record-title"
                href={`/stock/items/${row.original.id}`}
              >
                {row.original.name}
              </Link>
            ),
          },
          { accessorKey: "sku", header: "SKU" },
          {
            accessorKey: "stock",
            header: "Available",
            cell: ({ row }) => (
              <span
                className={
                  row.original.stock <= row.original.minimum ? "low-stock" : ""
                }
              >
                {row.original.stock.toLocaleString()}{" "}
                <span className="muted">{row.original.unit}</span>
              </span>
            ),
          },
          { accessorKey: "minimum", header: "Low at" },
          {
            id: "mrp",
            accessorKey: "mrp_min",
            header: "MRP",
            cell: ({ row }) =>
              row.original.mrp_min === row.original.mrp_max
                ? money(row.original.mrp_min)
                : `${money(row.original.mrp_min)} - ${money(row.original.mrp_max)}`,
          },
          open((r) => `/stock/items/${r.id}`),
        ]}
      />
    </>
  );
}
export function InvoiceList() {
  const { refresh } = useStock();
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Stock in</h1>
          <p>Supplier invoices.</p>
        </div>
        <Link className="button primary" href="/stock/invoices/new">
          <Plus size={18} />
          Receive invoice
        </Link>
      </header>
      <StockTabs active="invoices" />
      <DataTable
        endpoint="/tables/invoices"
        label="Invoices"
        defaultSort="created"
        dates
        statuses={[
          ["all", "All"],
          ["draft", "Draft"],
          ["received", "Received"],
        ]}
        columns={[
          {
            accessorKey: "number",
            header: "Reference",
            cell: ({ row }) => (
              <Link
                className="record-title"
                href={`/stock/${row.original.kind === "receipt" ? "receipts" : "invoices"}/${row.original.id}`}
              >
                {row.original.number || "Invoice photos"}
              </Link>
            ),
          },
          { accessorKey: "supplier", header: "Supplier" },
          {
            accessorKey: "date",
            header: "Date",
            cell: ({ getValue }) => (
              <span className="invoice-cell-value">{getValue()}</span>
            ),
          },
          {
            accessorKey: "pages",
            header: "Pages",
            cell: ({ getValue }) => getValue() || "No photos",
          },
          {
            accessorKey: "status",
            header: "Status",
            cell: (props) => (
              <span className="invoice-cell-value">{statusCell(props)}</span>
            ),
          },
          {
            accessorKey: "total",
            header: "Total",
            cell: ({ getValue }) => (
              <span className="invoice-cell-value">{money(getValue())}</span>
            ),
          },
          {
            id: "actions",
            header: "",
            enableSorting: false,
            cell: ({ row }) => (
              <div className="invoice-row-actions">
                <Link
                  className="record-open"
                  aria-label={`Open ${row.original.number || "invoice"}`}
                  href={`/stock/${row.original.kind === "receipt" ? "receipts" : "invoices"}/${row.original.id}`}
                >
                  <ChevronRight size={19} />
                </Link>
                {row.original.kind !== "receipt" &&
                  row.original.status === "draft" && (
                    <DeleteIntakeButton
                      id={row.original.id}
                      onDeleted={refresh}
                    />
                  )}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
export const billColumns: ColumnDef<Row, any>[] = [
  {
    accessorKey: "number",
    header: "Bill",
    cell: ({ row }) => (
      <Link className="record-title" href={`/bills/${row.original.id}`}>
        {row.original.number ? `#${row.original.number}` : "Needs review"}
      </Link>
    ),
  },
  {
    accessorKey: "shop",
    header: "Customer",
    cell: ({ row }) =>
      row.original.customer_id ? (
        <Link href={`/customers/${row.original.customer_id}`}>
          {row.original.shop}
          <small className="cell-secondary">Outlet {row.original.outlet}</small>
        </Link>
      ) : (
        row.original.shop
      ),
  },
  { accessorKey: "date", header: "Date" },
  { accessorKey: "status", header: "Status", cell: statusCell },
  {
    accessorKey: "total",
    header: "Total",
    cell: ({ getValue }) => money(getValue()),
  },
  open((r) => `/bills/${r.id}`),
];
export { default as BillList } from "./BillInbox";
export function CustomerList() {
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Customers</h1>
          <p>Shops from accepted bills.</p>
        </div>
      </header>
      <DataTable
        endpoint="/tables/customers"
        label="Customers"
        defaultSort="name"
        dates
        columns={[
          {
            accessorKey: "name",
            header: "Customer",
            cell: ({ row }) => (
              <Link
                className="record-title"
                href={`/customers/${row.original.id}`}
              >
                {row.original.name}
              </Link>
            ),
          },
          { accessorKey: "outlet_id", header: "Outlet" },
          { accessorKey: "address", header: "Address", enableSorting: false },
          { accessorKey: "phone", header: "Phone", enableSorting: false },
          { accessorKey: "bill_count", header: "Accepted bills" },
          {
            accessorKey: "last_seen",
            header: "Last bill",
            cell: ({ getValue }) => String(getValue()).slice(0, 10),
          },
          open((r) => `/customers/${r.id}`),
        ]}
      />
    </>
  );
}
