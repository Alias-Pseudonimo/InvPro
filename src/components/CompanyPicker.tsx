import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { errorText, formatBytes, formatTimestamp } from "../format";
import type { CompanySummary } from "../types";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function CompanyPicker({ onOpened }: { onOpened: () => void }) {
  const [companies, setCompanies] = useState<CompanySummary[] | null>(null);
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [fiscalMonth, setFiscalMonth] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [files, folder] = await Promise.all([api.listCompanies(), api.companiesDirectory()]);
      setCompanies(files);
      setDirectory(folder);
      setError(null);
    } catch (err) {
      setError(errorText(err));
      setCompanies([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(path: string) {
    setBusy(true);
    try {
      await api.openCompany(path);
      onOpened();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.createCompany({
        name,
        baseCurrency: currency,
        fiscalYearStartMonth: fiscalMonth,
      });
      onOpened();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="picker">
      <div className="picker-head">
        <h1>Company files</h1>
        <p>
          Each company is its own SQLite file. Open one to start bookkeeping, or create a new
          company with a standard chart of accounts.
        </p>
        <code className="picker-path">{directory || "…"}</code>
      </div>

      <div className="picker-grid">
        <section className="card">
          <div className="card-head">
            <h2>Recent files</h2>
            <button type="button" className="ghost small" onClick={() => void load()} disabled={busy}>
              Refresh
            </button>
          </div>

          {companies === null && <p className="muted">Reading company folder…</p>}
          {companies !== null && companies.length === 0 && (
            <p className="muted">
              No company files yet. Create one on the right — it is saved as a single portable file
              you can back up or copy to another machine.
            </p>
          )}

          <ul className="company-list">
            {(companies ?? []).map((company) => (
              <li key={company.path}>
                <button type="button" onClick={() => void open(company.path)} disabled={busy}>
                  <span className="company-name">{company.name}</span>
                  <span className="company-meta">
                    {company.baseCurrency} · FY starts {MONTHS[company.fiscalYearStartMonth - 1]} ·{" "}
                    {formatBytes(company.sizeBytes)}
                  </span>
                  <span className="company-file">{company.fileName}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>New company</h2>
          </div>
          <form className="form" onSubmit={(event) => void create(event)}>
            <label>
              <span>Company name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme Widgets LLC"
                required
                autoFocus
              />
            </label>
            <div className="form-row">
              <label>
                <span>Base currency</span>
                <input
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  maxLength={3}
                  required
                />
              </label>
              <label>
                <span>Fiscal year starts</span>
                <select
                  value={fiscalMonth}
                  onChange={(event) => setFiscalMonth(Number(event.target.value))}
                >
                  {MONTHS.map((month, index) => (
                    <option key={month} value={index + 1}>
                      {month}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted small">
              A standard chart of accounts is created and every change is written to a sealed audit
              trail.
            </p>
            <button type="submit" className="primary" disabled={busy || name.trim().length === 0}>
              {busy ? "Working…" : "Create company"}
            </button>
          </form>
        </section>
      </div>

      {companies && companies.length > 0 && (
        <p className="muted small picker-foot">
          Last opened file: {companies[0].name} · modified{" "}
          {formatTimestamp(new Date(Number(companies[0].modifiedAt) * 1000).toISOString())}
        </p>
      )}

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
