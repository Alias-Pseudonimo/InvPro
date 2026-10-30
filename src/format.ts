export function formatCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100).toLocaleString("en-US");
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Parse a typed amount into integer cents, or null when it is not one. */
export function parseAmount(input: string): number | null {
  const raw = input.replace(/[$,\s]/g, "");
  if (raw === "" || raw === "-" || raw === ".") return null;
  if (!/^-?\d*(\.\d{0,2})?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function formatTimestamp(value: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}
