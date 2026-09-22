import { useEffect, useState } from "react";
import { FileText, Box, Link, Monitor, LogOut } from "lucide-react";
import { api, type Product } from "./api";
import { ErrorText } from "./components/UI";
import Bills from "./pages/Bills";
import Stock from "./pages/Stock";
import Connection from "./pages/Connection";
export default function App() {
  const [session, setSession] = useState<any>(null),
    [page, setPage] = useState("Bills"),
    [products, setProducts] = useState<Product[]>([]),
    [error, setError] = useState(""),
    [online, setOnline] = useState(false),
    [busy, setBusy] = useState(false);
  const refreshStock = () => {
    api<Product[]>("/products")
      .then(setProducts)
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    api("/session")
      .then(setSession)
      .catch((e) => setError(e.message));
    const ping = () =>
      api("/health")
        .then(() => setOnline(true))
        .catch(() => setOnline(false));
    void ping();
    const t = setInterval(ping, 10000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (session?.authenticated) refreshStock();
  }, [session]);
  async function login(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/login", {
        method: "POST",
        body: JSON.stringify({
          password: new FormData(e.currentTarget).get("password"),
        }),
      });
      setSession(await api("/session"));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!session)
    return (
      <div className="login">
        <div className="brand">
          <span>F</span>Focus
        </div>
        <ErrorText message={error} />
        {!error && <p>Loading…</p>}
      </div>
    );
  if (!session.authenticated)
    return (
      <div className="login">
        <div className="brand">
          <span>F</span>Focus
        </div>
        <form onSubmit={login}>
          <h1>{session.setup ? "Your workspace" : "Welcome back"}</h1>
          <p>
            {session.setup
              ? "Set a password to get started."
              : "Sign in to continue."}
          </p>
          <label>
            Password
            <input
              autoFocus
              type="password"
              name="password"
              minLength={10}
              maxLength={200}
              required
              autoComplete={session.setup ? "new-password" : "current-password"}
            />
          </label>
          {session.setup && <small>At least 10 characters.</small>}
          <ErrorText message={error} />
          <button
            className="primary"
            disabled={busy || (session.setup && !session.canSetup)}
          >
            {busy
              ? "Please wait…"
              : session.setup
                ? "Create workspace"
                : "Sign in"}
          </button>
          {session.setup && !session.canSetup && (
            <p>Open localhost on the server computer to set up.</p>
          )}
        </form>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Bills");
          }}
        >
          <span>F</span>Focus
        </a>
        <nav aria-label="Main">
          {[
            { name: "Bills", Icon: FileText },
            { name: "Stock", Icon: Box },
            { name: "Connection", Icon: Link },
          ].map(({ name, Icon }) => (
            <button
              key={name}
              className={page === name ? "active" : ""}
              onClick={() => {
                setPage(name);
                setError("");
              }}
            >
              <Icon size={23} />
              {name}
            </button>
          ))}
        </nav>
        <div className="workspace">
          <Monitor size={19} />
          <span>Local workspace</span>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={async () => {
              try {
                await api("/logout", { method: "POST" });
                setSession(await api("/session"));
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main>
        <div className="server-status">
          <span className={online ? "online" : ""} />
          {online ? "Receiver online" : "Receiver offline"}
        </div>
        <ErrorText message={error} />
        {page === "Bills" ? (
          <Bills products={products} refreshStock={refreshStock} />
        ) : page === "Stock" ? (
          <Stock products={products} refresh={refreshStock} />
        ) : (
          <Connection />
        )}
      </main>
    </div>
  );
}
