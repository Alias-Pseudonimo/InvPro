import { invoke } from "@tauri-apps/api/core";
import * as mock from "./mock";
import type {
  Account,
  AuditRow,
  BalanceSheet,
  ChainReport,
  CompanySummary,
  Customer,
  DashboardSummary,
  EntryDetail,
  EntrySummary,
  ExpenseInput,
  ExpenseRecord,
  IncomeInput,
  IncomeRecord,
  InventoryInput,
  InventoryItem,
  Invoice,
  InvoiceInput,
  JournalEntryInput,
  LedgerHealth,
  PartyInput,
  PayrollInput,
  PayrollRun,
  ProfitAndLoss,
  Purchase,
  PurchaseInput,
  RecurringInvoice,
  RecurringInvoiceInput,
  Setting,
  TaxSummary,
  TrialBalanceReport,
  Vendor,
} from "./types";

/** True inside the Tauri window; false in a plain browser preview. */
export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isDesktop) {
    return invoke<T>(command, args);
  }
  return mock.invoke<T>(command, args);
}

export interface CreateAccountInput {
  number: string;
  name: string;
  accountType: Account["accountType"];
  subtype?: string | null;
  parentId?: number | null;
  currency?: string | null;
  description?: string | null;
}

export const api = {
  // Company files
  listCompanies: () => call<CompanySummary[]>("list_companies"),
  companiesDirectory: () => call<string>("companies_directory"),
  createCompany: (input: {
    name: string;
    baseCurrency?: string;
    fiscalYearStartMonth?: number;
  }) => call<CompanySummary>("create_company", { input }),
  openCompany: (path: string) => call<CompanySummary>("open_company", { input: { path } }),
  closeCompany: () => call<void>("close_company"),
  currentCompany: () => call<CompanySummary | null>("current_company"),

  // People
  listCustomers: () => call<Customer[]>("list_customers"),
  saveCustomer: (input: PartyInput) => call<Customer>("save_customer", { input }),
  deleteCustomer: (id: number) => call<void>("delete_customer", { id }),
  listVendors: () => call<Vendor[]>("list_vendors"),
  saveVendor: (input: PartyInput) => call<Vendor>("save_vendor", { input }),
  deleteVendor: (id: number) => call<void>("delete_vendor", { id }),

  // Money in and out
  listIncome: () => call<IncomeRecord[]>("list_income"),
  saveIncome: (input: IncomeInput) => call<IncomeRecord>("save_income", { input }),
  deleteIncome: (id: number) => call<void>("delete_income", { id }),
  listExpenses: () => call<ExpenseRecord[]>("list_expenses"),
  saveExpense: (input: ExpenseInput) => call<ExpenseRecord>("save_expense", { input }),
  deleteExpense: (id: number) => call<void>("delete_expense", { id }),

  // Invoices, purchases, stock, pay
  listInvoices: () => call<Invoice[]>("list_invoices"),
  getInvoice: (id: number) => call<Invoice>("get_invoice", { id }),
  saveInvoice: (input: InvoiceInput) => call<Invoice>("save_invoice", { input }),
  deleteInvoice: (id: number) => call<void>("delete_invoice", { id }),
  listRecurringInvoices: () => call<RecurringInvoice[]>("list_recurring_invoices"),
  saveRecurringInvoice: (input: RecurringInvoiceInput) =>
    call<RecurringInvoice>("save_recurring_invoice", { input }),
  deleteRecurringInvoice: (id: number) => call<void>("delete_recurring_invoice", { id }),
  generateDueInvoices: (todayDate: string) =>
    call<Invoice[]>("generate_due_invoices", { today: todayDate }),
  listPurchases: () => call<Purchase[]>("list_purchases"),
  savePurchase: (input: PurchaseInput) => call<Purchase>("save_purchase", { input }),
  deletePurchase: (id: number) => call<void>("delete_purchase", { id }),
  listInventory: () => call<InventoryItem[]>("list_inventory"),
  saveInventoryItem: (input: InventoryInput) =>
    call<InventoryItem>("save_inventory_item", { input }),
  deleteInventoryItem: (id: number) => call<void>("delete_inventory_item", { id }),
  listPayroll: () => call<PayrollRun[]>("list_payroll"),
  savePayroll: (input: PayrollInput) => call<PayrollRun>("save_payroll", { input }),
  deletePayroll: (id: number) => call<void>("delete_payroll", { id }),

  // Reporting and settings
  dashboard: () => call<DashboardSummary>("dashboard"),
  profitAndLoss: (from?: string, to?: string) =>
    call<ProfitAndLoss>("profit_and_loss", { from: from ?? null, to: to ?? null }),
  balanceSheet: (asOf?: string) =>
    call<BalanceSheet>("balance_sheet", { asOf: asOf ?? null }),
  taxSummary: (from?: string, to?: string) =>
    call<TaxSummary>("tax_summary", { from: from ?? null, to: to ?? null }),
  listSettings: () => call<Setting[]>("list_settings"),
  saveSetting: (key: string, value: string) => call<void>("save_setting", { key, value }),

  // The ledger underneath, for anyone who wants it
  listAccounts: () => call<Account[]>("list_accounts"),
  createAccount: (input: CreateAccountInput) => call<Account>("create_account", { input }),
  setAccountActive: (accountId: number, active: boolean) =>
    call<void>("set_account_active", { accountId, active }),
  listEntries: (limit = 100) => call<EntrySummary[]>("list_journal_entries", { limit }),
  postEntry: (input: JournalEntryInput) => call<EntryDetail>("post_journal_entry", { input }),
  voidEntry: (entryId: number) => call<void>("void_journal_entry", { entryId }),
  trialBalance: () => call<TrialBalanceReport>("trial_balance"),
  verifyAudit: () => call<ChainReport>("verify_audit_chain"),
  listAudit: (limit = 200) => call<AuditRow[]>("list_audit_log", { limit }),
  health: () => call<LedgerHealth>("ledger_health"),
};
