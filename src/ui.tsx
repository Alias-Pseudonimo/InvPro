import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorText, formatCents } from "./format";

/** Money shown the way a business owner reads it. */
export function money(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${formatCents(Math.abs(cents))}`;
}

export function moneyShort(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${formatCents(Math.abs(cents))}`;
}

export function centsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function qtyInput(hundredths: number): string {
  return (hundredths / 100).toFixed(2).replace(/\.00$/, "");
}

export function toCents(value: FormDataEntryValue | null): number {
  const raw = String(value ?? "").replace(/[$,\s]/g, "");
  if (!raw || raw === "-" || raw === ".") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function toHundredths(value: FormDataEntryValue | null): number {
  const raw = String(value ?? "").replace(/,/g, "");
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const value = await loader();
      setData(value);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={wide ? "modal modal-wide" : "modal"} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Pill({ tone, children }: { tone: "paid" | "unpaid" | "draft"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="card stat-tile">
      <div className="label">{label}</div>
      <div className={tone ? `value ${tone}` : "value"}>{value}</div>
      {hint && <div className="delta">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ text }: { text: string }) {
  return <div className="field-error">{text}</div>;
}

export function submitHandler(
  action: (form: FormData) => Promise<void>,
  setError: (value: string | null) => void,
  onDone: () => void,
) {
  return async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      setError(null);
      await action(form);
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };
}
