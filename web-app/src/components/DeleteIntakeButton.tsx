import { useStock } from "../features/Providers";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "../api";
import { ErrorText, Modal } from "./UI";

export default function DeleteIntakeButton({
  id,
  disabled = false,
  onDeleted,
}: {
  id: string;
  disabled?: boolean;
  onDeleted: () => void;
}) {
  const { notify } = useStock();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [draft, setDraft] = useState<{
    revision: number;
    number: string;
  } | null>(null);
  async function inspect() {
    setOpen(true);
    setBusy(true);
    setError("");
    setConfirmation("");
    setDraft(null);
    try {
      const record = await api<any>(`/intakes/${id}`);
      if (record.status !== "draft" || record.purchase_id)
        throw new Error("Received invoices cannot be deleted");
      if (record.processing)
        throw new Error("Wait for photo processing to finish before deleting");
      setDraft({
        revision: record.revision,
        number: record.draft.number || "Invoice photos",
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!draft || busy || confirmation !== "DELETE") return;
    setBusy(true);
    setError("");
    try {
      await api(`/intakes/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: draft.revision, confirmation }),
      });
      setOpen(false);
      notify("Draft deleted.");
      onDeleted();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="icon-button danger-text"
        aria-label="Delete draft"
        title="Delete draft"
        disabled={disabled || busy}
        onClick={() => void inspect()}
      >
        <Trash2 size={18} />
      </button>
      {open && (
        <Modal
          title="Delete draft?"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          {draft && (
            <>
              <p>
                <strong>{draft.number}</strong>
              </p>
              <p>
                This permanently deletes the draft and its photos. Stock will
                not change.
              </p>
              <label>
                Type DELETE to confirm
                <input
                  autoComplete="off"
                  value={confirmation}
                  disabled={busy}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
            </>
          )}
          {busy && !draft && <p role="status">Checking draft…</p>}
          <ErrorText message={error} />
          <div className="actions">
            <button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="danger"
              disabled={busy || !draft || confirmation !== "DELETE"}
              onClick={() => void remove()}
            >
              {busy && draft ? "Deleting…" : "Delete draft"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
