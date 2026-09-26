"use client";
import { useEffect, useState, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  X,
} from "lucide-react";
import { api } from "../api";
import { ErrorText } from "./UI";
export type Row = Record<string, any>;
export default function DataTable({
  endpoint,
  columns,
  label,
  statuses,
  dates = false,
  defaultSort,
  defaultStatus = "all",
  extra = {},
}: {
  endpoint: string;
  columns: ColumnDef<Row, any>[];
  label: string;
  statuses?: [string, string][];
  dates?: boolean;
  defaultSort: string;
  defaultStatus?: string;
  extra?: Record<string, string>;
}) {
  const router = useRouter(),
    path = usePathname(),
    searchParams = useSearchParams();
  const query = searchParams.get("q") || "",
    [search, setSearch] = useState(query);
  const page = Math.max(1, Number(searchParams.get("page")) || 1),
    size = [10, 25, 50, 100].includes(Number(searchParams.get("size")))
      ? Number(searchParams.get("size"))
      : 10;
  const sort = searchParams.get("sort") || defaultSort,
    status = searchParams.get("status") || defaultStatus,
    dir =
      searchParams.get("dir") ||
      (["name", "number"].includes(defaultSort) ? "asc" : "desc");
  const pendingParams = useRef(searchParams.toString());
  useEffect(() => {
    pendingParams.current = searchParams.toString();
  }, [searchParams]);
  function update(values: Record<string, string>) {
    const params = new URLSearchParams(pendingParams.current);
    for (const [k, v] of Object.entries(values)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    if (!("page" in values)) params.delete("page");
    pendingParams.current = params.toString();
    router.replace(`${path}${params.size ? "?" + params : ""}`, {
      scroll: false,
    });
  }
  useEffect(() => setSearch(query), [query]);
  useEffect(() => {
    if (search === query) return;
    const t = setTimeout(() => update({ q: search }), 300);
    return () => clearTimeout(t);
  }, [search, query, searchParams.toString()]);
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
    sort,
    dir,
    status,
    q: query,
    ...extra,
  });
  for (const key of ["from", "to"]) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }
  const data = useQuery({
    queryKey: ["table", endpoint, params.toString()],
    queryFn: () =>
      api<{ rows: Row[]; total: number; page: number; size: number }>(
        `${endpoint}?${params}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 10000,
  });
  const total = data.data?.total || 0,
    actualPage = data.data?.page || page;
  const table = useReactTable({
    data: data.data?.rows || [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: total,
    state: {
      pagination: { pageIndex: actualPage - 1, pageSize: size },
      sorting: [{ id: sort, desc: dir === "desc" }],
    },
    onSortingChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater([{ id: sort, desc: dir === "desc" }])
          : updater;
      if (next[0])
        update({ sort: next[0].id, dir: next[0].desc ? "desc" : "asc" });
    },
    enableSortingRemoval: false,
    getRowId: (row) => row.id,
  });
  return (
    <section aria-label={label} className="data-grid">
      <div className="grid-tools">
        <label className="search">
          <Search size={18} />
          <input
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="icon-button"
              aria-label="Clear search"
              onClick={() => {
                setSearch("");
                update({ q: "" });
              }}
            >
              <X size={16} />
            </button>
          )}
        </label>
        {statuses && (
          <label className="filter-label">
            {label === "Items" ? "Stock status" : "Status"}
            <select
              value={status}
              onChange={(e) => update({ status: e.target.value })}
            >
              {statuses.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
        )}
        {dates && (
          <>
            <label className="filter-label">
              From
              <input
                type="date"
                value={searchParams.get("from") || ""}
                onInput={(e) => update({ from: e.currentTarget.value })}
                onChange={(e) => update({ from: e.target.value })}
              />
            </label>
            <label className="filter-label">
              To
              <input
                type="date"
                value={searchParams.get("to") || ""}
                onInput={(e) => update({ to: e.currentTarget.value })}
                onChange={(e) => update({ to: e.target.value })}
              />
            </label>
          </>
        )}
        {searchParams.size > 0 && (
          <button
            className="icon-button"
            aria-label="Reset filters"
            title="Reset filters"
            onClick={() =>
              router.replace(
                path +
                  (searchParams.get("tab")
                    ? "?tab=" + searchParams.get("tab")
                    : ""),
                { scroll: false },
              )
            }
          >
            <RotateCcw size={17} />
          </button>
        )}
      </div>
      <ErrorText message={data.error?.message || ""} />
      {data.isError && (
        <button onClick={() => void data.refetch()}>Try again</button>
      )}
      <div className="table-wrap" aria-busy={data.isFetching}>
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : undefined
                    }
                  >
                    {header.column.getCanSort() ? (
                      <button
                        className="sort-button"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        {header.column.getIsSorted() === "asc" ? (
                          <ArrowUp size={13} />
                        ) : header.column.getIsSorted() === "desc" ? (
                          <ArrowDown size={13} />
                        ) : (
                          <ArrowUpDown size={13} />
                        )}
                      </button>
                    ) : (
                      flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {!table.getRowModel().rows.length && (
              <tr>
                <td colSpan={columns.length} className="table-empty">
                  {data.isLoading
                    ? "Loading…"
                    : data.isError
                      ? "Unable to load records."
                      : "No matching records."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="grid-footer">
        <span role="status">
          {total
            ? `${(actualPage - 1) * size + 1}-${Math.min(actualPage * size, total)} of ${total}`
            : "0 records"}
          {data.isFetching && !data.isLoading ? " · Updating…" : ""}
        </span>
        <div>
          <label>
            Rows
            <select
              aria-label="Rows per page"
              value={size}
              onChange={(e) => update({ size: e.target.value })}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button
            aria-label="Previous page"
            disabled={actualPage <= 1 || data.isPlaceholderData}
            onClick={() => update({ page: String(actualPage - 1) })}
          >
            <ChevronLeft size={17} />
          </button>
          <span>
            Page {actualPage} of {Math.max(1, Math.ceil(total / size))}
          </span>
          <button
            aria-label="Next page"
            disabled={actualPage * size >= total || data.isPlaceholderData}
            onClick={() => update({ page: String(actualPage + 1) })}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </footer>
    </section>
  );
}
