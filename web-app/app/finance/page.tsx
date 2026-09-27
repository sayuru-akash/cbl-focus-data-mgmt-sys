import type { Metadata } from "next";
import Finance from "../../src/features/Finance";
export const metadata: Metadata = { title: "Finance" };
export default function Page() {
  return <Finance />;
}
