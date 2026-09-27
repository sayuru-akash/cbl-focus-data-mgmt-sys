import { invoiceCosts } from "../../server/intake-costs";
import { lineIssues } from "../../server/intake-validation";
import ProductPicker from "./ProductPicker";
import { useEffect, useRef, useState } from "react";
import {
  Camera,
  Upload,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Check,
  LoaderCircle,
} from "lucide-react";
import { api, type Product } from "../api";
import type { IntakeDraft, IntakeLine } from "../../server/supplier-parser";
import { packFrom } from "../../server/supplier-parser";
import { ErrorText, Modal } from "./UI";
import { useRouter } from "next/navigation";

export type Intake = {
  id: string;
  status: string;
  draft: IntakeDraft;
  revision: number;
  purchase_id?: string;
  processing?: boolean;
  pages: {
    id: string;
    filename: string;
    position: number;
    error: string;
    processed?: number;
  }[];
  issues: string[];
};
const money = (n: number | null) =>
  n === null
    ? "Not read"
    : `Rs ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const numeric = (s: string) => (s === "" ? null : Number(s));
export default function InvoiceIntake({
  id,
  products,
  onClose,
  onSaved,
  inline = false,
}: {
  inline?: boolean;
  id?: string;
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null),
    [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [files, setFiles] = useState<File[]>([]),
    [previews, setPreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [phase, setPhase] = useState("");
  const [loading, setLoading] = useState(Boolean(id));
  const [loadVersion, setLoadVersion] = useState(0);
  const [step, setStep] = useState(-1),
    [page, setPage] = useState(0);
  const review = useRef<HTMLElement>(null);
  const upload = useRef<HTMLInputElement>(null),
    camera = useRef<HTMLInputElement>(null);
  const locked = intake?.status === "received";
  const dirty = intake
    ? JSON.stringify(draft) !== JSON.stringify(intake.draft)
    : files.length > 0;
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const guardLink = (e: MouseEvent) => {
      const link = (e.target as Element).closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      if (link.target === "_blank" || link.hasAttribute("download")) return;
      if (link.href === window.location.href) return;
      e.preventDefault();
      e.stopPropagation();
      if (!busy) {
        const destination = new URL(link.href);
        setLeaveAction(() => () => {
          if (destination.origin === window.location.origin)
            router.push(
              destination.pathname + destination.search + destination.hash,
            );
          else window.location.assign(destination.href);
        });
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLink, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardLink, true);
    };
  }, [dirty, busy, router]);
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  useEffect(() => {
    if (id) {
      setLoading(true);
      setError("");
      api<Intake>(`/intakes/${id}`)
        .then((i) => {
          setIntake(i);
          setDraft(i.draft);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }
  }, [id, loadVersion]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      review.current?.scrollIntoView({ block: "start", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [step]);
  function navigateStep(next: number) {
    if (!draft || busy) return;
    setStep(next);
    if (draft.lines[next]) setPage(draft.lines[next]!.page);
  }
  function apply(i: Intake) {
    setIntake(i);
    setDraft(i.draft);
  }
  function header(values: Partial<IntakeDraft>) {
    setDraft((d) => (d ? { ...d, ...values, headerReviewed: false } : d));
  }
  function change(index: number, values: Partial<IntakeLine>) {
    setDraft((d) =>
      d
        ? {
            ...d,
            lines: d.lines.map((l, i) =>
              i === index ? { ...l, ...values, reviewed: false } : l,
            ),
          }
        : d,
    );
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function process() {
    if (busy) return;
    await run(async () => {
      let current = intake;
      if (!current) {
        setPhase(`Uploading ${files.length} photos…`);
        const form = new FormData();
        files.forEach((f) => form.append("pages", f));
        current = await api<Intake>("/intakes", { method: "POST", body: form });
        apply(current);
        onSaved();
      }
      if (current.status === "received" || current.draft.lines.length) {
        apply(current);
        setMessage("Opened the existing invoice.");
        if (!id) router.replace(`/stock/invoices/${current.id}`);
        return;
      }
      setPhase(`Reading ${current.pages.length} pages…`);
      apply(
        await api<Intake>(`/intakes/${current.id}/process`, { method: "POST" }),
      );
      onSaved();
      setStep(-1);
      setPage(0);
      if (!id) router.replace(`/stock/invoices/${current.id}`);
    });
  }
  useEffect(() => {
    if (!busy || !intake || intake.draft.lines.length) return;
    let stopped = false;
    const poll = async () => {
      try {
        const progress = await api<Intake>(`/intakes/${intake.id}`);
        if (!stopped) {
          const read = progress.pages.filter((p) => p.processed).length;
          setPhase(
            read === progress.pages.length
              ? "Building invoice draft…"
              : `Reading page ${read + 1} of ${progress.pages.length}…`,
          );
        }
      } catch {
        /* The upload/processing request reports actionable errors. */
      }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [busy, intake?.id]);
  async function save(next = draft) {
    if (!intake || !next) return;
    const result = await api<Intake>(`/intakes/${intake.id}`, {
      method: "PUT",
      body: JSON.stringify({ revision: intake.revision, draft: next }),
    });
    apply(result);
    onSaved();
    return result;
  }
  async function confirm() {
    await run(async () => {
      if (!draft) return;
      if (step < 0) {
        await save({ ...draft, headerReviewed: true });
        setStep(0);
        setPage(draft.lines[0]?.page || 0);
      } else {
        const problems = lineIssues(draft.lines[step]!);
        if (problems.length) throw new Error(problems.join(". "));
        await save({
          ...draft,
          lines: draft.lines.map((l, i) =>
            i === step ? { ...l, reviewed: true } : l,
          ),
        });
        setStep(step + 1);
        setPage(draft.lines[step + 1]?.page || page);
      }
    });
  }
  const row = draft?.lines[step];
  const cost = draft ? invoiceCosts(draft)?.[step] : null;
  const ready = Boolean(draft && step >= draft.lines.length && step >= 0);
  const photo = intake?.pages[page];
  function choose(next: FileList | null) {
    // FileList is live. Snapshot it before the input is reset below.
    const selected = Array.from(next || []);
    if (!selected.length) return;
    const combined = [...files, ...selected];
    if (
      selected.some(
        (f) =>
          !["image/jpeg", "image/png", "image/webp"].includes(f.type) ||
          !f.size ||
          f.size > 12 * 1024 * 1024,
      )
    ) {
      setError("Choose JPG, PNG or WebP photos, up to 12 MB each.");
      return;
    }
    if (
      combined.length > 20 ||
      combined.reduce((n, f) => n + f.size, 0) > 60 * 1024 * 1024
    ) {
      setError("Choose up to 20 photos and 60 MB per invoice.");
      return;
    }
    if (
      new Set(combined.map((f) => `${f.name}:${f.size}:${f.lastModified}`))
        .size !== combined.length
    ) {
      setError(
        "That photo is already selected. Each page is needed only once.",
      );
      return;
    }
    setFiles(combined);
    setError("");
  }
  const Frame = inline ? IntakePage : Modal;
  return (
    <>
      <Frame
        title={locked ? "Received invoice" : "Receive invoice"}
        wide
        onClose={() => {
          if (busy) return;
          if (dirty) setLeaveAction(() => onClose);
          else onClose();
        }}
      >
        <div className="invoice-intake">
          {loading ? (
            <p role="status" className="muted">
              Loading invoice…
            </p>
          ) : !intake && id ? (
            <button onClick={() => setLoadVersion((n) => n + 1)}>
              Try again
            </button>
          ) : !intake ? (
            <>
              <p className="muted">
                Choose every page, then process the invoice.
              </p>
              <small className="muted">
                JPG, PNG or WebP · 12 MB per photo · 20 pages / 60 MB total
              </small>
              <input
                ref={upload}
                hidden
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(e) => {
                  choose(e.target.files);
                  e.target.value = "";
                }}
              />
              <input
                ref={camera}
                hidden
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  choose(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="intake-upload-actions">
                <button onClick={() => camera.current?.click()} disabled={busy}>
                  <Camera size={18} />
                  Take photo
                </button>
                <button onClick={() => upload.current?.click()} disabled={busy}>
                  <Upload size={18} />
                  Upload photos
                </button>
              </div>
              {files.length > 0 && (
                <div className="intake-selection" role="status">
                  <strong>
                    {files.length} {files.length === 1 ? "photo" : "photos"}{" "}
                    selected
                  </strong>
                  <span>
                    {(
                      files.reduce((n, f) => n + f.size, 0) /
                      1024 /
                      1024
                    ).toFixed(1)}{" "}
                    MB · {busy ? "Uploading…" : "Ready to process"}
                  </span>
                </div>
              )}
              <div className="intake-thumbnails">
                {files.map((f, i) => (
                  <figure key={`${f.name}-${i}`}>
                    <img src={previews[i]} alt={`Invoice page ${i + 1}`} />
                    <figcaption>
                      {i + 1}. {f.name}
                      <br />
                      <span className="muted">
                        {(f.size / 1024 / 1024).toFixed(1)} MB
                      </span>
                    </figcaption>
                    <button
                      aria-label={`Remove photo ${i + 1}`}
                      className="icon-button"
                      disabled={busy}
                      onClick={() => setFiles(files.filter((_, n) => i !== n))}
                    >
                      <Trash2 size={16} />
                    </button>
                  </figure>
                ))}
              </div>
              <div className="modal-actions">
                <button
                  className="primary"
                  disabled={!files.length || busy}
                  onClick={() => void process()}
                >
                  {busy
                    ? phase
                    : `Process${files.length ? ` ${files.length} photos` : " invoice"}`}
                </button>
              </div>
            </>
          ) : !draft?.pages.length ? (
            <>
              <div
                className="intake-selection"
                role="status"
                aria-live="polite"
              >
                {busy && <LoaderCircle size={20} className="intake-spinner" />}
                <strong>{busy ? phase : "Photos saved"}</strong>
                <span>
                  {busy
                    ? "Keep this page open while the draft is prepared."
                    : "Process the photos to build the draft."}
                </span>
              </div>
              {intake.pages.map((p) => (
                <p key={p.id}>
                  {p.filename}
                  {p.error ? ` · ${p.error}` : ""}
                </p>
              ))}
              <button
                className="primary"
                disabled={busy}
                onClick={() => void process()}
              >
                {busy ? "Processing…" : "Process photos"}
              </button>
            </>
          ) : (
            <>
              <nav
                className="intake-progress intake-navigation"
                aria-label="Invoice review"
              >
                <button
                  aria-label="Previous item"
                  disabled={busy || step < 0}
                  onClick={() => navigateStep(step - 1)}
                >
                  <ChevronLeft size={18} />
                  <span>Previous</span>
                </button>
                <select
                  aria-label="Review step"
                  value={step}
                  disabled={busy}
                  onChange={(e) => navigateStep(Number(e.target.value))}
                >
                  <option value={-1}>Invoice details</option>
                  {draft.lines.map((line, i) => (
                    <option value={i} key={line.id}>
                      Item {i + 1} of {draft.lines.length}
                      {line.reviewed ? " ✓" : ""}
                    </option>
                  ))}
                  <option value={draft.lines.length}>Review summary</option>
                </select>
                <span className="intake-checked">
                  {draft.lines.filter((l) => l.reviewed).length}/
                  {draft.lines.length} checked
                </span>
                <button
                  className="primary"
                  disabled={busy || ready}
                  onClick={() => navigateStep(step + 1)}
                >
                  Next <ChevronRight size={18} />
                </button>
              </nav>
              <div className="intake-layout">
                <aside className="intake-source">
                  <label>
                    Source page
                    <select
                      value={page}
                      onChange={(e) => setPage(Number(e.target.value))}
                    >
                      {intake.pages.map((p, i) => (
                        <option key={p.id} value={i}>
                          Photo {i + 1} ·{" "}
                          {draft.pages[i]?.document || p.filename}
                        </option>
                      ))}
                    </select>
                  </label>
                  {photo && (
                    <a
                      href={`/api/intakes/${intake.id}/pages/${photo.id}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open full-size photo"
                    >
                      <img
                        src={`/api/intakes/${intake.id}/pages/${photo.id}`}
                        alt={`Invoice source photo ${page + 1}`}
                      />
                    </a>
                  )}
                  {photo && (
                    <a
                      className="text-button"
                      href={`/api/intakes/${intake.id}/pages/${photo.id}/original`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Original photo
                    </a>
                  )}
                </aside>
                <section className="intake-review" ref={review}>
                  {step < 0 ? (
                    <>
                      <h3>Invoice details</h3>
                      <div className="fields two">
                        <label>
                          Supplier
                          <input
                            disabled={busy || locked}
                            value={draft.supplier}
                            onChange={(e) =>
                              header({ supplier: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          Supplier TIN
                          <input
                            disabled={busy || locked}
                            value={draft.tin}
                            onChange={(e) => header({ tin: e.target.value })}
                          />
                        </label>
                      </div>
                      <div className="fields two">
                        <label>
                          Tax invoice number
                          <input
                            disabled={busy || locked}
                            value={draft.number}
                            onChange={(e) => header({ number: e.target.value })}
                          />
                        </label>
                        <label>
                          Invoice date
                          <input
                            type="date"
                            disabled={busy || locked}
                            value={draft.date}
                            onChange={(e) => header({ date: e.target.value })}
                          />
                        </label>
                      </div>
                      <h4>Page {page + 1}</h4>
                      <div className="fields two">
                        {(
                          [
                            ["invoice", "Tax invoice on page"],
                            ["document", "Document number"],
                          ] as const
                        ).map(([field, label]) => (
                          <label key={field}>
                            {label}
                            <input
                              disabled={busy || locked}
                              value={draft.pages[page]![field]}
                              onChange={(e) =>
                                header({
                                  pages: draft.pages.map((p, i) =>
                                    i === page
                                      ? {
                                          ...p,
                                          [field]: e.target.value,
                                          reviewed: false,
                                        }
                                      : p,
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <div className="fields two">
                        {(
                          [
                            ["page", "Printed page"],
                            ["count", "Total pages"],
                          ] as const
                        ).map(([field, label]) => (
                          <label key={field}>
                            {label}
                            <input
                              type="number"
                              min="1"
                              max="20"
                              disabled={busy || locked}
                              value={draft.pages[page]![field] ?? ""}
                              onChange={(e) =>
                                header({
                                  pages: draft.pages.map((p, i) =>
                                    i === page
                                      ? {
                                          ...p,
                                          [field]: numeric(e.target.value),
                                          reviewed: false,
                                        }
                                      : p,
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <label className="intake-check">
                        <input
                          type="checkbox"
                          disabled={busy || locked}
                          checked={draft.pages[page]!.reviewed}
                          onChange={(e) =>
                            header({
                              pages: draft.pages.map((p, i) =>
                                i === page
                                  ? { ...p, reviewed: e.target.checked }
                                  : p,
                              ),
                            })
                          }
                        />
                        Page details checked against photo
                      </label>
                      <div className="fields three">
                        {(
                          [
                            ["gross", "Order value"],
                            ["discount", "Discount"],
                            ["total", "Invoice total"],
                          ] as const
                        ).map(([field, label]) => (
                          <label key={field}>
                            {label}
                            <input
                              type="number"
                              min="0"
                              step=".01"
                              disabled={busy || locked}
                              value={draft[field] ?? ""}
                              onChange={(e) =>
                                header({ [field]: numeric(e.target.value) })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <p className="muted">
                        Line amounts include VAT. Invoice discount is shared
                        across items by value.
                      </p>
                      {!locked && (
                        <button
                          className="primary"
                          disabled={
                            busy || draft.pages.some((p) => !p.reviewed)
                          }
                          onClick={() => void confirm()}
                        >
                          Confirm invoice details
                        </button>
                      )}
                    </>
                  ) : row ? (
                    <>
                      <div className="intake-row-heading">
                        <h3>
                          Item {step + 1} of {draft.lines.length}
                        </h3>
                        <span>{row.reviewed ? "Checked" : "To review"}</span>
                      </div>
                      <div className="intake-item-identity">
                        <h4>
                          {row.description || "Check product description"}
                        </h4>
                        <span>
                          {row.code || "Missing code"}
                          {row.weight ? ` · ${row.weight}` : ""}
                        </span>
                      </div>
                      <p className="intake-calculation">
                        {row.sold ?? "?"} {row.unit} × {row.packSize ?? "?"} ={" "}
                        <strong>
                          {row.sold && row.packSize
                            ? row.sold * row.packSize
                            : "?"}{" "}
                          packets
                        </strong>
                      </p>
                      <div className="intake-item-facts">
                        <span>
                          Boxes <strong>{row.boxes ?? "?"}</strong>
                        </span>
                        <span>
                          Price / {row.unit || "unit"}{" "}
                          <strong>{money(row.unitPrice)}</strong>
                        </span>
                        <span>
                          Line total <strong>{money(row.amount)}</strong>
                        </span>
                      </div>
                      <label>
                        Packet MRP
                        <input
                          type="number"
                          min=".01"
                          step=".01"
                          placeholder="From packaging"
                          disabled={busy || locked}
                          value={row.mrp ?? ""}
                          onChange={(e) =>
                            change(step, { mrp: numeric(e.target.value) })
                          }
                        />
                      </label>
                      <label>
                        Stock item
                        <ProductPicker
                          packetsOnly
                          showStock
                          mrp={row.mrp}
                          label="Stock item"
                          disabled={busy || locked}
                          value={row.productId}
                          onChange={(productId) => change(step, { productId })}
                          emptyLabel="New product for this code"
                        />
                        {!locked && row.productId && (
                          <small>
                            Same item, including size and flavour. New prices
                            stay in separate batches.
                          </small>
                        )}
                      </label>
                      <details className="intake-edit-details" key={row.id}>
                        <summary>Edit extracted details</summary>
                        <label>
                          Product code
                          <input
                            disabled={busy || locked}
                            value={row.code}
                            onChange={(e) =>
                              change(step, {
                                code: e.target.value,
                                productId: "",
                              })
                            }
                          />
                        </label>
                        <label>
                          Description
                          <textarea
                            disabled={busy || locked}
                            rows={2}
                            value={row.description}
                            onChange={(e) => {
                              const pack = packFrom(e.target.value, row.unit);
                              change(step, {
                                description: e.target.value,
                                packSize: pack.size,
                                packEvidence: pack.evidence,
                              });
                            }}
                          />
                        </label>
                        <label>
                          Packet weight / volume
                          <input
                            value={row.weight}
                            placeholder="e.g. 480G"
                            disabled={busy || locked}
                            onChange={(e) =>
                              change(step, { weight: e.target.value })
                            }
                          />
                        </label>

                        <div className="fields three">
                          <label>
                            Boxes
                            <input
                              type="number"
                              min="0"
                              step=".001"
                              disabled={busy || locked}
                              value={row.boxes ?? ""}
                              onChange={(e) =>
                                change(step, { boxes: numeric(e.target.value) })
                              }
                            />
                          </label>
                          <label>
                            Sold quantity
                            <input
                              type="number"
                              min="0"
                              step=".001"
                              disabled={busy || locked}
                              value={row.sold ?? ""}
                              onChange={(e) =>
                                change(step, { sold: numeric(e.target.value) })
                              }
                            />
                          </label>
                          <label>
                            Invoice unit
                            <select
                              disabled={busy || locked}
                              value={row.unit}
                              onChange={(e) => {
                                const pack = packFrom(
                                  row.description,
                                  e.target.value,
                                );
                                change(step, {
                                  unit: e.target.value,
                                  packSize: pack.size,
                                  packEvidence: pack.evidence,
                                });
                              }}
                            >
                              <option value="">Choose unit</option>
                              {["DZ", "MC", "PKT", "EA", "PCS"].map((u) => (
                                <option key={u} value={u}>
                                  {u === "MC"
                                    ? "MC (carton)"
                                    : u === "DZ"
                                      ? "DZ (12 packets)"
                                      : `${u} (1 packet)`}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="fields two">
                          <label>
                            Packets per {row.unit}
                            <input
                              type="number"
                              min="1"
                              max="10000"
                              step="1"
                              disabled={busy || locked || row.unit !== "MC"}
                              value={row.packSize ?? ""}
                              onChange={(e) =>
                                change(step, {
                                  packSize: numeric(e.target.value),
                                  packEvidence: "Confirmed from source photo",
                                })
                              }
                            />
                          </label>
                        </div>

                        <small className="muted">
                          {row.packEvidence}
                          {row.unit === "MC" &&
                            ". Packets in one carton, not packet weight."}
                        </small>
                        <div className="fields two">
                          <label>
                            Purchase price per {row.unit || "invoice unit"}
                            <input
                              type="number"
                              min="0"
                              step=".01"
                              disabled={busy || locked}
                              value={row.unitPrice ?? ""}
                              onChange={(e) =>
                                change(step, {
                                  unitPrice: numeric(e.target.value),
                                })
                              }
                            />
                          </label>
                          <label>
                            Line amount (VAT incl.)
                            <input
                              type="number"
                              min="0"
                              step=".01"
                              disabled={busy || locked}
                              value={row.amount ?? ""}
                              onChange={(e) =>
                                change(step, {
                                  amount: numeric(e.target.value),
                                })
                              }
                            />
                          </label>
                        </div>
                        {!locked && (
                          <button
                            className="text-button danger-text"
                            disabled={busy}
                            onClick={() => {
                              setDraft({
                                ...draft,
                                headerReviewed: false,
                                lines: draft.lines.filter((_, i) => i !== step),
                              });
                              setStep((s) => Math.max(0, s - 1));
                            }}
                          >
                            Remove misread row
                          </button>
                        )}
                      </details>
                      <div className="intake-cost" aria-label="Purchase cost">
                        <span>
                          Purchase cost / packet{" "}
                          <strong>{money(cost?.costPrice ?? null)}</strong>
                        </span>
                        <small>
                          {cost
                            ? `VAT included · Invoice discount: ${money(cost.discountCents / 100)}`
                            : "Check quantities and invoice totals to calculate cost."}
                        </small>
                      </div>
                      {!locked && (
                        <p className="muted">
                          {lineIssues(row)
                            .filter((issue) => issue !== "Enter packet MRP")
                            .join(". ")}
                        </p>
                      )}
                      {!locked && (
                        <button
                          className="primary"
                          disabled={
                            busy ||
                            !row.code ||
                            !row.description ||
                            !row.sold ||
                            !row.packSize ||
                            !row.mrp ||
                            row.amount === null ||
                            row.unitPrice === null
                          }
                          onClick={() => void confirm()}
                        >
                          <Check size={16} />
                          Confirm and next
                        </button>
                      )}
                    </>
                  ) : ready ? (
                    <>
                      <h3>{locked ? "Stock received" : "Review summary"}</h3>
                      <p>{draft.number}</p>
                      <strong>{money(draft.total)}</strong>
                      <div className="intake-summary">
                        {draft.lines.map((l, i) => (
                          <button
                            key={l.id}
                            onClick={() => {
                              setStep(i);
                              setPage(l.page);
                            }}
                          >
                            <span>
                              {l.reviewed ? <Check size={15} /> : i + 1}
                            </span>
                            <span>
                              <strong>{l.code || "Missing code"}</strong>
                              {l.description}
                            </span>
                            <span>
                              {l.sold && l.packSize ? l.sold * l.packSize : "?"}{" "}
                              PKT
                              <br />
                              MRP {l.mrp ?? "?"}
                            </span>
                          </button>
                        ))}
                      </div>
                      {!locked && (
                        <>
                          <p className="muted">
                            Stock is added once, after every page and item is
                            checked.
                          </p>
                          <button
                            className="primary"
                            disabled={busy || intake.issues.length > 0}
                            onClick={() =>
                              void run(async () => {
                                const saved = await save();
                                if (saved) {
                                  apply(
                                    await api<Intake>(
                                      `/intakes/${intake.id}/receive`,
                                      {
                                        method: "POST",
                                        body: JSON.stringify({
                                          revision: saved.revision,
                                        }),
                                      },
                                    ),
                                  );
                                  onSaved();
                                  setMessage("Stock received.");
                                }
                              })
                            }
                          >
                            Confirm and add stock
                          </button>
                          {intake.issues.length > 0 && (
                            <ul className="intake-issues">
                              {intake.issues.map((issue, i) => (
                                <li key={i}>{issue}</li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </>
                  ) : null}
                </section>
              </div>
              <div className="intake-footer">
                {!locked && (
                  <div>
                    <button
                      disabled={busy}
                      onClick={() => {
                        const line: IntakeLine = {
                          id: crypto.randomUUID(),
                          page,
                          code: "",
                          description: "",
                          weight: "",
                          boxes: null,
                          sold: null,
                          unit: "MC",
                          unitPrice: null,
                          amount: null,
                          packSize: null,
                          packEvidence: "",
                          mrp: null,
                          productId: "",
                          reviewed: false,
                        };
                        setDraft({
                          ...draft,
                          headerReviewed: false,
                          lines: [...draft.lines, line],
                        });
                        setStep(draft.lines.length);
                      }}
                    >
                      <Plus size={15} />
                      Missing row
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await save();
                          setMessage("Draft saved.");
                        })
                      }
                    >
                      Save draft
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          <ErrorText message={error} />
          {message && (
            <p className="notice" role="status">
              {message}
            </p>
          )}
        </div>
      </Frame>
      {leaveAction && (
        <Modal title="Unsaved changes" onClose={() => setLeaveAction(null)}>
          <p>Save the draft before leaving to keep your changes.</p>
          <div className="actions">
            <button onClick={() => setLeaveAction(null)}>Keep editing</button>
            <button
              onClick={() => {
                const leave = leaveAction;
                setLeaveAction(null);
                leave();
              }}
            >
              Leave without saving
            </button>
            {intake && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await save();
                    const leave = leaveAction;
                    setLeaveAction(null);
                    leave();
                  })
                }
              >
                Save and leave
              </button>
            )}
          </div>
          <ErrorText message={error} />
        </Modal>
      )}
    </>
  );
}

function IntakePage({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section className="invoice-page">
      <header className="page-header">
        <h1>{title}</h1>
        <button onClick={onClose}>Back to stock in</button>
      </header>
      {children}
    </section>
  );
}
