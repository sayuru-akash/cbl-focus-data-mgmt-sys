"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronLeft,
  ChevronRight,
  X,
  ExternalLink,
  Radio,
} from "lucide-react";
import DataTable, { type Row } from "../components/DataTable";
import { billColumns } from "./Lists";
import BillReview, { type BillNavigationGuard } from "../views/Bills";
import { useStock } from "./Providers";

export default function BillInbox() {
  const router = useRouter(),
    params = useSearchParams(),
    { products, refresh } = useStock();
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const id = params.get("bill");
  const returnParams = new URLSearchParams(params.toString());
  returnParams.delete("bill");
  const returnTo = `/bills${returnParams.size ? "?" + returnParams : ""}`;
  const fullPage = (billId: string) =>
    `/bills/${encodeURIComponent(billId)}?returnTo=${encodeURIComponent(returnTo)}`;
  const rows = useRef<Row[]>([]);
  const selectedId = useRef(id);
  selectedId.current = id;
  const [sequence, setSequence] = useState<string[]>([]);
  const guard = useRef<BillNavigationGuard>(null);
  const opener = useRef<HTMLElement | null>(null);
  const title = useRef<HTMLHeadingElement | null>(null);
  const onRows = useCallback((next: Row[]) => {
    rows.current = next;
    setSequence((previous) =>
      !previous.length && next.some((row) => row.id === selectedId.current)
        ? next.map((row) => row.id)
        : previous,
    );
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (desktop === false && id) router.replace(fullPage(id));
  }, [desktop, id, router, returnTo]);
  function navigate(action: () => void) {
    if (guard.current) guard.current(action);
    else action();
  }
  function select(next: string | null, push = false) {
    const query = new URLSearchParams(params.toString());
    if (next) query.set("bill", next);
    else query.delete("bill");
    router[push ? "push" : "replace"](
      `/bills${query.size ? "?" + query : ""}`,
      { scroll: false },
    );
  }
  function open(next: string) {
    if (!desktop) {
      router.push(fullPage(next));
      return;
    }
    opener.current = document.activeElement as HTMLElement;
    navigate(() => {
      setSequence(rows.current.map((row) => row.id));
      select(next, !id);
    });
  }
  const index = sequence.indexOf(id || "");
  const move = (direction: number) => {
    const next = sequence[index + direction];
    if (next) navigate(() => select(next));
  };
  const columns = billColumns.map((column) => {
    if ("accessorKey" in column && column.accessorKey === "number")
      return {
        ...column,
        cell: ({ row }: any) =>
          desktop ? (
            <button
              className="bill-open record-title"
              onClick={() => open(row.original.id)}
            >
              {row.original.number ? `#${row.original.number}` : "Needs review"}
            </button>
          ) : (
            <Link className="record-title" href={fullPage(row.original.id)}>
              {row.original.number ? `#${row.original.number}` : "Needs review"}
            </Link>
          ),
      };
    if (column.id === "open")
      return {
        ...column,
        cell: ({ row }: any) =>
          desktop ? (
            <button
              className="icon-button"
              aria-label={`Open ${row.original.number || "bill"}`}
              onClick={() => open(row.original.id)}
            >
              <ChevronRight size={19} />
            </button>
          ) : (
            <Link
              className="record-open"
              aria-label={`Open ${row.original.number || "bill"}`}
              href={fullPage(row.original.id)}
            >
              <ChevronRight size={19} />
            </Link>
          ),
      };
    return column;
  });
  return (
    <>
      <header className="page-header">
        <div>
          <h1 ref={title} tabIndex={-1}>
            Bills
          </h1>
          <p>From your print receiver.</p>
        </div>
        <span className="inbox-sync">
          <Radio size={16} />
          Updates automatically
        </span>
      </header>
      <nav className="tabs" aria-label="Bill status">
        {[
          ["pending", "Pending"],
          ["accepted", "Accepted"],
          ["rejected", "Rejected"],
          ["all", "All"],
        ].map(([status, label]) => {
          const query = new URLSearchParams(params.toString());
          query.set("status", status!);
          query.delete("page");
          query.delete("bill");
          return (
            <Link
              key={status}
              href={`/bills?${query}`}
              className={
                (params.get("status") || "pending") === status ? "active" : ""
              }
              aria-current={
                (params.get("status") || "pending") === status
                  ? "page"
                  : undefined
              }
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <DataTable
        endpoint="/tables/bills"
        label="Bills"
        defaultSort="received"
        defaultStatus="pending"
        preserveStatus
        dates
        onRowsChange={onRows}
        columns={columns}
      />
      <p className="page-footer">Stock changes only after acceptance.</p>
      {desktop && id && (
        <Dialog.Root
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) navigate(() => select(null));
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="bill-drawer-overlay" />
            <Dialog.Content
              className="bill-drawer"
              aria-describedby={undefined}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                if (opener.current?.isConnected) opener.current.focus();
                else title.current?.focus();
              }}
              onPointerDownOutside={(e) => e.preventDefault()}
              onEscapeKeyDown={(e) => {
                e.preventDefault();
                navigate(() => select(null));
              }}
              onKeyDown={(e) => {
                if (!(
                  e.altKey &&
                  (e.key === "ArrowLeft" || e.key === "ArrowRight")
                ))
                  return;
                if (
                  (e.target as Element).closest(
                    'input,textarea,select,[role="combobox"]',
                  )
                )
                  return;
                e.preventDefault();
                move(e.key === "ArrowRight" ? 1 : -1);
              }}
            >
              <header className="bill-drawer-toolbar">
                <Dialog.Title>Bill review</Dialog.Title>
                <div className="bill-drawer-navigation">
                  <button
                    className="icon-button"
                    title="Previous bill (Alt + Left)"
                    aria-label="Previous bill"
                    disabled={index <= 0}
                    onClick={() => move(-1)}
                  >
                    <ChevronLeft size={19} />
                  </button>
                  <span>
                    {index >= 0 ? `${index + 1} / ${sequence.length}` : "Bill"}
                  </span>
                  <button
                    className="icon-button"
                    title="Next bill (Alt + Right)"
                    aria-label="Next bill"
                    disabled={index < 0 || index >= sequence.length - 1}
                    onClick={() => move(1)}
                  >
                    <ChevronRight size={19} />
                  </button>
                </div>
                <button
                  className="icon-button"
                  title="Open full page"
                  aria-label="Open bill full page"
                  onClick={() => navigate(() => router.push(fullPage(id)))}
                >
                  <ExternalLink size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Close bill"
                  onClick={() => navigate(() => select(null))}
                >
                  <X size={20} />
                </button>
              </header>
              <p className="bill-drawer-context">
                Browsing bills from this inbox page
              </p>
              <div className="bill-drawer-body">
                <BillReview
                  key={id}
                  id={id}
                  panel
                  products={products}
                  navigationGuard={guard}
                  onUpdate={refresh}
                  onClose={() => select(null)}
                />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}
