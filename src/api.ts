import { invoke } from "@tauri-apps/api/core";
import * as mock from "./mock";
import type {
  AccessLevel,
  Account,
  AuditRow,
  BalanceSheet,
  ChainReport,
  CompanySummary,
  CreditMemo,
  CreditMemoInput,
  Customer,
  DashboardSummary,
  Employee,
  EmployeeInput,
  EntryDetail,
  EntrySummary,
  Estimate,
  EstimateInput,
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
  MileageDue,
  PartyInput,
  PayrollInput,
  Person,
  PayrollRun,
  ProfitAndLoss,
  Purchase,
  PurchaseInput,
  RecurringInvoice,
  RecurringInvoiceInput,
  SalesOrder,
  SalesOrderInput,
  Setting,
  TaxSummary,
  TimeEntry,
  TimeEntryInput,
  TrialBalanceReport,
  User,
  UserInput,
  Vendor,
} from "./types";

/** True inside the Tauri window; false in a plain browser preview. */
export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ------------------------------------------------------------------ *
 * Access levels, mirrored from the engine.
 *
 * The engine is the authority — it refuses a command the acting user's access
 * level does not allow. This mirror exists so a limited user gets a plain
 * explanation instead of an error from deep in the stack, and so screens can
 * ask what to show. It never pretends to be security on its own.
 * ------------------------------------------------------------------ */

export type Capability = "any" | "view" | "edit" | "settings" | "users" | "time" | "payroll";

const WRITE_PREFIX = /^(save_|delete_|post_|void_|generate_|set_|create_|convert_|preview_)/;

const CAPABILITY_OVERRIDES: Record<string, Capability> = {
  // Opening and closing a company file is not editing its books.
  create_company: "any",
  open_company: "any",
  close_company: "any",
  // Everyone may know who they are acting as, and choose.
  current_user: "any",
  switch_user: "any",
  list_people: "any",
  // Saving a copy of a document you can already see is reading.
  save_document: "view",
  list_users: "users",
  save_user: "users",
  delete_user: "users",
  save_setting: "settings",
  list_time_entries: "time",
  save_time_entry: "time",
  delete_time_entry: "time",
  // Wages, Social Security numbers and the roster are the payroll person's job,
  // not something every user who can invoice should be able to open.
  list_payroll: "payroll",
  preview_payroll: "payroll",
  save_payroll: "payroll",
  delete_payroll: "payroll",
  list_employees: "payroll",
  save_employee: "payroll",
  delete_employee: "payroll",
  mileage_due: "payroll",
};

function capabilityOf(command: string): Capability {
  const override = CAPABILITY_OVERRIDES[command];
  if (override) return override;
  return WRITE_PREFIX.test(command) ? "edit" : "view";
}

let actingUser: User | null = null;

/** Remember who is acting, so every call can be checked against their access. */
export function setActingUser(user: User | null) {
  actingUser = user;
}

export function actingRole(): AccessLevel {
  return actingUser?.access ?? "Admin";
}

export const ACCESS_LABELS: Record<AccessLevel, string> = {
  Admin: "Admin",
  Standard: "Standard",
  Payroll: "Payroll",
  TimeEntry: "Time entry",
  ReadOnly: "Read only",
};

export const ACCESS_DESCRIPTIONS: Record<AccessLevel, string> = {
  Admin: "Full access — people, settings, every transaction, payroll and closing the books.",
  Standard: "Enter and edit transactions and run reports. No payroll, settings or people.",
  Payroll: "Pay runs, the employee roster and their time and mileage. No invoices, settings or people.",
  TimeEntry: "Enter billable time and mileage, and see their own sheet. Nothing else.",
  ReadOnly: "View transactions and run reports. Cannot create or edit anything.",
};

export function can(capability: Exclude<Capability, "any">): boolean {
  switch (actingRole()) {
    case "Admin":
      return true;
    case "Standard":
      return capability === "view" || capability === "edit" || capability === "time";
    case "Payroll":
      return capability === "payroll" || capability === "time";
    case "TimeEntry":
      return capability === "time";
    case "ReadOnly":
      return capability === "view";
  }
}

