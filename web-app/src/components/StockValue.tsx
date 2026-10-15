"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import type { StockValueReport } from "../../server/stock-value";
import DataTable, { type Row } from "./DataTable";
import { money } from "../features/Lists";

function ItemLink({ item }: { item: Row }) {
  const params = useSearchParams();
  const back = "/finance?" + params;
  return (
    <div className="stock-value-item">
      <Link
        className="record-title"
        href={`/stock/items/${item.id}?returnTo=${encodeURIComponent(back)}`}
      >
        {item.name}
      </Link>
      <small>{item.sku}</small>
    </div>
  );
}
const columns: ColumnDef<Row>[] = [
  {
    accessorKey: "name",
    header: "Item",
    cell: ({ row }) => <ItemLink item={row.original} />,
  },
  {
    accessorKey: "stock",
    header: "Available",
    cell: ({ row }) => (
      <span className="stock-value-quantity">
        {row.original.stock.toLocaleString("en-US")}{" "}
        <small>{row.original.unit}</small>
        {row.original.balanceMismatch && (
          <span className="finance-review" title="Stock balance needs review">
            Check
          </span>
        )}
      </span>
    ),
  },
  ...(
    [
      ["direct", "Direct value"],
      ["rd", "RD value"],
    ] as const
  ).map(([key, header]) => ({
    accessorKey: key,
    header,
    cell: ({ row }: { row: { original: Row } }) => (
      <div className="stock-value-amount">
        {money(row.original[key])}
        {row.original.unpricedLots > 0 && row.original[key] !== null && (
          <small
            title={`${row.original.unpricedStock} ${row.original.unit} without purchase cost`}
          >
            Partial
          </small>
        )}
      </div>
    ),
  })),
];
export default function StockValue() {
  const params = useSearchParams();
  function unpricedHref() {
    const next = new URLSearchParams(params);
    next.set("status", "unpriced");
    next.delete("page");
    return "/finance?" + next;
  }
  return (
    <DataTable
      endpoint="/finance/stock-value"
      label="Stock value"
      defaultSort="name"
      statuses={[
        ["all", "All"],
        ["priced", "Priced"],
        ["unpriced", "Unpriced"],
      ]}
      statusLabel="Prices"
      columns={columns}
      renderSummary={(report: StockValueReport) => (
        <div className="stock-value-summary">
          <div className="finance-counts">
            <span>
              {report.summary.items}{" "}
              {report.summary.items === 1 ? "item" : "items"}
            </span>
            {report.summary.unpricedLots > 0 && (
              <Link href={unpricedHref()} scroll={false}>
                {report.summary.unpricedLots} unpriced{" "}
                {report.summary.unpricedLots === 1 ? "batch" : "batches"}
              </Link>
            )}
            {report.summary.balanceIssues > 0 && (
              <span className="finance-review">
                {report.summary.balanceIssues} stock{" "}
                {report.summary.balanceIssues === 1 ? "check" : "checks"}
              </span>
            )}
          </div>
          <div className="finance-cards stock-value-cards">
            <div className="finance-card">
              <span>Direct value</span>
              <strong>{money(report.summary.direct)}</strong>
              {report.summary.unpricedLots > 0 && <small>Partial</small>}
            </div>
            <div className="finance-card finance-card-primary">
              <span>RD value</span>
              <strong>{money(report.summary.rd)}</strong>
              <small>
                {report.marginPercent.toFixed(2)}% margin
                {report.summary.unpricedLots > 0 ? " · Partial" : ""}
              </small>
            </div>
          </div>
        </div>
      )}
    />
  );
}
