export const paymentTypes = ["cash", "cheque", "credit"] as const;
export type PaymentType = (typeof paymentTypes)[number];
export const paymentLabels: Record<PaymentType | "unset", string> = {
  cash: "Cash",
  cheque: "Cheque",
  credit: "Credit",
  unset: "Not set",
};
export function isPaymentType(value: unknown): value is PaymentType {
  return paymentTypes.includes(value as PaymentType);
}