const REFUSALS: Record<Exclude<Capability, "any">, string> = {
  view: "look at these books",
  edit: "record transactions",
  settings: "change company settings",
  users: "manage users",
  time: "enter time and mileage",
  payroll: "open payroll or the employee roster",
};

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const capability = capabilityOf(command);
  if (capability !== "any" && !can(capability)) {
    throw new Error(
      `${actingUser?.name ?? "This user"} has ${ACCESS_LABELS[actingRole()].toLowerCase()} access, so they cannot ${REFUSALS[capability]}. An admin can change this in Settings, under Users and access.`,
    );
  }
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
  previewPayroll: (input: PayrollInput) => call<PayrollRun>("preview_payroll", { input }),
  savePayroll: (input: PayrollInput) => call<PayrollRun>("save_payroll", { input }),
  deletePayroll: (id: number) => call<void>("delete_payroll", { id }),

  // The payroll roster — people you pay, whether or not they open this file
  listEmployees: () => call<Employee[]>("list_employees"),
  saveEmployee: (input: EmployeeInput) => call<Employee>("save_employee", { input }),
  deleteEmployee: (id: number) => call<void>("delete_employee", { id }),
  mileageDue: (employeeId: number | null) => call<MileageDue>("mileage_due", { employeeId }),

  // Quotes and orders, on the way to an invoice
  listEstimates: () => call<Estimate[]>("list_estimates"),
  getEstimate: (id: number) => call<Estimate>("get_estimate", { id }),
  saveEstimate: (input: EstimateInput) => call<Estimate>("save_estimate", { input }),
  deleteEstimate: (id: number) => call<void>("delete_estimate", { id }),
  convertEstimateToOrder: (id: number, orderDate?: string | null) =>
    call<SalesOrder>("convert_estimate_to_order", { id, orderDate: orderDate ?? null }),
  convertEstimateToInvoice: (id: number, invoiceDate?: string | null) =>
    call<Invoice>("convert_estimate_to_invoice", { id, invoiceDate: invoiceDate ?? null }),
  listSalesOrders: () => call<SalesOrder[]>("list_sales_orders"),
  getSalesOrder: (id: number) => call<SalesOrder>("get_sales_order", { id }),
  saveSalesOrder: (input: SalesOrderInput) => call<SalesOrder>("save_sales_order", { input }),
  deleteSalesOrder: (id: number) => call<void>("delete_sales_order", { id }),
  convertSalesOrderToInvoice: (id: number, invoiceDate?: string | null) =>
    call<Invoice>("convert_sales_order_to_invoice", { id, invoiceDate: invoiceDate ?? null }),

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

  // Credit memos
  listCreditMemos: () => call<CreditMemo[]>("list_credit_memos"),
  getCreditMemo: (id: number) => call<CreditMemo>("get_credit_memo", { id }),
  saveCreditMemo: (input: CreditMemoInput) => call<CreditMemo>("save_credit_memo", { input }),
  deleteCreditMemo: (id: number) => call<void>("delete_credit_memo", { id }),
  voidCreditMemo: (id: number) => call<void>("void_credit_memo", { id }),

  // People and access
  currentUser: () => call<User>("current_user"),
  switchUser: (id: number) => call<User>("switch_user", { id }),
  listPeople: () => call<Person[]>("list_people"),
  listUsers: () => call<User[]>("list_users"),
  saveUser: (input: UserInput) => call<User>("save_user", { input }),
  deleteUser: (id: number) => call<void>("delete_user", { id }),

  // Billable time and mileage
  listTimeEntries: () => call<TimeEntry[]>("list_time_entries"),
  saveTimeEntry: (input: TimeEntryInput) => call<TimeEntry>("save_time_entry", { input }),
  deleteTimeEntry: (id: number) => call<void>("delete_time_entry", { id }),

  // Paperwork saved to the user's computer
  saveDocument: (fileName: string, contents: string) =>
    call<string>("save_document", { fileName, contents }),

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
