import { useEffect, useState } from "react";
import { ACCESS_DESCRIPTIONS, ACCESS_LABELS, api } from "../api";
import type { AccessLevel, ChainReport, CompanySummary, User } from "../types";
import { Empty, ErrorNote, field, money, submitHandler, toCents, useLoad } from "../ui";

const ACCESS_ORDER: AccessLevel[] = ["Admin", "Standard", "Payroll", "TimeEntry", "ReadOnly"];

const ROLE_LABELS: Array<[string, string]> = [
  ["cash_account", "Money in the bank"],
  ["receivable_account", "Money owed to you"],
  ["payable_account", "Money you owe"],
  ["sales_tax_account", "Sales tax you collect"],
  ["inventory_account", "Stock on hand"],
  ["cogs_account", "Cost of goods sold"],
  ["payroll_expense_account", "Wage expense"],
  ["payroll_liability_account", "Payroll deductions owed"],
  ["payroll_additions_account", "Reimbursements paid to employees"],
];

export default function SettingsScreen({
  revision,
  changed,
  company,
  me,
  onCloseCompany,
}: {
  revision: number;
  changed: (message?: string) => void;
  company: CompanySummary;
  me: User | null;
  onCloseCompany: () => void;
}) {
  const accounts = useLoad(() => api.listAccounts(), [revision]).data ?? [];
  const settings = useLoad(() => api.listSettings(), [revision]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainReport | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [userError, setUserError] = useState<string | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [payrollError, setPayrollError] = useState<string | null>(null);

  const isAdmin = me?.access === "Admin";
  const canManage = isAdmin;
  const people = useLoad(() => (isAdmin ? api.listUsers() : Promise.resolve([])), [revision, isAdmin]).data ?? [];

  async function savePerson(person: User, patch: { access?: AccessLevel; isActive?: boolean }) {
    try {
      setUserError(null);
      await api.saveUser({
        id: person.id,
        name: person.name,
        email: person.email,
        access: patch.access ?? person.access,
        isActive: patch.isActive ?? person.isActive,
      });
      changed(`${person.name} updated`);
    } catch (err) {
      setUserError(String(err));
    }
  }

  async function removePerson(person: User) {
    if (!window.confirm(`Remove ${person.name}? Their time entries stay, but they can no longer work in this file.`)) return;
    try {
      setUserError(null);
      await api.deleteUser(person.id);
      changed(`${person.name} removed`);
    } catch (err) {
      setUserError(String(err));
    }
  }

  useEffect(() => {
    if (!settings.data) return;
    const next: Record<string, string> = {};
    for (const row of settings.data) next[row.key] = row.value;
    setMap(next);
    setLoaded(true);
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
          <div className="panel-title">Business details</div>
          <p className="muted small">
            These print at the top of every invoice, report and downloaded file, so the customer knows who billed them.
            Leave a line empty and it simply does not appear.
          </p>
          {loaded ? (
            <form
              onSubmit={submitHandler(
                async (form) => {
                  const values: Array<[string, string]> = [
                    ["business_address", field(form, "address")],
                    ["business_phone", field(form, "phone")],
                    ["business_email", field(form, "email")],
                    ["business_website", field(form, "website")],
                  ];
                  for (const [key, value] of values) await api.saveSetting(key, value);
                  setMap((current) => ({ ...current, ...Object.fromEntries(values) }));
                  changed("Business details saved");
                },
                setDetailsError,
                () => undefined,
              )}
            >
              <div className="field">
                <label>Address</label>
                <textarea
                  name="address"
                  rows={3}
                  disabled={!canManage}
                  defaultValue={map.business_address ?? ""}
                  placeholder={"220 Harbor Way\nAlameda, CA 94501"}
                />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Phone</label>
                  <input
                    name="phone"
                    defaultValue={map.business_phone ?? ""}
                    placeholder="(510) 555-0142"
                    disabled={!canManage}
                  />
                </div>
                <div className="field">
                  <label>Email</label>
                  <input
                    name="email"
                    defaultValue={map.business_email ?? ""}
                    placeholder="books@riverbend.example"
                    disabled={!canManage}
                  />
                </div>
              </div>
              <div className="field">
                <label>Website</label>
                <input
                  name="website"
                  defaultValue={map.business_website ?? ""}
                  placeholder="riverbendcontracting.example"
                  disabled={!canManage}
                />
              </div>
              {canManage ? (
                <button type="submit" className="btn btn-primary">
                  Save business details
                </button>
              ) : (
                <div className="settings-note">Only an admin can change the company's settings.</div>
              )}
            </form>
          ) : (
            <div className="muted small">Loading…</div>
          )}
          {detailsError && <ErrorNote text={detailsError} />}
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
                disabled={!canManage}
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
        {isAdmin && (
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="panel-title">Users and access</div>
            <p className="muted small">
              Everyone who works in this company file, and what each of them can do. The name here is the name written to
              the audit trail when they change something.
            </p>
            <p className="muted small">
              A user is a login, not a job. People you pay but who never open the file belong under Payroll → Employees,
              where W-4 and W-2 details live. Adding an employee does not create a user, and a user does not have to be
              an employee.
            </p>
            {userError && <ErrorNote text={userError} />}
            <div className="user-list">
              {people.map((person) => {
                const otherAdmins = people.filter(
                  (candidate) => candidate.id !== person.id && candidate.access === "Admin" && candidate.isActive,
                ).length;
                const lastAdmin = person.access === "Admin" && person.isActive && otherAdmins === 0;
                return (
                  <div className="user-row" key={person.id}>
                    <div className="user-who">
                      <div className="strong">
                        {person.name}
                        {person.id === me?.id && <span className="muted small"> · you</span>}
                        {!person.isActive && <span className="muted small"> · switched off</span>}
                      </div>
                      <div className="muted small">{person.email || "no email"}</div>
                    </div>
                    <select
                      value={person.access}
                      disabled={lastAdmin}
                      title={
                        lastAdmin
                          ? "There must always be an admin"
                          : ACCESS_DESCRIPTIONS[person.access]
                      }
                      onChange={(event) => void savePerson(person, { access: event.target.value as AccessLevel })}
                    >
                      {ACCESS_ORDER.map((level) => (
                        <option key={level} value={level}>
                          {ACCESS_LABELS[level]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={lastAdmin}
                      onClick={() => void savePerson(person, { isActive: !person.isActive })}
                    >
                      {person.isActive ? "Switch off" : "Switch on"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={person.id === me?.id || lastAdmin}
                      title={person.id === me?.id ? "You cannot remove yourself" : undefined}
                      onClick={() => void removePerson(person)}
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
            <form
              onSubmit={submitHandler(
                async (form) => {
                  await api.saveUser({
                    name: field(form, "name"),
                    email: field(form, "email"),
                    access: (field(form, "access") || "Standard") as AccessLevel,
                    isActive: true,
                  });
                  changed("Person added");
                },
                setUserError,
                () => undefined,
              )}
            >
              <div className="field-row">
                <div className="field">
                  <label>Name</label>
                  <input name="name" placeholder="Sam Okafor" required />
                </div>
                <div className="field">
                  <label>Email</label>
                  <input name="email" placeholder="sam@example.com" />
                </div>
              </div>
              <div className="field">
                <label>Access</label>
                <select name="access" defaultValue="Standard">
                  {ACCESS_ORDER.map((level) => (
                    <option key={level} value={level}>
                      {ACCESS_LABELS[level]} — {ACCESS_DESCRIPTIONS[level]}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn btn-primary">
                Add person
              </button>
            </form>
            <div className="settings-note">
              The levels are enforced by the books, not only by this screen: a read only person cannot post, a time
              entry person cannot touch the ledger, and payroll — the roster, the pay runs and the Social Security
              numbers — opens only for an admin or the payroll person. There is no password — the company file lives on
              this machine, and switching the person working is what records who did what.
            </div>
          </div>
        )}

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
              <input
                name="invoiceIncome"
                defaultValue={map.invoice_income_account ?? "Sales Revenue"}
                disabled={!canManage}
              />
            </div>
            <div className="field">
              <label>Default sales tax %</label>
              <input
                name="taxPct"
                defaultValue={((Number(map.invoice_tax_bp) || 0) / 100).toFixed(2)}
                disabled={!canManage}
              />
            </div>
            {canManage && (
              <button type="submit" className="btn btn-primary">
                Save defaults
              </button>
            )}
          </form>
          {error && <ErrorNote text={error} />}
        </div>

        {isAdmin && (
        <>
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="panel-title">Payroll withholding</div>
          <p className="muted small">
            The working estimate behind every pay run. No rate is fixed in the engine — Social Security, Medicare,
            federal and state all change, so they are yours to set. Married and single use different federal rates, and
            each withholding allowance takes a slice of pay out of the federal base before the rate applies. Each pay
            run keeps the figures it was paid under, so changing a rate never rewrites history.
          </p>
          <form
            onSubmit={submitHandler(
              async (form) => {
                const pct = (name: string) => String(Math.round(Number(field(form, name) || "0") * 100));
                await api.saveSetting("payroll_social_security_bp", pct("socialPct"));
                await api.saveSetting("payroll_medicare_bp", pct("medicarePct"));
                await api.saveSetting("payroll_federal_single_bp", pct("singlePct"));
                await api.saveSetting("payroll_federal_married_bp", pct("marriedPct"));
                await api.saveSetting("payroll_state_bp", pct("statePct"));
                await api.saveSetting("payroll_allowance_cents", String(toCents(form.get("allowance"))));
                await api.saveSetting("payroll_mileage_rate_cents", String(toCents(form.get("mileage"))));
                changed("Payroll rates saved");
              },
              setPayrollError,
              () => undefined,
            )}
          >
            <div className="field-row3">
              <div className="field">
                <label>Social Security %</label>
                <input name="socialPct" defaultValue={((Number(map.payroll_social_security_bp) || 620) / 100).toFixed(2)} />
              </div>
              <div className="field">
                <label>Medicare %</label>
                <input name="medicarePct" defaultValue={((Number(map.payroll_medicare_bp) || 145) / 100).toFixed(2)} />
              </div>
              <div className="field">
                <label>State tax</label>
                <input name="statePct" defaultValue={((Number(map.payroll_state_bp) || 400) / 100).toFixed(2)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Federal tax — single</label>
                <input name="singlePct" defaultValue={((Number(map.payroll_federal_single_bp) || 1200) / 100).toFixed(2)} />
              </div>
              <div className="field">
                <label>Federal tax — married</label>
                <input name="marriedPct" defaultValue={((Number(map.payroll_federal_married_bp) || 800) / 100).toFixed(2)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>One withholding allowance is worth</label>
                <input name="allowance" defaultValue={((Number(map.payroll_allowance_cents) || 19400) / 100).toFixed(2)} />
              </div>
              <div className="field">
                <label>Mileage rate per mile</label>
                <input name="mileage" defaultValue={((Number(map.payroll_mileage_rate_cents) || 67) / 100).toFixed(2)} />
                <div className="hint-inline">What a reimbursed business mile is worth on a pay run.</div>
              </div>
            </div>
            <div className="muted small" style={{ marginBottom: 10 }}>
              These are working estimates for setting money aside and for a pay run's own figures — not a filed return.
              Reimbursed mileage and allowances are never taxed.
            </div>
            <button type="submit" className="btn btn-primary">
              Save payroll rates
            </button>
          </form>
          {payrollError && <ErrorNote text={payrollError} />}
        </div>

        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="panel-title">Close the books</div>
          <p className="muted small">
            Closing a period locks it. Nothing dated on or before the closed date can be posted, voided or edited — not
            from this app, and not by hand in the file.
          </p>
          <div className="kv">
            <span>Closed through</span>
            <strong>{map.books_locked_through || "Nothing is closed"}</strong>
          </div>
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.saveSetting("books_locked_through", field(form, "closedThrough"));
                setMap((current) => ({ ...current, books_locked_through: field(form, "closedThrough") }));
                changed("Books closed through " + field(form, "closedThrough"));
              },
              setLockError,
              () => undefined,
            )}
          >
            <div className="field">
              <label>Close through</label>
              <input type="date" name="closedThrough" defaultValue={map.books_locked_through ?? ""} />
            </div>
            <button type="submit" className="btn btn-primary">
              Close the period
            </button>
          </form>
          {map.books_locked_through && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ marginTop: 8 }}
              onClick={async () => {
                try {
                  await api.saveSetting("books_locked_through", "");
                  setMap((current) => ({ ...current, books_locked_through: "" }));
                  changed("Books reopened");
                } catch (err) {
                  setLockError(String(err));
                }
              }}
            >
              Reopen
            </button>
          )}
          {lockError && <ErrorNote text={lockError} />}
        </div>
        </>
        )}

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
