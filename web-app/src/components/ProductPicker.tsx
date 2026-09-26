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
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
  emptyLabel?: string;
  packetsOnly?: boolean;
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
  });
  const options = useQuery({
    queryKey: ["product-options", query, packetsOnly],
    queryFn: () =>
      api<any[]>(
        `/product-options?q=${encodeURIComponent(query)}${packetsOnly ? "&unit=PKT" : ""}`,
      ),
    enabled: open,
  });
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className="product-picker"
        >
          <span>
            {value
              ? selected.data
                ? `${selected.data.name} · ${selected.data.sku}`
                : selected.isLoading
                  ? "Loading item…"
                  : "Unavailable item"
              : emptyLabel}
          </span>
          <ChevronsUpDown size={15} />
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
