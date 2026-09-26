"use client";
import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, Check } from "lucide-react";
import { api } from "../api";
export default function ProductPicker({
  value,
  onChange,
  disabled = false,
  label = "Stock item",
  emptyLabel = "Choose stock item",
  packetsOnly = false,
  unit,
  mrp,
  showStock = false,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
  emptyLabel?: string;
  packetsOnly?: boolean;
  unit?: string;
  mrp?: number | null;
  showStock?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 200);
    return () => clearTimeout(t);
  }, [search]);
  const selected = useQuery({
    queryKey: ["product-option", value],
    queryFn: () => api(`/product-options/${value}`),
    enabled: !!value,
    retry: false,
    refetchInterval: showStock ? 10000 : false,
  });
  const options = useQuery({
    queryKey: ["product-options", query, packetsOnly, unit, mrp],
    queryFn: () =>
      api<any[]>(
        `/product-options?q=${encodeURIComponent(query)}${packetsOnly || unit ? `&unit=${encodeURIComponent(packetsOnly ? "PKT" : unit!)}` : ""}${mrp != null ? `&mrp=${mrp}` : ""}`,
      ),
    enabled: open,
  });
  const matching =
    selected.data?.lots
      ?.filter((lot: any) => mrp == null || lot.mrp === mrp)
      .reduce((sum: number, lot: any) => sum + lot.remaining, 0) ?? 0;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSearch("");
          setQuery("");
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className={
            "product-picker" +
            (showStock && selected.data ? " product-picker-card" : "")
          }
        >
          {showStock && selected.data ? (
            <span className="product-picker-info">
              <strong>{selected.data.name}</strong>
              <small>
                {selected.data.sku} ·{" "}
                {selected.data.archived
                  ? "Archived"
                  : `${selected.data.stock} ${selected.data.unit} total`}
              </small>
              <small className={matching > 0 ? "stock-match" : "stock-short"}>
                {mrp == null
                  ? `${matching} ${selected.data.unit} available`
                  : `${matching} ${selected.data.unit} at MRP ${mrp.toFixed(2)}`}
              </small>
            </span>
          ) : (
            <span>
              {value
                ? selected.data
                  ? `${selected.data.name} · ${selected.data.sku}`
                  : selected.isLoading
                    ? "Loading item…"
                    : "Unavailable item"
                : emptyLabel}
            </span>
          )}
          {showStock && value && !disabled && (
            <small className="picker-change">Change</small>
          )}
          {!disabled && <ChevronsUpDown size={15} />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="product-options"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command shouldFilter={false}>
            <Command.Input
              autoFocus
              aria-label="Search stock items"
              placeholder="Search name or SKU"
              value={search}
              onValueChange={setSearch}
            />
            <Command.List>
              <Command.Item
                value="new-item"
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                {emptyLabel}
              </Command.Item>
              {options.isLoading && (
                <div className="picker-message">Searching…</div>
              )}
              {options.error && (
                <div className="error">{options.error.message}</div>
              )}
              {options.data?.map((p) => (
                <Command.Item
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    onChange(p.id);
                    setOpen(false);
                  }}
                >
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {p.sku} · {p.stock} {p.unit}
                      {mrp != null
                        ? ` · ${p.matchingStock} at MRP ${mrp.toFixed(2)}`
                        : ""}
                    </small>
                  </span>
                  {value === p.id && <Check size={16} />}
                </Command.Item>
              ))}
              {options.data?.length === 0 && (
                <div className="picker-message">No matching items</div>
              )}
              {options.data?.length === 30 && (
                <div className="picker-message">
                  Type more to narrow results.
                </div>
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
