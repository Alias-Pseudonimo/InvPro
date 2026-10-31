import { useCallback, useEffect, useState } from "react";
import { ACCESS_LABELS, api, isDesktop, setActingUser } from "./api";
import { errorText } from "./format";
import type { CompanySummary, Person, User } from "./types";
import DashboardScreen from "./screens/Dashboard";
import { CreditMemosScreen } from "./screens/Credits";
import { ExpensesScreen, IncomeScreen } from "./screens/Money";
import PeopleScreen from "./screens/People";
import { InvoicesScreen, PurchasesScreen } from "./screens/Paperwork";
import { EstimatesScreen, SalesOrdersScreen } from "./screens/Sales";
import { InventoryScreen, PayrollScreen } from "./screens/Stock";
import ReportsScreen from "./screens/Reports";
import SettingsScreen from "./screens/Settings";
import LedgerScreen from "./screens/Ledger";

type TabId =
  | "dashboard"
  | "income"
  | "invoices"
  | "estimates"
  | "orders"
  | "credits"
  | "customers"
  | "expenses"
  | "purchases"
  | "vendors"
  | "inventory"
  | "payroll"
  | "pl"
  | "balance"
  | "tax"
  | "ledger"
  | "settings";

interface NavItem {
  id: TabId;
  label: string;
  title: string;
  sub: string;
}

const NAV: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [{ id: "dashboard", label: "Dashboard", title: "Dashboard", sub: "How the business is doing" }],
  },
  {
    label: "Money in",
    items: [
      { id: "income", label: "Income", title: "Income", sub: "Every dollar coming in" },
      { id: "invoices", label: "Invoices", title: "Invoices", sub: "Bill your customers" },
      {
        id: "estimates",
        label: "Estimates",
        title: "Estimates",
        sub: "Quote a job — nothing is owed until it is invoiced",
      },
      {
        id: "orders",
        label: "Sales orders",
        title: "Sales orders",
        sub: "What the customer actually ordered",
      },
      { id: "customers", label: "Customers", title: "Customers", sub: "Who you bill" },
      {
        id: "credits",
        label: "Credit memos",
        title: "Credit memos",
        sub: "Money going back to a customer, and where it went",
      },
    ],
  },
  {
    label: "Money out",
    items: [
      { id: "expenses", label: "Expenses", title: "Expenses", sub: "Everything going out" },
      { id: "purchases", label: "Purchases", title: "Purchases", sub: "Buying stock — one record updates it all" },
      { id: "vendors", label: "Vendors", title: "Vendors", sub: "Who you pay" },
    ],
  },
  {
    label: "Stock & pay",
    items: [
      { id: "inventory", label: "Inventory", title: "Inventory", sub: "What you have on hand" },
      {
        id: "payroll",
        label: "Payroll",
        title: "Payroll",
        sub: "Wages, deductions, and the hours and miles behind them",
      },
    ],
  },
  {
    label: "Reports",
    items: [
      { id: "pl", label: "Profit & Loss", title: "Profit & Loss", sub: "What you earned and what it cost" },
      { id: "balance", label: "Balance Sheet", title: "Balance Sheet", sub: "What you own and what you owe" },
      { id: "tax", label: "Tax Summary", title: "Tax Summary", sub: "Sales tax to set aside" },
    ],
  },
  {
    label: "Advanced",
    items: [
      { id: "ledger", label: "The ledger", title: "The ledger", sub: "The double-entry books behind every screen" },
      { id: "settings", label: "Settings", title: "Settings", sub: "Company file and where things post" },
    ],
  },
];

const ALL_ITEMS = NAV.flatMap((group) => group.items);

