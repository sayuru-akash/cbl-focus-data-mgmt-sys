import type { Metadata } from "next";
import { Suspense } from "react";
import Providers from "../src/features/Providers";
import "../src/styles.css";
import "../src/workspace.css";
export const metadata: Metadata = {
  title: { default: "Focus", template: "%s | Focus" },
  description: "Distributor stock and invoice workspace",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Suspense
          fallback={<div className="route-loading">Loading workspace…</div>}
        >
          <Providers>{children}</Providers>
        </Suspense>
      </body>
    </html>
  );
}
