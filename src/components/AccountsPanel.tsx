import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { errorText } from "../format";
import type { Account, AccountType } from "../types";

const TYPE_ORDER: AccountType[] = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "INCOME",
  "OTHER_INCOME",
  "COGS",
  "EXPENSE",
  "OTHER_EXPENSE",
];

const TYPE_LABEL: Record<AccountType, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  INCOME: "Income",
  COGS: "Cost of goods sold",
  EXPENSE: "Expenses",
  OTHER_INCOME: "Other income",
  OTHER_EXPENSE: "Other expense",
};

interface Props {
  revision: number;
  onMutated: () => void;
}

export default function AccountsPanel({ revision, onMutated }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("ASSET");
  const [subtype, setSubtype] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const chart = await api.listAccounts();
        if (!cancelled) setAccounts(chart);
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const grouped = useMemo(() => {
    const groups = new Map<AccountType, Account[]>();
    for (const type of TYPE_ORDER) {
      const rows = accounts
        .filter((account) => account.accountType === type)
        .sort((left, right) => left.number.localeCompare(right.number));
      if (rows.length > 0) groups.set(type, rows);
    }
    return groups;
  }, [accounts]);

  const parents = accounts.filter(
    (account) => account.accountType === accountType && account.isActive,
  );

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createAccount({
        number: number.trim(),
        name: name.trim(),
        accountType,
        subtype: subtype.trim() || null,
        parentId: parentId ? Number(parentId) : null,
      });
      setNumber("");
      setName("");
      setSubtype("");
      setParentId("");
      setShowForm(false);
      onMutated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(account: Account) {
    try {
      await api.setAccountActive(account.id, !account.isActive);
      onMutated();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Chart of accounts</h2>
          <div className="card-actions">
            <span className="muted small">{accounts.length} accounts</span>
            <button
              type="button"
              className="primary small"
              onClick={() => setShowForm((value) => !value)}
            >
              {showForm ? "Cancel" : "New account"}
            </button>
          </div>
        </div>

        {showForm && (
          <form className="form inset" onSubmit={(event) => void create(event)}>
            <div className="form-row">
              <label>
                <span>Number</span>
                <input
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                  placeholder="1020"
                  required
                />
              </label>
              <label className="grow">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Payroll Checking"
                  required
                />
              </label>
              <label>
                <span>Type</span>
                <select
                  value={accountType}
                  onChange={(event) => {
                    setAccountType(event.target.value as AccountType);
                    setParentId("");
                  }}
                >
                  {TYPE_ORDER.map((type) => (
                    <option key={type} value={type}>
                      {TYPE_LABEL[type]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                <span>Subtype</span>
                <input
                  value={subtype}
                  onChange={(event) => setSubtype(event.target.value)}
                  placeholder="Bank"
                />
              </label>
              <label className="grow">
                <span>Parent account (optional)</span>
                <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                  <option value="">None — top level</option>
                  {parents.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.number} · {account.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Saving…" : "Add account"}
              </button>
            </div>
          </form>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="account-groups">
          {[...grouped.entries()].map(([type, rows]) => (
            <div key={type} className="account-group">
              <h3>
                {TYPE_LABEL[type]} <span className="muted small">{rows.length}</span>
              </h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Name</th>
                    <th>Subtype</th>
                    <th>Normal</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((account) => (
                    <tr key={account.id} className={account.isActive ? "" : "is-inactive"}>
                      <td className="mono">{account.number}</td>
                      <td>
                        {account.parentId ? <span className="indent">└ </span> : null}
                        {account.name}
                        {account.hasChildren && <span className="tag">header</span>}
                      </td>
                      <td className="muted small">{account.subtype ?? "—"}</td>
                      <td className="muted small">{account.normalBalance}</td>
                      <td>
                        <span className={`pill ${account.isActive ? "pill-ok" : "pill-muted"}`}>
                          {account.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        <button type="button" className="ghost small" onClick={() => void toggle(account)}>
                          {account.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
