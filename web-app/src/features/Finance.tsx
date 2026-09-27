"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import PaymentBadge from "../components/PaymentBadge";
import DataTable, { type Row } from "../components/DataTable";
import { money } from "./Lists";
import {
  colomboDay,
  discountCategories,
} from "../../server/discount-categories";
import type { FinanceReport } from "../../server/finance";
const FinanceChart = dynamic(() => import("../components/FinanceChart"), {
  ssr: false,
  loading: () => <div className="finance-chart-empty">Loading chart…</div>,
});
const valueColumn = (key: string, title: string): ColumnDef<Row> => ({
  accessorKey: key,
  header: title,
  cell: ({ getValue }) => money(getValue() as number | null),
});
function FinanceBillLink({ bill }: { bill: Row }) {
  const params = useSearchParams();
  const back = "/finance" + (params.size ? "?" + params.toString() : "");
  return (
    <Link
      className="record-title"
      href={`/bills/${bill.id}?returnTo=${encodeURIComponent(back)}`}
    >
      #{bill.number || "Untitled"}
    </Link>
  );
}
const columns: ColumnDef<Row>[] = [
  {
    accessorKey: "number",
    header: "Bill",
    cell: ({ row }) => <FinanceBillLink bill={row.original} />,
  },
  { accessorKey: "date", header: "Date" },
  { accessorKey: "shop", header: "Customer" },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => (
      <span className={`status ${getValue()}`}>
        {getValue() === "pending" ? "Draft" : "Accepted"}
      </span>
    ),
  },
  {
    accessorKey: "payment_type",
    header: "Payment",
    cell: ({ getValue }) => (
      <PaymentBadge value={getValue() as string | null} />
    ),
  },
  valueColumn("gross", "Gross"),
  valueColumn("discount", "Discounts"),
  ...discountCategories.map(({ key, label }) => valueColumn(key, label)),
  valueColumn("returns", "Return credit"),
  valueColumn("net", "Net billed"),
  {
    id: "review",
    header: "",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.issues.length > 0 ? (
        <span className="finance-review" title={row.original.issues.join(". ")}>
          Check
        </span>
      ) : null,
  },
];
function Summary({ report }: { report: FinanceReport }) {
  const s = report.summary;
  return (
    <div className="finance-report">
      <div className="finance-counts">
        <span>
          {s.bills} {s.bills === 1 ? "bill" : "bills"}
        </span>
        <span>
          {s.customers} {s.customers === 1 ? "customer" : "customers"}
        </span>
        {report.filters.status === "all" && (
          <>
            <span>{s.accepted} accepted</span>
            <span>{s.drafts} drafts</span>
          </>
        )}
        {report.filters.status !== "accepted" && (
          <span className="finance-draft-note">
            Includes unapproved amounts
          </span>
        )}
      </div>
      {(s.incomplete > 0 || s.review > 0) && (
        <p className="receipt-warning">
          {s.incomplete > 0
            ? `${s.incomplete} bills have missing amounts and are excluded from totals. `
            : ""}
          {s.review > 0 ? `${s.review} bills need amount review.` : ""}
        </p>
      )}
      <div className="finance-cards">
        {[
          ["Gross sales", s.gross],
          ["Discounts", s.discount],
          ["Return credit", s.returns],
          ["Net billed", s.net],
        ].map(([label, value]) => (
          <div
            className={`finance-card ${label === "Net billed" ? "finance-card-primary" : ""}`}
            key={label}
          >
            <span>{label}</span>
            <strong>{money(Number(value))}</strong>
          </div>
        ))}
      </div>
      <section
        className="finance-payments"
        aria-label="Billed value by payment type"
      >
        <div className="finance-section-title">
          <h2>Payment types</h2>
          <span>Net billed · Rs</span>
        </div>
        <div className="payment-totals">
          {report.payments
            .filter((p) => p.type !== "unset" || p.bills > 0)
            .map((p) => (
              <div key={p.type} className="payment-total">
                <PaymentBadge value={p.type} />
                <strong>{money(p.net)}</strong>
                <small>
                  {p.bills} {p.bills === 1 ? "bill" : "bills"}
                </small>
                <div
                  className="payment-meter"
                  role="img"
                  aria-label={`${p.label}: ${money(p.net)}`}
                >
                  <i
                    className={`payment-bar-${p.type}`}
                    style={{
                      width: `${(Math.abs(p.net) / Math.max(1, ...report.payments.map((v) => Math.abs(v.net)))) * 100}%`,
                    }}
                  />
                </div>
              </div>
            ))}
        </div>
      </section>
      <div className="finance-analysis">
        <FinanceChart days={report.days} />
        <section className="finance-discounts" aria-label="Discount categories">
          <div className="finance-section-title">
            <h2>Discount categories</h2>
            <span>GRTS</span>
          </div>
          {discountCategories.map(({ key, label }) => (
            <div className="finance-category" key={key}>
              <div>
                <span>{label}</span>
                <strong>{money(s[key])}</strong>
              </div>
              <div className="finance-meter" aria-hidden="true">
                <i
                  style={{
                    width: `${Math.min(100, s.billDiscount + s.skuDiscount > 0 ? (s[key] / (s.billDiscount + s.skuDiscount)) * 100 : 0)}%`,
                  }}
                />
              </div>
            </div>
          ))}
          {s.categoryIssues > 0 && (
            <p className="receipt-warning">
              {s.categoryIssues} bill{s.categoryIssues === 1 ? "" : "s"} need
              category review. Difference: {money(s.categoryDifference)}.
            </p>
          )}
          <small>Included in discounts, not an extra deduction.</small>
        </section>
      </div>
      <details className="finance-breakdown">
        <summary>Breakdown</summary>
        <div>
          {[
            ["Bill discount", s.billDiscount],
            ["SKU discount", s.skuDiscount],
            ["Line discounts", s.lineDiscount],
            ["Fresh returns", s.freshReturns],
            ["Market / expiry returns", s.marketReturns],
            ["Reverse GRTS", s.returnReversal],
          ].map(([name, amount]) => (
            <p key={name}>
              <span>{name}</span>
              <strong>{money(Number(amount))}</strong>
            </p>
          ))}
          <p>
            <span>Free items</span>
            <strong>
              {Object.entries(report.freeUnits)
                .map(([unit, qty]) => `${qty.toLocaleString()} ${unit}`)
                .join(" · ") || "0"}
            </strong>
          </p>
        </div>
        <small>
          Gross - discounts - return credit = net billed. Return credit = fresh
          + market returns - reverse GRTS. These are billed amounts, not cash
          collected.
        </small>
      </details>
      <div className="finance-section-title">
        <h2>Bills</h2>
        <span>
          {report.filters.from} to {report.filters.to}
        </span>
      </div>
    </div>
  );
}
export default function Finance() {
  const params = useSearchParams();
  const [today, setToday] = useState(() => colomboDay());
  useEffect(() => {
    const timer = setInterval(() => setToday(colomboDay()), 60000);
    return () => clearInterval(timer);
  }, []);
  const monthStart = today.slice(0, 7) + "-01";
  const from = params.get("from") || monthStart,
    to = params.get("to") || today;
  const monthEnd = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10);
  const lastEnd = new Date(
      Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0),
    )
      .toISOString()
      .slice(0, 10),
    lastStart = lastEnd.slice(0, 7) + "-01";
  const presets = [
    ["Month to date", monthStart, today],
    ["This month", monthStart, monthEnd],
    ["Last month", lastStart, lastEnd],
    ["This year", today.slice(0, 4) + "-01-01", today],
  ];
  function period(start: string, end: string) {
    const next = new URLSearchParams(params);
    next.set("from", start);
    next.set("to", end);
    next.delete("page");
    return `/finance?${next}`;
  }
  const exportParams = new URLSearchParams(params);
  exportParams.set("from", from);
  exportParams.set("to", to);
  if (!exportParams.has("status")) exportParams.set("status", "accepted");
  return (
    <div className="finance-page">
      <header className="page-header">
        <div>
          <h1>Finance</h1>
          <p>By bill date · Sri Lanka</p>
        </div>
        <a
          className="button"
          href={`/api/finance/export?${exportParams}`}
          download
        >
          <Download size={17} />
          Export CSV
        </a>
      </header>
      <nav className="finance-periods" aria-label="Finance period">
        {presets.map(([label, start, end]) => (
          <Link
            key={label}
            className={`button ${from === start && to === end ? "active" : ""}`}
            href={period(start, end)}
            scroll={false}
          >
            {label}
          </Link>
        ))}
      </nav>
      <DataTable
        endpoint="/finance"
        label="Finance bills"
        defaultSort="date"
        defaultStatus="accepted"
        dates
        statuses={[
          ["accepted", "Accepted"],
          ["pending", "Drafts"],
          ["all", "All active"],
        ]}
        extra={{ from, to }}
        columns={columns}
        renderSummary={(data: FinanceReport) => <Summary report={data} />}
      />
    </div>
  );
}
