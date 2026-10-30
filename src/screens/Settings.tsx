import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChainReport, CompanySummary } from "../types";
import { Empty, ErrorNote, field, money, submitHandler, useLoad } from "../ui";

const ROLE_LABELS: Array<[string, string]> = [
  ["cash_account", "Money in the bank"],
  ["receivable_account", "Money owed to you"],
  ["payable_account", "Money you owe"],
  ["sales_tax_account", "Sales tax you collect"],
  ["inventory_account", "Stock on hand"],
  ["cogs_account", "Cost of goods sold"],
  ["payroll_expense_account", "Wage expense"],
  ["payroll_liability_account", "Payroll deductions owed"],
];

export default function SettingsScreen({
  revision,
  changed,
  company,
  onCloseCompany,
}: {
  revision: number;
  changed: (message?: string) => void;
  company: CompanySummary;
  onCloseCompany: () => void;
}) {
  const accounts = useLoad(() => api.listAccounts(), [revision]).data ?? [];
  const settings = useLoad(() => api.listSettings(), [revision]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainReport | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const next: Record<string, string> = {};
    for (const row of settings.data) next[row.key] = row.value;
    setMap(next);
  }, [settings.data]);

  async function saveRole(key: string, value: string) {
    try {
      setMap((current) => ({ ...current, [key]: value }));
      await api.saveSetting(key, value);
      changed("Setting saved");
    } catch (err) {
      setError(String(err));
    }
  }

  async function verify() {
    try {
      setChainError(null);
      setChain(await api.verifyAudit());
    } catch (err) {
      setChainError(String(err));
    }
  }

  const accountName = (id: string) => {
    const parsed = Number(id);
    const account = accounts.find((candidate) => candidate.id === parsed);
    return account ? `${account.number} · ${account.name}` : "";
  };

  return (
    <div className="two-col">
      <div>
        <div className="card card-pad">
          <div className="panel-title">Company</div>
          <div className="kv">
            <span>Name</span>
            <strong>{company.name}</strong>
          </div>
          <div className="kv">
            <span>File</span>
            <strong className="mono small">{company.fileName}</strong>
          </div>
          <div className="kv">
            <span>Currency</span>
            <strong>{company.baseCurrency}</strong>
          </div>
          <div className="kv">
            <span>Schema</span>
            <strong>v{company.schemaVersion}</strong>
          </div>
          <div className="settings-note mono small">{company.path}</div>
        </div>

        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="panel-title">Where things post</div>
          <p className="muted small">
            These are ordinary accounts. Point any of them somewhere else and every future posting follows — nothing is
            hard-coded.
          </p>
          {ROLE_LABELS.map(([key, label]) => (
            <div className="field" key={key}>
              <label>{label}</label>
              <select
                value={map[key] ?? ""}
                onChange={(event) => void saveRole(key, event.target.value)}
              >
                <option value="">— using the default —</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.number} · {account.name}
                  </option>
                ))}
              </select>
              {map[key] && <div className="hint-inline">{accountName(map[key])}</div>}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="card card-pad">
          <div className="panel-title">Invoice defaults</div>
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.saveSetting("invoice_income_account", field(form, "invoiceIncome"));
                await api.saveSetting("invoice_tax_bp", String(Math.round(Number(field(form, "taxPct") || "0") * 100)));
                changed("Invoice defaults saved");
              },
              setError,
              () => undefined,
            )}
          >
            <div className="field">
              <label>Revenue category for invoices</label>
              <input name="invoiceIncome" defaultValue={map.invoice_income_account ?? "Sales Revenue"} />
            </div>
            <div className="field">
              <label>Default sales tax %</label>
              <input name="taxPct" defaultValue={((Number(map.invoice_tax_bp) || 0) / 100).toFixed(2)} />
            </div>
            <button type="submit" className="btn btn-primary">
              Save defaults
            </button>
          </form>
          {error && <ErrorNote text={error} />}
        </div>

        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="panel-title">Your books are checked</div>
          <p className="muted small">
            Every change is written to a tamper-evident log. Verifying recomputes the whole chain; if any record was altered
            behind the app's back, the first broken link is reported here.
          </p>
          <button type="button" className="btn" onClick={() => void verify()}>
            Verify the audit chain
          </button>
          {chainError && <ErrorNote text={chainError} />}
          {chain && (
            <div className="settings-note">
              {chain.ok ? "Chain verified." : `Chain broken at record ${chain.brokenAt}.`} {chain.sealed} sealed,{" "}
              {chain.unsealed} unsealed, {chain.total} total.
            </div>
          )}
        </div>

        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="panel-title">This company file</div>
          <p className="muted small">
            One company is one file. Copy it to back up, or move it to another machine — everything comes with it.
          </p>
          <div className="kv">
            <span>Size</span>
            <span className="num">{(company.sizeBytes / 1024).toFixed(0)} KB</span>
          </div>
          <div className="kv">
            <span>Cash on hand uses</span>
            <span>{accountName(map.cash_account ?? "") || "Checking"}</span>
          </div>
          <button type="button" className="btn btn-danger" onClick={onCloseCompany}>
            Close company
          </button>
        </div>
      </div>
    </div>
  );
}

export function SettingsEmpty() {
  return <Empty>Open a company to change its settings.</Empty>;
}

void money;
