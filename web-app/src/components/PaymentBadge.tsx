import { paymentLabels, isPaymentType } from "../../server/payment";
export default function PaymentBadge({ value }: { value?: string | null }) {
  const type = isPaymentType(value) ? value : "unset";
  return (
    <span className={`payment-badge payment-${type}`}>
      {paymentLabels[type]}
    </span>
  );
}
