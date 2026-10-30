import { useCallback, useEffect, useState } from "react";
import { api, isDesktop } from "./api";
import { errorText } from "./format";
import type { CompanySummary } from "./types";
import DashboardScreen from "./screens/Dashboard";
import { ExpensesScreen, IncomeScreen } from "./screens/Money";
import PeopleScreen from "./screens/People";
import { InvoicesScreen, PurchasesScreen } from "./screens/Paperwork";
import { InventoryScreen, PayrollScreen } from "./screens/Stock";
import ReportsScreen from "./screens/Reports";
import SettingsScreen from "./screens/Settings";
import LedgerScreen from "./screens/Ledger";

type TabId =
  | "dashboard"
  | "income"
  | "invoices"
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
      { id: "customers", label: "Customers", title: "Customers", sub: "Who you bill" },
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
      { id: "payroll", label: "Payroll", title: "Payroll", sub: "Wages, deductions and net pay" },
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

  const loadCompany = useCallback(async () => {
    try {
      const current = await api.currentCompany();
      setCompany(current);
      if (!current) {
        setCompanies(await api.listCompanies());
        setDirectory(await api.companiesDirectory());
      }
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    void loadCompany();
  }, [loadCompany]);

  const item = ALL_ITEMS.find((candidate) => candidate.id === tab) ?? ALL_ITEMS[0];

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
                setCompany(created);
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
                      setCompany(await api.openCompany(record.path));
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">
            <span className="brand-mark" aria-hidden="true" />
            LedgerWorks
          </div>
          <div className="co">{company.name}</div>
        </div>

        <nav className="tabs" aria-label="Sections">
          {NAV.map((group) => (
            <div className="tab-group" key={group.label}>
              <div className="tab-label">{group.label}</div>
              {group.items.map((navItem) => (
                <button
                  key={navItem.id}
                  type="button"
                  className={`tab ${tab === navItem.id ? "active" : ""}`}
                  onClick={() => setTab(navItem.id)}
                >
                  {navItem.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <span className="muted small">{company.baseCurrency}</span>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle light and dark"
            aria-label="Toggle light and dark"
          />
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
          {tab === "dashboard" && <DashboardScreen revision={revision} go={(next) => setTab(next as TabId)} />}
          {tab === "income" && <IncomeScreen revision={revision} changed={changed} />}
          {tab === "invoices" && <InvoicesScreen revision={revision} changed={changed} />}
          {tab === "customers" && <PeopleScreen kind="customers" revision={revision} changed={changed} />}
          {tab === "expenses" && <ExpensesScreen revision={revision} changed={changed} />}
          {tab === "purchases" && <PurchasesScreen revision={revision} changed={changed} />}
          {tab === "vendors" && <PeopleScreen kind="vendors" revision={revision} changed={changed} />}
          {tab === "inventory" && <InventoryScreen revision={revision} changed={changed} />}
          {tab === "payroll" && <PayrollScreen revision={revision} changed={changed} />}
          {tab === "pl" && <ReportsScreen mode="pl" revision={revision} />}
          {tab === "balance" && <ReportsScreen mode="balance" revision={revision} />}
          {tab === "tax" && <ReportsScreen mode="tax" revision={revision} />}
          {tab === "ledger" && <LedgerScreen revision={revision} changed={changed} />}
          {tab === "settings" && (
            <SettingsScreen
              revision={revision}
              changed={changed}
              company={company}
              onCloseCompany={async () => {
                try {
                  await api.closeCompany();
                  setCompany(null);
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
