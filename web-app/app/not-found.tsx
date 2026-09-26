import Link from "next/link";
export default function NotFound() {
  return (
    <section className="empty">
      <h1>Page not found</h1>
      <Link href="/bills">Go to bills</Link>
    </section>
  );
}
