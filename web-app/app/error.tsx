"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="empty">
      <h1>Unable to load this page</h1>
      <button onClick={reset}>Try again</button>
    </section>
  );
}
