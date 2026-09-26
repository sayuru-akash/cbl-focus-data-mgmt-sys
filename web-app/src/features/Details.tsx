"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, type Purchase } from "../api";
import { useStock } from "./Providers";
import BillReview from "../views/Bills";
import InvoiceIntake from "../components/InvoiceIntake";
import { money } from "./Lists";
import { ErrorText } from "../components/UI";
import DataTable from "../components/DataTable";
import { billColumns } from "./Lists";
export function BillDetail({ id }: { id: string }) {
  const { products, refresh } = useStock(),
    router = useRouter();
  const back = useSearchParams().get("returnTo");
  const returnTo =
    back && (back === "/bills" || back.startsWith("/bills?")) ? back : "/bills";
  return (
    <div className="record-page">
      <BillReview
        id={id}
        products={products}
        onUpdate={refresh}
        onClose={() => router.push(returnTo)}
      />
    </div>
  );
}
export function IntakeDetail({ id }: { id?: string }) {
  const { products, refresh } = useStock(),
    router = useRouter();
  return (
    <>
      <InvoiceIntake
        inline
        id={id}
        products={products}
        onSaved={refresh}
        onClose={() => router.push("/stock/invoices")}
      />
    </>
  );
}
export function ReceiptDetail({ id }: { id: string }) {
  const data = useQuery({
    queryKey: ["purchase", id],
    queryFn: () => api(`/purchases/${id}`),
  });
  return (
    <>
      <Link className="back-link" href="/stock/invoices">
        Back to stock in
      </Link>
      <ErrorText message={data.error?.message || ""} />
      {data.isLoading && (
        <p role="status" className="muted">
          Loading…
        </p>
      )}
      {data.isError && (
        <button onClick={() => void data.refetch()}>Try again</button>
      )}
      {data.data && (
        <>
          <header className="page-header">
            <div>
              <h1>{data.data.number}</h1>
              <p>
                {data.data.supplier} · {data.data.received}
              </p>
            </div>
            <span
              className={
                "status " +
                (data.data.status === "received" ? "accepted" : "pending")
              }
            >
              {data.data.status}
            </span>
          </header>
          {data.data.status === "draft" && (
            <p className="notice">
              This older draft is read-only.{" "}
              <Link href="/stock/invoices/new">
                Upload invoice photos to receive stock.
              </Link>
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>SKU</th>
                  <th>Quantity</th>
                  <th>Cost / packet</th>
                  <th>MRP</th>
                </tr>
              </thead>
              <tbody>
                {data.data.lines.map((l: any, i: number) => (
                  <tr key={i}>
                    <td>
                      {l.product ? (
                        <Link href={`/stock/items/${l.product.id}`}>
                          {l.product.name}
                        </Link>
                      ) : (
                        l.newProduct?.name || "Archived item"
                      )}
                    </td>
                    <td>{l.product?.sku || l.newProduct?.sku}</td>
                    <td>
                      {l.quantity} {l.product?.unit || "PKT"}
                    </td>
                    <td>{money(l.costPrice)}</td>
                    <td>{money(l.mrp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.data.note && <p className="muted">{data.data.note}</p>}
        </>
      )}
    </>
  );
}
export function CustomerDetail({ id }: { id: string }) {
  const data = useQuery({
    queryKey: ["customer", id],
    queryFn: () => api(`/customers/${id}`),
  });
  return (
    <>
      <Link className="back-link" href="/customers">
        Back to customers
      </Link>
      <ErrorText message={data.error?.message || ""} />
      {data.isLoading && (
        <p role="status" className="muted">
          Loading…
        </p>
      )}
      {data.isError && (
        <button onClick={() => void data.refetch()}>Try again</button>
      )}
      {data.data && (
        <>
          <header className="page-header">
            <div>
              <h1>{data.data.name}</h1>
              <p>Outlet {data.data.outlet_id}</p>
            </div>
          </header>
          <div className="customer-info">
            <p>{data.data.address}</p>
            {data.data.phone && (
              <a href={`tel:${data.data.phone}`}>{data.data.phone}</a>
            )}
          </div>
          <DataTable
            endpoint="/tables/bills"
            label="Bills"
            defaultSort="received"
            extra={{ customer: id }}
            dates
            statuses={[
              ["all", "All"],
              ["pending", "Pending"],
              ["accepted", "Accepted"],
              ["rejected", "Rejected"],
            ]}
            columns={billColumns}
          />
        </>
      )}
    </>
  );
}
