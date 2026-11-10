import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { errorText, formatTimestamp } from "../format";
import type { AuditRow, ChainReport } from "../types";

const ACTION_CLASS: Record<string, string> = {
  INSERT: "pill-ok",
  UPDATE: "pill-warn",
  DELETE: "pill-bad",
};

export default function AuditPanel({ revision }: { revision: number }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [chain, setChain] = useState<ChainReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [log, report] = await Promise.all([api.listAudit(200), api.verifyAudit()]);
      setRows(log);
      setChain(report);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Audit trail</h2>
          <div className="card-actions">
            {chain && (
              <span className={`pill ${chain.ok ? "pill-ok" : "pill-bad"}`}>
                {chain.ok
                  ? `Chain verified · ${chain.total} rows`
                  : chain.brokenAt !== null
                    ? `Broken at row ${chain.brokenAt}`
                    : `${chain.unsealed} unsealed rows`}
              </span>
            )}
            <button type="button" className="ghost small" onClick={() => void load()} disabled={busy}>
              {busy ? "Checking…" : "Re-verify"}
            </button>
          </div>
        </div>

        {chain && (
          <div className="chain-summary">
            <div>
              <span className="muted small">Sealed rows</span>
              <strong>{chain.sealed}</strong>
            </div>
            <div>
              <span className="muted small">Unsealed</span>
              <strong>{chain.unsealed}</strong>
            </div>
            <div>
              <span className="muted small">Head hash</span>
              <code className="mono small">{chain.headHash?.slice(0, 24) ?? "—"}…</code>
            </div>
          </div>
        )}

        {error && <p className="field-error">{error}</p>}

        {rows.length === 0 && !error && <p className="muted">No audit rows yet.</p>}

        {rows.length > 0 && (
          <table className="data-table audit">
            <thead>
              <tr>
                <th>Seq</th>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.seq}>
                  <td className="mono">{row.seq}</td>
                  <td className="mono small">{formatTimestamp(row.at)}</td>
                  <td>{row.actor}</td>
                  <td>
                    <span className={`pill ${ACTION_CLASS[row.action] ?? "pill-muted"}`}>
                      {row.action}
                    </span>
                  </td>
                  <td className="mono small" title={row.afterJson ?? row.beforeJson ?? ""}>
                    {row.entity}
                    {row.entityId !== null ? ` #${row.entityId}` : ""}
                  </td>
                  <td className="mono small muted">{row.hash ? `${row.hash.slice(0, 16)}…` : "unsealed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
