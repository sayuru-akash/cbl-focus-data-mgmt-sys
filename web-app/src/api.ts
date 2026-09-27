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
  if (!r.ok) {
    if (r.status === 401 && path !== "/login" && typeof window !== "undefined")
      window.dispatchEvent(new Event("focus-session-expired"));
    throw new Error(data.error || "Request failed");
  }
  return data;
}
export type Product = {
  supplierCodes?: { tin: string; code: string }[];
  archived?: number;
  id: string;
  sku: string;
  name: string;
  unit: string;
  stock: number;
  minimum: number;
  lots: {
    id: string;
    remaining: number;
    received_qty: number;
    costPrice: number | null;
    mrp: number | null;
    received: string;
    purchase_id?: string | null;
  }[];
};
export type Item = {
  createReturnProduct?: boolean;
  productId: string;
  quantity: number;
  sourceLine?: number;
  mrp?: number | null;
  sellingPrice?: number | null;
};
export type PurchaseLine = {
  productId: string;
  newProduct?: { sku: string; name: string; unit: string };
  quantity: number;
  costPrice: number | null;
  mrp: number | null;
  billLine?: number;
};
export type Purchase = {
  id?: string;
  number: string;
  supplier: string;
  received: string;
  status?: "draft" | "received";
  lines: PurchaseLine[];
  note: string;
  created?: string;
};
export type Bill = {
  payment_type?: import("../server/payment").PaymentType | null;
  revision: number;
  id: string;
  filename: string;
  mime: string;
  source: string;
  received: string;
  status: "pending" | "accepted" | "rejected";
  decided?: string | null;
  number: string;
  shop: string;
  items: Item[];
  note: string;
  preview?: string;
  originalReceipt?: import("../server/receipt").Receipt | null;
  receipt?: import("../server/receipt").Receipt | null;
};
export const date = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
