"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { money } from "../features/Lists";
import { creditAgeBands } from "../../server/credit-age-bands";
import type { CreditAgeReport } from "../../server/credit-age";

export function CreditAgeCards({ report }: { report: CreditAgeReport }) {
  const params = useSearchParams();
  const active = params.get("view") === "credit" ? report.filters.band : "";
  const href = (band: string) => {
    const next = new URLSearchParams(params);
    if (params.get("view") !== "credit") next.delete("q");
    next.set("view", "credit");
    next.set("band", band);
    for (const key of ["page", "sort", "dir", "status", "payment"])
      next.delete(key);
    return `/finance?${next}`;
  };
  const all = report.summary.bills;
  const total = report.summary.net;
  return (
    <section className="credit-age" aria-label="Credit age">
      <div className="finance-section-title">
        <div>
          <h2>Credit age</h2>
          <p>
            All dates · As of {report.asOf}
            {report.filters.q ? " · Search results" : ""}
          </p>
        </div>
        <Link
          className={`credit-age-all ${active === "all" ? "active" : ""}`}
          href={href("all")}
          scroll={false}
          aria-current={active === "all" ? "page" : undefined}
        >
          <span>
            All credit <ArrowUpRight size={14} aria-hidden="true" />
          </span>
          <strong>{money(total)}</strong>
          <small>
            {all} {all === 1 ? "bill" : "bills"}
            {report.summary.incomplete
              ? ` · ${report.summary.incomplete} missing amounts`
              : ""}
          </small>
        </Link>
      </div>
      <div className="credit-age-cards">
        {creditAgeBands.map(({ key, label }) => {
          const bucket = report.buckets.find((b) => b.key === key)!;
          return (
            <Link
              className={`credit-age-card ${active === key ? "active" : ""}`}
              key={key}
              href={href(key)}
              scroll={false}
              aria-current={active === key ? "page" : undefined}
            >
              <span>
                {label}
                <ArrowUpRight size={15} aria-hidden="true" />
              </span>
              <strong>{money(bucket.net)}</strong>
              <small>
                {bucket.bills} {bucket.bills === 1 ? "bill" : "bills"}
                {bucket.incomplete
                  ? ` · ${bucket.incomplete} missing amounts`
                  : ""}
              </small>
            </Link>
          );
        })}
      </div>
      <div className="credit-age-note">
        <small>
          Accepted bills · Separate groups · Billed values, not unpaid balances
        </small>
        {report.buckets
          .filter((b) => ["undated", "future"].includes(b.key) && b.bills > 0)
          .map((b) => (
            <Link href={href(b.key)} key={b.key} scroll={false}>
              {b.label}: {b.bills} · {money(b.net)}
            </Link>
          ))}
      </div>
    </section>
  );
}
