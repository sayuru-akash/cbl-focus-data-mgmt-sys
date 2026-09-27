"use client";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  Box,
  Link as LinkIcon,
  Users,
  ChartNoAxesCombined,
  Monitor,
  LogOut,
  CheckCircle2,
  X,
} from "lucide-react";
import { api, type Product } from "../api";
import { ErrorText } from "../components/UI";
const StockContext = createContext<{
  products: Product[];
  refresh: () => void;
  notify: (message: string) => void;
}>({ products: [], refresh: () => {}, notify: () => {} });
export const useStock = () => useContext(StockContext);
export default function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10000, retry: 1, refetchOnWindowFocus: true },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Shell>{children}</Shell>
    </QueryClientProvider>
  );
}
function Shell({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const notify = useCallback((message: string) => setNotice({ message }), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const client = useQueryClient(),
    path = usePathname();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () =>
      api<{ authenticated: boolean; setup: boolean; canSetup: boolean }>(
        "/session",
      ),
    retry: false,
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api("/health"),
    refetchInterval: 15000,
  });
  useEffect(() => {
    const refreshSession = () => {
      void client.invalidateQueries({ queryKey: ["session"] });
    };
    window.addEventListener("focus-session-expired", refreshSession);
    return () =>
      window.removeEventListener("focus-session-expired", refreshSession);
  }, [client]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = () => {
    void client.invalidateQueries({
      predicate: (q) => !["session", "health"].includes(String(q.queryKey[0])),
    });
  };
  async function login(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const password = new FormData(e.currentTarget).get("password");
    try {
      await api("/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await session.refetch();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!session.data)
    return (
      <div className="login">
        <div className="brand">
          <span>F</span>Focus
        </div>
        <ErrorText message={session.error?.message || ""} />
        {session.isLoading ? (
          <p>Loading…</p>
        ) : (
          <button onClick={() => void session.refetch()}>Try again</button>
        )}
      </div>
    );
  if (!session.data.authenticated)
    return (
      <div className="login">
        <div className="brand">
          <span>F</span>Focus
        </div>
        <form onSubmit={login}>
          <h1>{session.data.setup ? "Your workspace" : "Welcome back"}</h1>
          <p>Sign in to continue.</p>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={10}
              maxLength={200}
              autoComplete={
                session.data.setup ? "new-password" : "current-password"
              }
            />
          </label>
          <ErrorText message={error} />
          <button
            className="primary"
            disabled={busy || (session.data.setup && !session.data.canSetup)}
          >
            {busy
              ? "Signing in…"
              : session.data.setup
                ? "Create workspace"
                : "Sign in"}
          </button>
        </form>
      </div>
    );
  return (
    <StockContext.Provider value={{ products: [], refresh, notify }}>
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="brand" href="/bills">
            <span>F</span>Focus
          </Link>
          <nav aria-label="Main">
            {[
              { href: "/bills", label: "Bills", Icon: FileText },
              { href: "/stock", label: "Stock", Icon: Box },
              { href: "/finance", label: "Finance", Icon: ChartNoAxesCombined },
              { href: "/customers", label: "Customers", Icon: Users },
              { href: "/connection", label: "Connection", Icon: LinkIcon },
            ].map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={path.startsWith(href) ? "active" : ""}
                aria-current={path.startsWith(href) ? "page" : undefined}
              >
                <Icon size={21} />
                {label}
              </Link>
            ))}
          </nav>
          <div className="workspace">
            <Monitor size={18} />
            <span>Distribution workspace</span>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={async () => {
                try {
                  await api("/logout", { method: "POST" });
                  client.clear();
                  await session.refetch();
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </aside>
        <main id="main">
          <div className="server-status">
            <span className={health.isSuccess ? "online" : ""} />
            {health.isSuccess ? "Server online" : "Server offline"}
          </div>
          <ErrorText message={error} />
          {children}
          {notice && (
            <div
              className="success-notice"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <CheckCircle2 size={20} aria-hidden="true" />
              <span>{notice.message}</span>
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice(null)}
              >
                <X size={17} />
              </button>
            </div>
          )}
        </main>
      </div>
    </StockContext.Provider>
  );
}
