import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { errorText, formatCents, parseAmount, today } from "../format";
import type { Account, EntrySummary } from "../types";

interface DraftLine {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

let keySeq = 0;

function emptyLine(): DraftLine {
  keySeq += 1;
  return { key: keySeq, accountId: "", debit: "", credit: "", memo: "" };
}

interface Props {
  revision: number;
  onMutated: () => void;
}

export default function JournalPanel({ revision, onMutated }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [entryDate, setEntryDate] = useState(today());
  const [memo, setMemo] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [chart, recent] = await Promise.all([api.listAccounts(), api.listEntries(50)]);
        if (cancelled) return;
        setAccounts(chart.filter((account) => account.isActive && !account.hasChildren));
        setEntries(recent);
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const debitTotal = useMemo(
    () => lines.reduce((sum, line) => sum + (parseAmount(line.debit) ?? 0), 0),
    [lines],
  );
  const creditTotal = useMemo(
    () => lines.reduce((sum, line) => sum + (parseAmount(line.credit) ?? 0), 0),
    [lines],
  );
  const difference = debitTotal - creditTotal;
  const balanced = debitTotal > 0 && difference === 0;

  function updateLine(key: number, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function removeLine(key: number) {
    setLines((current) => (current.length <= 2 ? current : current.filter((line) => line.key !== key)));
  }

  function reset() {
    setLines([emptyLine(), emptyLine()]);
    setMemo("");
    setReference("");
    setEntryDate(today());
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const filled = lines.filter(
      (line) => line.accountId !== "" && (line.debit.trim() !== "" || line.credit.trim() !== ""),
    );
    if (filled.length < 2) {
      setError("a journal entry needs at least two lines with an account and an amount");
      return;
    }

    const payload = [];
    for (const [index, line] of filled.entries()) {
      const debit = line.debit.trim() === "" ? 0 : parseAmount(line.debit);
      const credit = line.credit.trim() === "" ? 0 : parseAmount(line.credit);
      if (debit === null || credit === null) {
        setError(`line ${index + 1}: enter a plain amount such as 125.00`);
        return;
      }
      payload.push({
        accountId: Number(line.accountId),
        debitCents: debit,
        creditCents: credit,
        memo: line.memo.trim() || undefined,
      });
    }

    setBusy(true);
    try {
      const posted = await api.postEntry({
        entryDate,
        memo,
        reference: reference.trim() || undefined,
        source: "MANUAL",
        lines: payload,
      });
      setNotice(`Posted entry #${posted.entryNo} for ${formatCents(posted.totalCents)}`);
      reset();
      onMutated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function voidEntry(entryId: number) {
    setError(null);
    try {
      await api.voidEntry(entryId);
      setNotice("Entry voided — it stays in the audit trail and leaves the books.");
      onMutated();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>New journal entry</h2>
          <span className={`pill ${balanced ? "pill-ok" : "pill-warn"}`}>
            {balanced
              ? `Balanced · ${formatCents(debitTotal)}`
              : `Difference ${formatCents(difference)}`}
          </span>
        </div>

        <form className="form" onSubmit={(event) => void submit(event)}>
          <div className="form-row">
            <label>
              <span>Date</span>
              <input
                type="date"
                value={entryDate}
                onChange={(event) => setEntryDate(event.target.value)}
                required
              />
            </label>
            <label>
              <span>Reference</span>
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Check 1042, INV-118…"
              />
            </label>
            <label className="grow">
              <span>Memo</span>
              <input
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                placeholder="What is this entry for?"
              />
            </label>
          </div>

          <table className="entry-table">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
                <th>Line memo</th>
                <th aria-label="Remove line" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key}>
                  <td>
                    <select
                      value={line.accountId}
                      onChange={(event) => updateLine(line.key, { accountId: event.target.value })
                      }
                    >
                      <option value="">Select an account…</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.number} · {account.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      inputMode="decimal"
                      value={line.debit}
                      placeholder="0.00"
                      onChange={(event) =>
                        updateLine(line.key, { debit: event.target.value, credit: "" })
                      }
                    />
                  </td>
                  <td className="num">
                    <input
                      inputMode="decimal"
                      value={line.credit}
                      placeholder="0.00"
                      onChange={(event) =>
                        updateLine(line.key, { credit: event.target.value, debit: "" })
                      }
                    />
                  </td>
                  <td>
                    <input
                      value={line.memo}
                      onChange={(event) => updateLine(line.key, { memo: event.target.value })}
                      placeholder="Optional"
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon"
                      onClick={() => removeLine(line.key)}
                      aria-label="Remove line"
                      disabled={lines.length <= 2}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => setLines((current) => [...current, emptyLine()])}
                  >
                    Add line
                  </button>
                </td>
                <td className="num strong">{formatCents(debitTotal)}</td>
                <td className="num strong">{formatCents(creditTotal)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>

          {error && <p className="field-error">{error}</p>}
          {notice && <p className="field-notice">{notice}</p>}

          <div className="form-actions">
            <button type="button" className="ghost" onClick={reset} disabled={busy}>
              Clear
            </button>
            <button type="submit" className="primary" disabled={busy || !balanced}>
              {busy ? "Posting…" : "Post entry"}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Recent entries</h2>
          <span className="muted small">{entries.length} shown</span>
        </div>
        {entries.length === 0 ? (
          <p className="muted">No entries yet. Your first balanced entry will appear here.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Memo</th>
                <th>Source</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{entry.entryNo}</td>
                  <td className="mono">{entry.entryDate}</td>
                  <td>
                    {entry.memo || <span className="muted">—</span>}
                    {entry.reference && <span className="tag">{entry.reference}</span>}
                  </td>
                  <td className="muted small">{entry.source}</td>
                  <td className="num mono">{formatCents(entry.totalCents)}</td>
                  <td>
                    <span
                      className={`pill ${
                        entry.status === "POSTED"
                          ? "pill-ok"
                          : entry.status === "VOID"
                            ? "pill-bad"
                            : "pill-muted"
                      }`}
                    >
                      {entry.status}
                    </span>
                  </td>
                  <td>
                    {entry.status !== "VOID" && (
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => void voidEntry(entry.id)}
                      >
                        Void
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