function initialTheme(): "light" | "dark" {
  const stored = localStorage.getItem("ledgerworks_theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [company, setCompany] = useState<CompanySummary | null>(null);
  const [booting, setBooting] = useState(true);
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [directory, setDirectory] = useState("");
  const [tab, setTab] = useState<TabId>("dashboard");
  const [revision, setRevision] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ledgerworks_theme", theme);
  }, [theme]);

  const changed = useCallback((message?: string) => {
    setRevision((value) => value + 1);
    if (message) {
      setToast(message);
      window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2600);
    }
  }, []);

  const adopt = useCallback(async (record: CompanySummary) => {
    setCompany(record);
    const me = await api.currentUser();
    setActingUser(me);
    setUser(me);
  }, []);

  const loadCompany = useCallback(async () => {
    try {
      const current = await api.currentCompany();
      if (current) {
        await adopt(current);
      } else {
        setCompany(null);
        setCompanies(await api.listCompanies());
        setDirectory(await api.companiesDirectory());
      }
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBooting(false);
    }
  }, [adopt]);

  useEffect(() => {
    void loadCompany();
  }, [loadCompany]);

  const role = user?.access ?? "Admin";

  // The picker is the app's sign-in: everyone can see who is on the file and
  // choose, because there is no password to check. Access decides what they can
  // then do, in the engine.
  useEffect(() => {
    if (!company) {
      setPeople([]);
      return;
    }
    void api
      .listPeople()
      .then(setPeople)
      .catch(() => setPeople([]));
  }, [company, revision]);

  async function switchTo(id: number) {
    try {
      const next = await api.switchUser(id);
      setActingUser(next);
      setUser(next);
      setTab(
        next.access === "TimeEntry" || next.access === "Payroll" ? "payroll" : "dashboard",
      );
      changed(`Now working as ${next.name} — ${ACCESS_LABELS[next.access]}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const timeOnly = role === "TimeEntry";
  // A payroll person opens on payroll and has no other door: their access level
  // cannot read the books, so offering the tabs would only produce refusals.
  const payrollOnly = role === "Payroll";
  const mayPayroll = role === "Admin" || payrollOnly;
  const activeTab: TabId = timeOnly || payrollOnly ? "payroll" : tab;
  // A time entry person sees one door, and it opens onto their own sheet; the
  // payroll door is only drawn for the people whose level can open it.
  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((entry) => {
      if (timeOnly || payrollOnly) return entry.id === "payroll";
      if (entry.id === "payroll") return mayPayroll;
      return true;
    }),
  })).filter((group) => group.items.length > 0);
  const base = ALL_ITEMS.find((candidate) => candidate.id === activeTab) ?? ALL_ITEMS[0];
  const item = timeOnly
    ? { ...base, label: "Time & mileage", title: "Time & mileage", sub: "Your hours and miles" }
    : base;

  if (booting) {
    return <div className="boot">Opening your books…</div>;
  }

  if (!company) {
    return (
      <div className="welcome">
        {!isDesktop && (
          <div className="preview-banner">
            Preview build — the desktop shell is not attached, so this is an in-memory demo with sample data. Run{" "}
            <code>npm run tauri dev</code> for the real SQLite company file.
          </div>
        )}
        <div className="welcome-card">
          <div className="welcome-brand">
            <span className="brand-mark" aria-hidden="true" />
            <div>
              <h1>LedgerWorks</h1>
              <p className="muted">Plain-language bookkeeping. The double entry takes care of itself.</p>
            </div>
          </div>

          <form
            className="welcome-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const name = String(form.get("name") ?? "").trim();
              try {
                const created = await api.createCompany({ name });
                await adopt(created);
                changed("Company created");
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            <div className="field">
              <label>Start a new company</label>
              <input name="name" placeholder="e.g. Riverbend Contracting LLC" required />
            </div>
            <button type="submit" className="btn btn-primary">
              Create company file
            </button>
          </form>

          {companies.length > 0 && (
            <div className="welcome-files">
              <div className="panel-title">Or open one of yours</div>
              {companies.map((record) => (
                <button
                  type="button"
                  key={record.path}
                  className="file-row"
                  onClick={async () => {
                    try {
                      await adopt(await api.openCompany(record.path));
                      changed(`Opened ${record.name}`);
                    } catch (err) {
                      setError(errorText(err));
                    }
                  }}
                >
                  <span className="strong">{record.name}</span>
                  <span className="muted small mono">{record.fileName}</span>
                </button>
              ))}
            </div>
          )}

          {directory && <div className="muted small settings-note">Company files live in {directory}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell" data-read-only={role === "ReadOnly" ? "true" : "false"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">
            <span className="brand-mark" aria-hidden="true" />
            LedgerWorks
          </div>
          <div className="co">{company.name}</div>
        </div>

        <nav className="tabs" aria-label="Sections">
          {groups.map((group) => (
            <div className="tab-group" key={group.label}>
              <div className="tab-label">{group.label}</div>
              {group.items.map((navItem) => (
                <button
                  key={navItem.id}
                  type="button"
                  className={`tab ${activeTab === navItem.id ? "active" : ""}`}
                  onClick={() => setTab(navItem.id)}
                >
                  {navItem.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          {user && (
            <div className="who">
              <div className="who-label">Working as</div>
              {people.length > 0 ? (
                <select
                  className="who-select"
                  value={user.id}
                  onChange={(event) => void switchTo(Number(event.target.value))}
                  aria-label="Switch the person working"
                >
                  {people
                    .filter((person) => person.isActive || person.id === user.id)
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name} — {ACCESS_LABELS[person.access]}
                      </option>
                    ))}
                </select>
              ) : (
                <div className="who-name">{user.name}</div>
              )}
              <div className="who-role">{ACCESS_LABELS[user.access]}</div>
            </div>
          )}
          <div className="sidebar-foot-row">
            <span className="muted small">{company.baseCurrency}</span>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title="Toggle light and dark"
              aria-label="Toggle light and dark"
            />
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{item.title}</h1>
            <div className="sub">{item.sub}</div>
          </div>
          <div className="topbar-actions">
            <span className="pill pill-draft mono">{company.fileName}</span>
          </div>
        </header>

        <main className="content">
          {role === "ReadOnly" && (
            <div className="role-banner">
              <strong>Read only.</strong> You can look through everything and run reports, but nothing here can be created
              or edited. An admin can change this in Settings, under Users and access.
            </div>
          )}
          {activeTab === "dashboard" && <DashboardScreen revision={revision} go={(next) => setTab(next as TabId)} />}
          {activeTab === "income" && <IncomeScreen revision={revision} changed={changed} />}
          {activeTab === "invoices" && <InvoicesScreen revision={revision} changed={changed} />}
          {activeTab === "estimates" && <EstimatesScreen revision={revision} changed={changed} />}
          {activeTab === "orders" && <SalesOrdersScreen revision={revision} changed={changed} />}
          {activeTab === "credits" && <CreditMemosScreen revision={revision} changed={changed} />}
          {activeTab === "customers" && <PeopleScreen kind="customers" revision={revision} changed={changed} />}
          {activeTab === "expenses" && <ExpensesScreen revision={revision} changed={changed} />}
          {activeTab === "purchases" && <PurchasesScreen revision={revision} changed={changed} />}
          {activeTab === "vendors" && <PeopleScreen kind="vendors" revision={revision} changed={changed} />}
          {activeTab === "inventory" && <InventoryScreen revision={revision} changed={changed} />}
          {activeTab === "payroll" && user && (
            <PayrollScreen revision={revision} changed={changed} me={user} />
          )}
          {activeTab === "pl" && <ReportsScreen mode="pl" revision={revision} />}
          {activeTab === "balance" && <ReportsScreen mode="balance" revision={revision} />}
          {activeTab === "tax" && <ReportsScreen mode="tax" revision={revision} />}
          {activeTab === "ledger" && <LedgerScreen revision={revision} changed={changed} />}
          {activeTab === "settings" && (
            <SettingsScreen
              revision={revision}
              changed={changed}
              company={company}
              me={user}
              onCloseCompany={async () => {
                try {
                  await api.closeCompany();
                  setCompany(null);
                  setActingUser(null);
                  setUser(null);
                  setCompanies(await api.listCompanies());
                  changed("Company closed");
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            />
          )}
        </main>
      </div>

      {toast && <div className="toast show">{toast}</div>}
      {error && (
        <div className="toast show error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-btn" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
