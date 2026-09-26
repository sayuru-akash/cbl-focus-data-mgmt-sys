import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { X, Search } from "lucide-react";
export function Empty({
  icon,
  heading,
  children,
}: {
  icon: ReactNode;
  heading: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{heading}</h3>
      <p>{children}</p>
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <div className="search">
      <Search size={18} />
      <input
        aria-label="Search"
        placeholder="Search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className={"modal radix-modal" + (wide ? " modal-wide" : "")}
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <header>
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
            <button
              className="icon-button"
              aria-label="Close"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ErrorText({ message }: { message: string }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}
