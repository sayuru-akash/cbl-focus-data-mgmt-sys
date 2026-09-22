export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const r = await fetch("/api" + path, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
export type Product = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  stock: number;
  minimum: number;
  lots: { id: string; remaining: number; received_qty: number; costPrice: number | null; mrp: number | null; received: string }[];
};
export type Item = { productId: string; quantity: number; sourceLine?: number; mrp?: number | null; sellingPrice?: number | null };
export type PurchaseLine = { productId: string; newProduct?: {sku:string;name:string;unit:string}; quantity:number; costPrice:number|null; mrp:number|null; billLine?:number };
export type Purchase = { id?:string; number:string; supplier:string; received:string; status?:"draft"|"received"; lines:PurchaseLine[]; note:string; created?:string };
export type Bill = {
  id: string;
  filename: string;
  mime: string;
  source: string;
  received: string;
  status: "pending" | "accepted" | "rejected";
  number: string;
  shop: string;
  items: Item[];
  note: string;
  preview?: string;
  receipt?: import("../server/receipt").Receipt | null;
};
export const date = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
