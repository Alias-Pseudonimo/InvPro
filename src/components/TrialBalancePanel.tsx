import { useEffect, useState } from "react";
import { api } from "../api";
import { errorText, formatCents } from "../format";
import type { TrialBalanceReport } from "../types";

export default function TrialBalancePanel({ revision }: { revision: number }) {
  const [report, setReport] = useState<TrialBalanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.trialBalance();
        if (!cancelled) setReport(next);
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Trial balance</h2>
          {report && (
            <span className={`pill ${report.isBalanced ? "pill-ok" : "pill-bad"}`}>
              {report.isBalanced ? "Debits equal credits" : "Out of balance"}
            </span>
          )}
        </div>

        {error && <p className="field-error">{error}</p>}
        {!report && !error && <p className="muted">Building report…</p>}

        {report && report.rows.length === 0 && (
          <p className="muted">
            Nothing posted yet. Post a journal entry and its balances will show up here.
          </p>
        )}

        {report && report.rows.length > 0 && (
          <table className="data-table report">
            <thead>
              <tr>
                <th>Account</th>
                <th>Name</th>
                <th>Type</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.accountId}>
                  <td className="mono">{row.number}</td>
                  <td>{row.name}</td>
                  <td className="muted small">{row.accountType}</td>
                  <td className="num mono">{row.debitCents ? formatCents(row.debitCents) : "—"}</td>
                  <td className="num mono">{row.creditCents ? formatCents(row.creditCents) : "—"}</td>
                  <td className="num mono strong">{formatCents(row.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="strong">
                  Totals
                </td>
                <td className="num mono strong">{formatCents(report.totalDebitCents)}</td>
                <td className="num mono strong">{formatCents(report.totalCreditCents)}</td>
                <td className="num mono">
                  {formatCents(report.totalDebitCents - report.totalCreditCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </div>
  );
}
