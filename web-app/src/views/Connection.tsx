import { useEffect, useState } from "react";
import { Copy, Check, Wifi, Download, Radio } from "lucide-react";
import { api } from "../api";
import { ErrorText } from "../components/UI";
export default function Connection() {
  const [connection, setConnection] = useState<any>(null),
    [error, setError] = useState(""),
    [reveal, setReveal] = useState(false),
    [copied, setCopied] = useState("");
  useEffect(() => {
    api("/connection")
      .then(setConnection)
      .catch((e) => setError(e.message));
  }, []);
  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Select and copy the value manually.");
    }
  }
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Connection</h1>
          <p>Connect your print receiver.</p>
        </div>
      </header>
      <ErrorText message={error} />
      {connection && (
        <div className="connection-content">
          <section className="connection-section">
            <div className="section-title">
              <h2>
                <Wifi size={21} />
                Local Wi-Fi
              </h2>
              <span className="status accepted">Ready</span>
            </div>
            <p className="muted">Use the same Wi-Fi on both devices.</p>
            <label>Server address</label>
            {connection.urls.map((url: string) => (
              <div className="copy-field" key={url}>
                <code>{url}</code>
                <button
                  className="icon-button"
                  aria-label="Copy server address"
                  onClick={() => void copy(url, "url")}
                >
                  {copied === "url" ? <Check size={18} /> : <Copy size={18} />}
                </button>
              </div>
            ))}
            {!connection.urls.length && <p>No network address found.</p>}
            <label>Connector key</label>
            <div className="copy-field">
              <code>
                {reveal ? connection.key : "••••••••••••••••••••••••"}
              </code>
              <button
                className="text-button"
                onClick={() => setReveal(!reveal)}
              >
                {reveal ? "Hide" : "Show"}
              </button>
              <button
                className="icon-button"
                aria-label="Copy connector key"
                onClick={() => void copy(connection.key, "key")}
              >
                {copied === "key" ? <Check size={18} /> : <Copy size={18} />}
              </button>
            </div>
          </section>
          <section className="connection-section">
            <h2>
              <Radio size={21} />
              Bluetooth bridge
            </h2>
            <a
              className="download-button"
              href="/downloads/focus-bridge.apk"
              download
            >
              <Download size={17} />
              Download APK
            </a>
            <p>Pair the receiver phone with your CBL tablet.</p>
            <ol>
              <li>Install the receiver on a second Android device.</li>
              <li>Enter the server address and connector key.</li>
              <li>Tap Use printer name SPP-R310, then pair with the tablet.</li>
              <li>
                Start the receiver. In CBL, slide 3 Inches on that device.
              </li>
            </ol>
          </section>
        </div>
      )}
    </>
  );
}
