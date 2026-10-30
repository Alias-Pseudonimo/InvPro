/**
 * Browser-only stand-in for the Tauri backend, so the app can be reviewed in a
 * plain preview. It mirrors the command names and record shapes of
 * `accounting-core`, and it seeds a small demo company so the screens are
 * populated. It is NOT the accounting engine: the desktop build always writes
 * through SQLite, and the report numbers here are simplified preview maths.
 */
import type {
  Account,
  AccountBalance,
  AccountType,
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
  InvoiceLine,
  JournalEntryInput,
  LedgerHealth,
  PartyInput,
  PayrollInput,
  PayrollRun,
  ProfitAndLoss,
  Purchase,
  PurchaseInput,
  PurchaseLine,
  RecurringFrequency,
  RecurringInvoice,
  RecurringInvoiceInput,
  TaxSummary,
  TrialBalanceReport,
  Vendor,
} from "./types";

const CHART: Array<[string, string, AccountType, string]> = [
  ["1000", "Checking", "ASSET", "Bank"],
  ["1100", "Accounts Receivable", "ASSET", "Accounts Receivable"],
  ["1200", "Inventory", "ASSET", "Inventory"],
  ["2000", "Accounts Payable", "LIABILITY", "Accounts Payable"],
  ["2200", "Sales Tax Payable", "LIABILITY", "Other Current Liability"],
  ["2300", "Payroll Liabilities", "LIABILITY", "Other Current Liability"],
  ["3000", "Owner's Equity", "EQUITY", "Equity"],
  ["4000", "Sales Revenue", "INCOME", "Sales"],
  ["4100", "Contract Revenue", "INCOME", "Service"],
  ["4200", "Service Revenue", "INCOME", "Service"],
  ["5000", "Cost of Goods Sold", "COGS", "Cost of Goods Sold"],
  ["6100", "Materials", "EXPENSE", "Operating Expense"],
  ["6200", "Vehicle & Fuel", "EXPENSE", "Operating Expense"],
  ["6300", "Payroll Expense", "EXPENSE", "Payroll"],
  ["6400", "Insurance", "EXPENSE", "Operating Expense"],
  ["6500", "Equipment Rental", "EXPENSE", "Operating Expense"],
];

interface MockLine {
  accountId: number;
  debitCents: number;
  creditCents: number;
  memo: string;
}

interface State {
  accounts: Account[];
  entries: EntrySummary[];
  linesByEntry: Map<number, MockLine[]>;
  audit: AuditRow[];
  companies: CompanySummary[];
  active: CompanySummary | null;
  customers: Customer[];
  vendors: Vendor[];
  items: InventoryItem[];
  income: IncomeRecord[];
  expenses: ExpenseRecord[];
  invoices: Invoice[];
  /* Invoices the mock created from an income record, removed with it. */
  autoInvoices: number[];
  recurring: RecurringInvoice[];
  purchases: Purchase[];
  payroll: PayrollRun[];
  settings: Record<string, string>;
  next: Record<string, number>;
}

const DEBIT_NORMAL: AccountType[] = ["ASSET", "COGS", "EXPENSE", "OTHER_EXPENSE"];

function emptyState(): State {
  return {
    accounts: [],
    entries: [],
    linesByEntry: new Map(),
    audit: [],
    companies: [],
    active: null,
    customers: [],
    vendors: [],
    items: [],
    income: [],
    expenses: [],
    invoices: [],
    autoInvoices: [],
    recurring: [],
    purchases: [],
    payroll: [],
    settings: { currency: "USD", invoice_income_account: "Sales Revenue" },
    next: {},
  };
}

let state: State = emptyState();

function id(kind: string): number {
  state.next[kind] = (state.next[kind] ?? 0) + 1;
  return state.next[kind];
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, lastDay));
  return value.toISOString().slice(0, 10);
}

function advance(date: string, frequency: RecurringFrequency): string {
  if (frequency === "Weekly") return addDays(date, 7);
  if (frequency === "Quarterly") return addMonths(date, 3);
  if (frequency === "Yearly") return addMonths(date, 12);
  return addMonths(date, 1);
}

function auditRow(action: string, entity: string, entityId: number, after: unknown) {
  state.audit.unshift({
    seq: state.audit.length + 1,
    at: new Date().toISOString(),
    actor: "preview",
    action,
    entity,
    entityId,
    beforeJson: null,
    afterJson: JSON.stringify(after),
    hash: `preview-${String(state.audit.length + 1).padStart(4, "0")}`,
  });
}

function seedCompany(name: string, currency: string): CompanySummary {
  const slug = name.replace(/[^A-Za-z0-9 _&-]/g, "_");
  return {
    path: `preview/${slug}.ledgerdb`,
    fileName: `${slug}.ledgerdb`,
    name,
    legalName: null,
    fileId: `preview-${Date.now()}`,
    baseCurrency: currency,
    fiscalYearStartMonth: 1,
    schemaVersion: 2,
    sizeBytes: 61_440,
    modifiedAt: String(Math.floor(Date.now() / 1000)),
  };
}

/* ------------------------------------------------------------------ */
/* Demo data                                                          */
/* ------------------------------------------------------------------ */

function seed() {
  state = emptyState();
  for (const [number, accountName, accountType, subtype] of CHART) {
    state.accounts.push({
      id: id("account"),
      number,
      name: accountName,
      accountType,
      subtype,
      parentId: null,
      currency: null,
      description: null,
      isActive: true,
      hasChildren: false,
      normalBalance: DEBIT_NORMAL.includes(accountType) ? "DEBIT" : "CREDIT",
    });
  }
  auditRow("INSERT", "accounts", state.accounts.length, { number: CHART.length });
  state.settings.company_name = `Riverbend Contracting LLC`;

  const customer = (name: string, email: string, phone: string, address: string): Customer => {
    const record: Customer = {
      id: id("customer"),
      name,
      email,
      phone,
      address,
      notes: "",
      isActive: true,
      billedCents: 0,
      outstandingCents: 0,
    };
    state.customers.push(record);
    return record;
  };
  const vendor = (name: string, email: string, phone: string): Vendor => {
    const record: Vendor = {
      id: id("vendor"),
      name,
      email,
      phone,
      address: "",
      notes: "",
      isActive: true,
      spentCents: 0,
      outstandingCents: 0,
    };
    state.vendors.push(record);
    return record;
  };

  const alameda = customer("Alameda Property Group", "ap@alamedaprop.example", "555-0142", "220 Harbor Way, Alameda, CA");
  const nguyen = customer("Nguyen Family Trust", "dnguyen@example.com", "555-0110", "88 Foothill Rd, San Jose, CA");
  const brightleaf = customer("Bright Leaf Cafe", "ops@brightleaf.example", "555-0199", "14 Main St, Santa Cruz, CA");
  customer("Castellano Residence", "m.castellano@example.com", "555-0176", "9 Ridge Ct, Los Gatos, CA");

  const lumber = vendor("Bay Lumber Supply", "orders@baylumber.example", "510-555-0177");
  const rental = vendor("ProTools Rental", "rentals@protools.example", "510-555-0188");
  const fuel = vendor("Valley Fuel Co.", "", "800-555-0199");
  vendor("SafeGuard Insurance", "billing@safeguard.example", "800-555-0122");

  const item = (
    name: string,
    sku: string,
    category: string,
    kind: InventoryItem["kind"],
    qty: number,
    cost: number,
    price: number,
  ): InventoryItem => {
    const record: InventoryItem = {
      id: id("item"),
      name,
      sku,
      barcode: "",
      category,
      kind,
      qtyHundredths: qty * 100,
      unitCostCents: cost,
      salePriceCents: price,
      isActive: true,
      stockValueCents: qty * cost,
    };
    state.items.push(record);
    return record;
  };

  const posts = item("Cedar fence post 4x4x8", "FP-408", "Lumber", "Product", 34, 1_450, 2_400);
  item("Composite decking board 12ft", "DK-12C", "Lumber", "Product", 58, 2_200, 3_600);
  item("Exterior deck screws (5lb)", "SC-5LB", "Fasteners", "Product", 12, 1_900, 2_900);
  item("Quarterly maintenance visit", "", "Service", "Service", 0, 0, 42_000);

  const income = (
    date: string,
    who: Customer,
    category: string,
    description: string,
    amount: number,
    taxBp: number,
    paid: boolean,
    invoiceNo: string,
  ) => {
    const tax = Math.round((amount * taxBp) / 10_000);
    const record: IncomeRecord = {
      id: id("income"),
      entryDate: date,
      customerId: who.id,
      customerName: who.name,
      category,
      description,
      amountCents: amount,
      taxBp,
      taxCents: tax,
      totalCents: amount + tax,
      isPaid: paid,
      invoiceNo,
      invoiceId: null,
      journalEntryId: id("entry"),
    };
    state.income.push(record);
    return record;
  };

  income("2026-06-03", alameda, "Contract Revenue", "Deck rebuild — phase 1", 420_000, 0, true, "INV-1001");
  income("2026-06-11", nguyen, "Contract Revenue", "Kitchen remodel deposit", 600_000, 0, true, "INV-1002");
  income("2026-06-20", brightleaf, "Service Revenue", "Walk-in cooler repair", 87_500, 850, false, "INV-1003");
  income("2026-07-22", nguyen, "Change Order Revenue", "Kitchen — added cabinetry", 145_000, 0, true, "INV-1006");

  const expense = (
    date: string,
    who: Vendor,
    category: string,
    description: string,
    amount: number,
    taxBp: number,
    paid: boolean,
  ) => {
    const tax = Math.round((amount * taxBp) / 10_000);
    const record: ExpenseRecord = {
      id: id("expense"),
      entryDate: date,
      vendorId: who.id,
      vendorName: who.name,
      category,
      description,
      amountCents: amount,
      taxBp,
      taxCents: tax,
      totalCents: amount + tax,
      isPaid: paid,
      journalEntryId: id("entry"),
    };
    state.expenses.push(record);
    return record;
  };

  expense("2026-06-05", lumber, "Materials", "Decking boards + hardware", 162_000, 850, true);
  expense("2026-06-14", rental, "Equipment Rental", "Tile saw rental — 3 days", 21_000, 850, true);
  expense("2026-06-28", fuel, "Vehicle & Fuel", "Fuel — June", 34_000, 0, true);
  expense("2026-07-10", state.vendors[3], "Insurance", "General liability — Q3", 61_000, 0, true);
  expense("2026-08-02", fuel, "Vehicle & Fuel", "Fuel — July", 29_500, 0, false);

  const line = (description: string, qty: number, price: number, inventoryItemId: number | null): InvoiceLine => ({
    id: id("invoice_line"),
    position: 0,
    description,
    qtyHundredths: qty * 100,
    unitPriceCents: price,
    amountCents: Math.round(qty * price),
    inventoryItemId,
  });

  const invoice = (
    no: string,
    who: Customer,
    date: string,
    dueDate: string | null,
    status: Invoice["status"],
    lines: InvoiceLine[],
    taxBp: number,
  ): Invoice => {
    lines.forEach((invoiceLine, index) => (invoiceLine.position = index + 1));
    const subtotal = lines.reduce((sum, invoiceLine) => sum + invoiceLine.amountCents, 0);
    const tax = Math.round((subtotal * taxBp) / 10_000);
    const record: Invoice = {
      id: id("invoice"),
      invoiceNo: no,
      customerId: who.id,
      customerName: who.name,
      invoiceDate: date,
      dueDate,
      status,
      taxBp,
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: subtotal + tax,
      stockDeducted: status !== "Draft",
      lines,
    };
    state.invoices.push(record);
    return record;
  };

  invoice("INV-1005", alameda, "2026-07-15", "2026-08-14", "Sent", [
    line("Deck rebuild — phase 2 labor", 1, 320_000, null),
    line("Sealant & finishing", 1, 60_000, null),
  ], 0);
  invoice("INV-1008", state.customers[3], "2026-08-05", "2026-09-04", "Draft", [
    line("Gate hardware", 2, 8_500, null),
    line("Fence staining", 1, 52_000, null),
  ], 0);

  const purchase = (): Purchase => {
    const lines: PurchaseLine[] = [
      {
        id: id("purchase_line"),
        position: 1,
        description: posts.name,
        qtyHundredths: 1_000,
        unitCostCents: 1_450,
        salePriceCents: 2_400,
        amountCents: 14_500,
        inventoryItemId: posts.id,
      },
    ];
    const record: Purchase = {
      id: id("purchase"),
      purchaseDate: "2026-07-19",
      vendorId: lumber.id,
      vendorName: lumber.name,
      category: "Materials",
      note: "Bulk buy while prices were low",
      isPaid: true,
      totalCents: lines.reduce((sum, purchaseLine) => sum + purchaseLine.amountCents, 0),
      lines,
    };
    state.purchases.push(record);
    return record;
  };
  purchase();

  const payRun = (employee: string, date: string, rate: number, regular: number, overtime: number, deductions: [number, number, number, number], check: string) => {
    const gross = Math.round(rate * regular + rate * 1.5 * overtime);
    const [federal, stateTax, social, medicare] = deductions;
    const totalDeductions = federal + stateTax + social + medicare;
    const record: PayrollRun = {
      id: id("payroll"),
      employee,
      payDate: date,
      checkNumber: check,
      payRateCents: rate,
      regularHoursHundredths: regular * 100,
      overtimeHoursHundredths: overtime * 100,
      grossCents: gross,
      federalCents: federal,
      stateCents: stateTax,
      socialSecurityCents: social,
      medicareCents: medicare,
      otherDeductionsCents: 0,
      totalDeductionsCents: totalDeductions,
      netCents: gross - totalDeductions,
      journalEntryId: id("entry"),
    };
    state.payroll.push(record);
    return record;
  };

  payRun("J. Alvarez", "2026-07-31", 4_000, 80, 5, [42_000, 14_000, 21_740, 5_085], "1058");
  payRun("T. Okafor", "2026-07-31", 3_500, 80, 0, [33_600, 11_200, 17_360, 4_060], "1059");

  state.settings.company_name = "Riverbend Contracting LLC";
  state.settings.cash_account = String(state.accounts.find((account) => account.number === "1000")?.id ?? 1);
  state.settings.receivable_account = String(state.accounts.find((account) => account.number === "1100")?.id ?? 2);
  state.settings.payable_account = String(state.accounts.find((account) => account.number === "2000")?.id ?? 3);
  state.settings.sales_tax_account = String(state.accounts.find((account) => account.number === "2200")?.id ?? 4);
}

/* ------------------------------------------------------------------ */
/* Derived numbers (preview maths)                                    */
/* ------------------------------------------------------------------ */

function totals() {
  const invoiceRevenue = state.invoices.filter((invoice) => invoice.status !== "Draft").reduce((sum, invoice) => sum + invoice.subtotalCents, 0);
  const invoiceTax = state.invoices.filter((invoice) => invoice.status !== "Draft").reduce((sum, invoice) => sum + invoice.taxCents, 0);
  const income = state.income.reduce((sum, record) => sum + record.amountCents, 0) + invoiceRevenue;
  const expenses = state.expenses.reduce((sum, record) => sum + record.totalCents, 0)
    + state.purchases.reduce((sum, record) => sum + record.totalCents, 0)
    + state.payroll.reduce((sum, record) => sum + record.grossCents, 0);
  const cash = state.income.filter((record) => record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    + state.invoices.filter((invoice) => invoice.status === "Paid").reduce((sum, invoice) => sum + invoice.totalCents, 0)
    - state.expenses.filter((record) => record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    - state.purchases.filter((record) => record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    - state.payroll.reduce((sum, record) => sum + record.netCents, 0);
  const receivable = state.income.filter((record) => !record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    + state.invoices.filter((invoice) => invoice.status === "Sent").reduce((sum, invoice) => sum + invoice.totalCents, 0);
  const payable = state.expenses.filter((record) => !record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    + state.purchases.filter((record) => !record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    + state.payroll.reduce((sum, record) => sum + record.totalDeductionsCents, 0);
  const inventory = state.items.reduce((sum, item) => sum + item.stockValueCents, 0);
  const taxCollected = state.income.reduce((sum, record) => sum + record.taxCents, 0) + invoiceTax;
  return { income, expenses, cash, receivable, payable, inventory, taxCollected };
}

function groupByCategory(records: Array<{ category: string; amountCents: number }>): AccountBalance[] {
  const map = new Map<string, number>();
  for (const record of records) {
    map.set(record.category, (map.get(record.category) ?? 0) + record.amountCents);
  }
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, amountCents], index) => ({ accountId: -(index + 1), number: "", name, amountCents }));
}

function profitAndLoss(): ProfitAndLoss {
  const incomeRows = [
    ...state.income.map((record) => ({ category: record.category, amountCents: record.amountCents })),
    ...state.invoices
      .filter((invoice) => invoice.status !== "Draft")
      .map((invoice) => ({ category: state.settings.invoice_income_account ?? "Sales Revenue", amountCents: invoice.subtotalCents })),
  ];
  const expenseRows = [
    ...state.expenses.map((record) => ({ category: record.category, amountCents: record.totalCents })),
    ...state.purchases.map((record) => ({ category: record.category, amountCents: record.totalCents })),
    ...state.payroll.map((record) => ({ category: "Payroll Expense", amountCents: record.grossCents })),
  ];
  const income = groupByCategory(incomeRows);
  const expenses = groupByCategory(expenseRows);
  const totalIncomeCents = income.reduce((sum, row) => sum + row.amountCents, 0);
  const totalExpenseCents = expenses.reduce((sum, row) => sum + row.amountCents, 0);
  return {
    from: null,
    to: null,
    income,
    expenses,
    totalIncomeCents,
    totalExpenseCents,
    netCents: totalIncomeCents - totalExpenseCents,
  };
}

function balanceSheet(): BalanceSheet {
  const numbers = totals();
  const net = numbers.income - numbers.expenses;
  const assets: AccountBalance[] = [
    { accountId: 1, number: "1000", name: "Checking", amountCents: numbers.cash },
    { accountId: 2, number: "1100", name: "Accounts Receivable", amountCents: numbers.receivable },
    { accountId: 3, number: "1200", name: "Inventory", amountCents: numbers.inventory },
  ].filter((row) => row.amountCents !== 0);
  const liabilities: AccountBalance[] = [
    { accountId: 4, number: "2000", name: "Accounts Payable", amountCents: numbers.payable },
    { accountId: 5, number: "2200", name: "Sales Tax Payable", amountCents: numbers.taxCollected },
  ].filter((row) => row.amountCents !== 0);
  const totalAssets = assets.reduce((sum, row) => sum + row.amountCents, 0);
  const totalLiabilities = liabilities.reduce((sum, row) => sum + row.amountCents, 0);
  const equity: AccountBalance[] = [
    { accountId: 6, number: "3900", name: "Owner's equity & earnings", amountCents: totalAssets - totalLiabilities },
  ];
  return {
    asOf: null,
    assets,
    liabilities,
    equity,
    netIncomeCents: net,
    totalAssetsCents: totalAssets,
    totalLiabilitiesCents: totalLiabilities,
    totalEquityCents: totalAssets - totalLiabilities,
    balanced: true,
  };
}

function trialBalance(): TrialBalanceReport {
  const rows = state.accounts.map((account) => {
    const debitNormal = DEBIT_NORMAL.includes(account.accountType);
    return {
      accountId: account.id,
      number: account.number,
      name: account.name,
      accountType: account.accountType,
      normalBalance: account.normalBalance,
      debitCents: 0,
      creditCents: 0,
      balanceCents: 0,
      debitNormal,
    };
  });
  return {
    rows: rows.map(({ debitNormal: _ignored, ...row }) => row),
    totalDebitCents: 0,
    totalCreditCents: 0,
    isBalanced: true,
    asOf: null,
  };
}

/* ------------------------------------------------------------------ */
/* Commands                                                           */
/* ------------------------------------------------------------------ */

function requireOpen() {
  if (!state.active) throw new Error("no company file is open");
}

function partyFrom(input: PartyInput, existing?: { id: number }): { id: number; name: string; email: string; phone: string; address: string; notes: string } {
  return {
    id: input.id ?? existing?.id ?? id("customer"),
    name: input.name?.trim() || "Unnamed",
    email: input.email?.trim() ?? "",
    phone: input.phone?.trim() ?? "",
    address: input.address?.trim() ?? "",
    notes: input.notes?.trim() ?? "",
  };
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const payload = (args ?? {}) as Record<string, any>;

  switch (command) {
    case "list_companies":
      return state.companies.slice() as T;

    case "companies_directory":
      return "Preview mode — company files are kept in memory" as T;

    case "create_company": {
      const input = payload.input as { name: string; baseCurrency?: string };
      if (!input?.name?.trim()) throw new Error("a company name is required");
      seed();
      const record = seedCompany(input.name.trim(), input.baseCurrency ?? "USD");
      state.companies = [...state.companies, record];
      state.active = record;
      return record as T;
    }

    case "open_company": {
      const input = payload.input as { path: string };
      const record = state.companies.find((candidate) => candidate.path === input.path);
      if (!record) throw new Error("that company file could not be opened");
      seed();
      state.active = record;
      return record as T;
    }

    case "close_company":
      state.active = null;
      return undefined as T;

    case "current_company":
      return state.active as T;

    case "list_customers": {
      requireOpen();
      return state.customers.map((customer) => {
        const billed = state.income
          .filter((record) => record.customerId === customer.id)
          .reduce((sum, record) => sum + record.totalCents, 0);
        const outstanding = state.income
          .filter((record) => record.customerId === customer.id && !record.isPaid)
          .reduce((sum, record) => sum + record.totalCents, 0);
        return { ...customer, billedCents: billed, outstandingCents: outstanding };
      }) as T;
    }

    case "save_customer": {
      requireOpen();
      const input = payload.input as PartyInput;
      const existing = state.customers.find((customer) => customer.id === input.id);
      const base = partyFrom(input, existing);
      if (existing) Object.assign(existing, base, { isActive: true });
      else state.customers.push({ ...base, isActive: true, billedCents: 0, outstandingCents: 0 });
      auditRow(existing ? "UPDATE" : "INSERT", "customers", base.id, base);
      return (existing ?? state.customers[state.customers.length - 1]) as T;
    }

    case "delete_customer": {
      requireOpen();
      const customerId = payload.id as number;
      if (state.income.some((record) => record.customerId === customerId)) {
        throw new Error("this customer already has income recorded against them; deactivate them instead so the history stays intact");
      }
      state.customers = state.customers.filter((customer) => customer.id !== customerId);
      return undefined as T;
    }

    case "list_vendors": {
      requireOpen();
      return state.vendors.map((vendor) => {
        const spent = state.expenses
          .filter((record) => record.vendorId === vendor.id)
          .reduce((sum, record) => sum + record.totalCents, 0);
        const outstanding = state.expenses
          .filter((record) => record.vendorId === vendor.id && !record.isPaid)
          .reduce((sum, record) => sum + record.totalCents, 0);
        return { ...vendor, spentCents: spent, outstandingCents: outstanding };
      }) as T;
    }

    case "save_vendor": {
      requireOpen();
      const input = payload.input as PartyInput;
      const existing = state.vendors.find((vendor) => vendor.id === input.id);
      const base = partyFrom(input, existing);
      if (existing) Object.assign(existing, base, { isActive: true });
      else state.vendors.push({ ...base, isActive: true, spentCents: 0, outstandingCents: 0 });
      auditRow(existing ? "UPDATE" : "INSERT", "vendors", base.id, base);
      return (existing ?? state.vendors[state.vendors.length - 1]) as T;
    }

    case "delete_vendor": {
      requireOpen();
      const vendorId = payload.id as number;
      if (state.expenses.some((record) => record.vendorId === vendorId)) {
        throw new Error("this vendor already has spending recorded against them; deactivate them instead so the history stays intact");
      }
      state.vendors = state.vendors.filter((vendor) => vendor.id !== vendorId);
      return undefined as T;
    }

    case "list_income":
      requireOpen();
      return state.income.slice().sort((left, right) => right.entryDate.localeCompare(left.entryDate)) as T;

    case "save_income": {
      requireOpen();
      const input = payload.input as IncomeInput;
      const tax = Math.round((input.amountCents * (input.taxBp ?? 0)) / 10_000);
      const customer = state.customers.find((candidate) => candidate.id === input.customerId);
      const previous = state.income.find((candidate) => candidate.id === input.id);
      const number = (input.invoiceNo ?? "").trim();

      // An invoice number on an income record means exactly one invoice: created
      // from the income if the number is new, settled if it already exists.
      let invoiceId: number | null = null;
      if (number) {
        let invoice = state.invoices.find(
          (candidate) => candidate.invoiceNo.toLowerCase() === number.toLowerCase(),
        );
        if (invoice && invoice.id !== previous?.invoiceId) {
          if (invoice.status === "Paid") {
            throw new Error(`invoice ${invoice.invoiceNo} is already paid; this income would be counted twice`);
          }
          if (invoice.status === "Draft") {
            throw new Error(`invoice ${invoice.invoiceNo} is still a draft — send it first, or record this income without the invoice number`);
          }
        }
        if (!invoice && previous?.invoiceId && state.autoInvoices.includes(previous.invoiceId)) {
          invoice = state.invoices.find((candidate) => candidate.id === previous.invoiceId);
        }
        if (invoice) {
          // Only the invoice this income created follows the edit; one that was
          // already there keeps its own date and amount.
          if (state.autoInvoices.includes(invoice.id)) {
            invoice.invoiceNo = number;
            invoice.invoiceDate = input.entryDate;
            invoice.lines = [
              {
                id: invoice.lines[0]?.id ?? id("invoice_line"),
                position: 1,
                description: (input.description ?? "").trim() || input.category,
                qtyHundredths: 100,
                unitPriceCents: input.amountCents,
                amountCents: input.amountCents,
                inventoryItemId: null,
              },
            ];
            invoice.subtotalCents = input.amountCents;
            invoice.taxCents = tax;
            invoice.totalCents = input.amountCents + tax;
          }
          if (invoice.status === "Sent" && input.isPaid) invoice.status = "Paid";
        } else {
          const description = (input.description ?? "").trim() || input.category;
          invoice = {
            id: id("invoice"),
            invoiceNo: number,
            customerId: input.customerId ?? null,
            customerName: customer?.name ?? "",
            invoiceDate: input.entryDate,
            dueDate: null,
            status: input.isPaid ? "Paid" : "Sent",
            taxBp: input.taxBp ?? 0,
            subtotalCents: input.amountCents,
            taxCents: tax,
            totalCents: input.amountCents + tax,
            stockDeducted: false,
            lines: [
              {
                id: id("invoice_line"),
                position: 1,
                description,
                qtyHundredths: 100,
                unitPriceCents: input.amountCents,
                amountCents: input.amountCents,
                inventoryItemId: null,
              },
            ],
          };
          state.invoices.push(invoice);
          state.autoInvoices.push(invoice.id);
        }
        invoiceId = invoice.id;
      }

      if (previous?.invoiceId && state.autoInvoices.includes(previous.invoiceId) && previous.invoiceId !== invoiceId) {
        state.invoices = state.invoices.filter((candidate) => candidate.id !== previous.invoiceId);
        state.autoInvoices = state.autoInvoices.filter((candidate) => candidate !== previous.invoiceId);
      }

      const record: IncomeRecord = {
        id: input.id ?? id("income"),
        entryDate: input.entryDate,
        customerId: input.customerId ?? null,
        customerName: customer?.name ?? "",
        category: input.category,
        description: input.description ?? "",
        amountCents: input.amountCents,
        taxBp: input.taxBp ?? 0,
        taxCents: tax,
        totalCents: input.amountCents + tax,
        isPaid: Boolean(input.isPaid),
        invoiceNo: number,
        invoiceId,
        journalEntryId: invoiceId ? null : id("entry"),
      };
      const index = state.income.findIndex((candidate) => candidate.id === record.id);
      if (index >= 0) state.income[index] = record;
      else state.income.push(record);
      auditRow(index >= 0 ? "UPDATE" : "INSERT", "income_records", record.id, record);
      return record as T;
    }

    case "delete_income": {
      requireOpen();
      const record = state.income.find((candidate) => candidate.id === payload.id);
      if (record?.invoiceId && state.autoInvoices.includes(record.invoiceId)) {
        state.invoices = state.invoices.filter((candidate) => candidate.id !== record.invoiceId);
        state.autoInvoices = state.autoInvoices.filter((candidate) => candidate !== record.invoiceId);
      }
      state.income = state.income.filter((candidate) => candidate.id !== payload.id);
      return undefined as T;
    }

    case "list_expenses":
      requireOpen();
      return state.expenses.slice().sort((left, right) => right.entryDate.localeCompare(left.entryDate)) as T;

    case "save_expense": {
      requireOpen();
      const input = payload.input as ExpenseInput;
      const tax = Math.round((input.amountCents * (input.taxBp ?? 0)) / 10_000);
      const vendor = state.vendors.find((candidate) => candidate.id === input.vendorId);
      const record: ExpenseRecord = {
        id: input.id ?? id("expense"),
        entryDate: input.entryDate,
        vendorId: input.vendorId ?? null,
        vendorName: vendor?.name ?? "",
        category: input.category,
        description: input.description ?? "",
        amountCents: input.amountCents,
        taxBp: input.taxBp ?? 0,
        taxCents: tax,
        totalCents: input.amountCents + tax,
        isPaid: Boolean(input.isPaid),
        journalEntryId: id("entry"),
      };
      const index = state.expenses.findIndex((candidate) => candidate.id === record.id);
      if (index >= 0) state.expenses[index] = record;
      else state.expenses.push(record);
      auditRow(index >= 0 ? "UPDATE" : "INSERT", "expense_records", record.id, record);
      return record as T;
    }

    case "delete_expense":
      requireOpen();
      state.expenses = state.expenses.filter((record) => record.id !== payload.id);
      return undefined as T;

    case "list_inventory":
      requireOpen();
      return state.items
        .map((item) => ({
          ...item,
          stockValueCents: Math.round((item.qtyHundredths * item.unitCostCents) / 100),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)) as T;

    case "save_inventory_item": {
      requireOpen();
      const input = payload.input as InventoryInput;
      const record: InventoryItem = {
        id: input.id ?? id("item"),
        name: input.name.trim(),
        sku: input.sku?.trim() ?? "",
        barcode: input.barcode?.trim() ?? "",
        category: input.category?.trim() ?? "",
        kind: input.kind ?? "Product",
        qtyHundredths: input.qtyHundredths ?? 0,
        unitCostCents: input.unitCostCents ?? 0,
        salePriceCents: input.salePriceCents ?? 0,
        isActive: true,
        stockValueCents: Math.round(((input.qtyHundredths ?? 0) * (input.unitCostCents ?? 0)) / 100),
      };
      const index = state.items.findIndex((item) => item.id === record.id);
      if (index >= 0) state.items[index] = record;
      else state.items.push(record);
      return record as T;
    }

    case "delete_inventory_item":
      requireOpen();
      state.items = state.items.filter((item) => item.id !== payload.id);
      return undefined as T;

    case "list_invoices":
      requireOpen();
      return state.invoices.slice().sort((left, right) => right.invoiceDate.localeCompare(left.invoiceDate)) as T;

    case "get_invoice": {
      requireOpen();
      const invoice = state.invoices.find((candidate) => candidate.id === payload.id);
      if (!invoice) throw new Error("invoice does not exist");
      return invoice as T;
    }

    case "save_invoice": {
      requireOpen();
      const input = payload.input as InvoiceInput;
      const lines: InvoiceLine[] = input.lines.map((line, index) => ({
        id: id("invoice_line"),
        position: index + 1,
        description: line.description,
        qtyHundredths: line.qtyHundredths,
        unitPriceCents: line.unitPriceCents,
        amountCents: Math.round((line.qtyHundredths * line.unitPriceCents) / 100),
        inventoryItemId: line.inventoryItemId ?? null,
      }));
      const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
      const tax = Math.round((subtotal * input.taxBp) / 10_000);
      const customer = state.customers.find((candidate) => candidate.id === input.customerId);
      const existing = state.invoices.find((candidate) => candidate.id === input.id);
      const record: Invoice = {
        id: input.id ?? id("invoice"),
        invoiceNo: input.invoiceNo?.trim() || `INV-${1000 + state.invoices.length + 1}`,
        customerId: input.customerId ?? null,
        customerName: customer?.name ?? "",
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        status: input.status,
        taxBp: input.taxBp,
        subtotalCents: subtotal,
        taxCents: tax,
        totalCents: subtotal + tax,
        stockDeducted: input.status !== "Draft",
        lines,
      };
      if (existing) {
        // Put back what the old version took out, then apply the new version.
        if (existing.stockDeducted) {
          for (const line of existing.lines) {
            if (!line.inventoryItemId) continue;
            const item = state.items.find((candidate) => candidate.id === line.inventoryItemId);
            if (item) item.qtyHundredths += line.qtyHundredths;
          }
        }
        Object.assign(existing, record);
      } else {
        state.invoices.push(record);
      }
      if (record.status !== "Draft") {
        for (const line of lines) {
          if (!line.inventoryItemId) continue;
          const item = state.items.find((candidate) => candidate.id === line.inventoryItemId);
          if (item) item.qtyHundredths = Math.max(0, item.qtyHundredths - line.qtyHundredths);
        }
      }
      auditRow(existing ? "UPDATE" : "INSERT", "invoices", record.id, record);
      return record as T;
    }

    case "delete_invoice": {
      requireOpen();
      const invoice = state.invoices.find((candidate) => candidate.id === payload.id);
      if (invoice?.stockDeducted) {
        for (const line of invoice.lines) {
          if (!line.inventoryItemId) continue;
          const item = state.items.find((candidate) => candidate.id === line.inventoryItemId);
          if (item) item.qtyHundredths += line.qtyHundredths;
        }
      }
      state.invoices = state.invoices.filter((candidate) => candidate.id !== payload.id);
      return undefined as T;
    }

    case "list_recurring_invoices":
      requireOpen();
      return state.recurring
        .slice()
        .sort((left, right) => left.nextDate.localeCompare(right.nextDate)) as T;

    case "save_recurring_invoice": {
      requireOpen();
      const input = payload.input as RecurringInvoiceInput;
      const lines: InvoiceLine[] = input.lines.map((line, index) => ({
        id: id("recurring_line"),
        position: index + 1,
        description: line.description,
        qtyHundredths: line.qtyHundredths,
        unitPriceCents: line.unitPriceCents,
        amountCents: Math.round((line.qtyHundredths * line.unitPriceCents) / 100),
        inventoryItemId: line.inventoryItemId ?? null,
      }));
      const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
      const customer = state.customers.find((candidate) => candidate.id === input.customerId);
      const existing = state.recurring.find((candidate) => candidate.id === input.id);
      const record: RecurringInvoice = {
        id: input.id ?? id("recurring"),
        customerId: input.customerId ?? null,
        customerName: customer?.name ?? "",
        description: input.description ?? "",
        frequency: input.frequency,
        startDate: input.startDate,
        nextDate: existing && existing.nextDate > input.startDate ? existing.nextDate : input.startDate,
        endDate: input.endDate ?? null,
        taxBp: input.taxBp,
        isActive: input.isActive ?? true,
        subtotalCents: subtotal,
        totalCents: subtotal + Math.round((subtotal * input.taxBp) / 10_000),
        lines,
      };
      if (existing) Object.assign(existing, record);
      else state.recurring.push(record);
      auditRow(existing ? "UPDATE" : "INSERT", "recurring_invoices", record.id, record);
      return record as T;
    }

    case "delete_recurring_invoice":
      requireOpen();
      state.recurring = state.recurring.filter((candidate) => candidate.id !== payload.id);
      return undefined as T;

    case "generate_due_invoices": {
      requireOpen();
      const today = String(payload.today ?? "");
      const due = state.recurring.filter(
        (schedule) =>
          schedule.isActive &&
          schedule.nextDate <= today &&
          (!schedule.endDate || schedule.nextDate <= schedule.endDate),
      );
      const created: Invoice[] = [];
      for (const schedule of due) {
        let next = schedule.nextDate;
        while (next <= today && (!schedule.endDate || next <= schedule.endDate)) {
          const highest = state.invoices.reduce((best, invoice) => {
            const digits = Number(invoice.invoiceNo.split("-").pop());
            return Number.isFinite(digits) ? Math.max(best, digits) : best;
          }, 1000);
          const tax = Math.round((schedule.subtotalCents * schedule.taxBp) / 10_000);
          const record: Invoice = {
            id: id("invoice"),
            invoiceNo: `INV-${highest + 1}`,
            customerId: schedule.customerId,
            customerName: schedule.customerName,
            invoiceDate: next,
            dueDate: addDays(next, 30),
            status: "Sent",
            taxBp: schedule.taxBp,
            subtotalCents: schedule.subtotalCents,
            taxCents: tax,
            totalCents: schedule.subtotalCents + tax,
            stockDeducted: false,
            lines: schedule.lines.map((line) => ({ ...line, id: id("invoice_line") })),
          };
          state.invoices.push(record);
          created.push(record);
          next = advance(next, schedule.frequency);
        }
        schedule.nextDate = next;
        schedule.isActive = !schedule.endDate || next <= schedule.endDate;
      }
      return created as T;
    }

    case "list_purchases":
      requireOpen();
      return state.purchases.slice().sort((left, right) => right.purchaseDate.localeCompare(left.purchaseDate)) as T;

    case "save_purchase": {
      requireOpen();
      const input = payload.input as PurchaseInput;
      const existing = state.purchases.find((candidate) => candidate.id === input.id);
      if (existing) {
        for (const line of existing.lines) {
          if (!line.inventoryItemId) continue;
          const item = state.items.find((candidate) => candidate.id === line.inventoryItemId);
          if (item) item.qtyHundredths = Math.max(0, item.qtyHundredths - line.qtyHundredths);
        }
      }
      const vendor = state.vendors.find((candidate) => candidate.id === input.vendorId);
      const lines: PurchaseLine[] = input.lines.map((line, index) => {
        let itemId = line.inventoryItemId ?? null;
        if (!itemId && line.description.trim()) {
          const created: InventoryItem = {
            id: id("item"),
            name: line.description.trim(),
            sku: "",
            barcode: "",
            category: "",
            kind: "Product",
            qtyHundredths: 0,
            unitCostCents: line.unitCostCents,
            salePriceCents: line.salePriceCents,
            isActive: true,
            stockValueCents: 0,
          };
          state.items.push(created);
          itemId = created.id;
        }
        if (itemId) {
          const item = state.items.find((candidate) => candidate.id === itemId);
          if (item) {
            const totalQty = item.qtyHundredths + line.qtyHundredths;
            item.unitCostCents = totalQty > 0
              ? Math.round((item.qtyHundredths * item.unitCostCents + line.qtyHundredths * line.unitCostCents) / totalQty)
              : line.unitCostCents;
            item.qtyHundredths = totalQty;
            if (line.salePriceCents > 0) item.salePriceCents = line.salePriceCents;
          }
        }
        return {
          id: id("purchase_line"),
          position: index + 1,
          description: line.description,
          qtyHundredths: line.qtyHundredths,
          unitCostCents: line.unitCostCents,
          salePriceCents: line.salePriceCents,
          amountCents: Math.round((line.qtyHundredths * line.unitCostCents) / 100),
          inventoryItemId: itemId,
        };
      });
      const record: Purchase = {
        id: input.id ?? id("purchase"),
        purchaseDate: input.purchaseDate,
        vendorId: input.vendorId ?? null,
        vendorName: vendor?.name ?? "",
        category: input.category,
        note: input.note ?? "",
        isPaid: Boolean(input.isPaid),
        totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
        lines,
      };
      if (existing) Object.assign(existing, record);
      else state.purchases.push(record);
      auditRow(existing ? "UPDATE" : "INSERT", "purchases", record.id, record);
      return record as T;
    }

    case "delete_purchase": {
      requireOpen();
      const purchase = state.purchases.find((candidate) => candidate.id === payload.id);
      if (purchase) {
        for (const line of purchase.lines) {
          if (!line.inventoryItemId) continue;
          const item = state.items.find((candidate) => candidate.id === line.inventoryItemId);
          if (item) item.qtyHundredths = Math.max(0, item.qtyHundredths - line.qtyHundredths);
        }
      }
      state.purchases = state.purchases.filter((candidate) => candidate.id !== payload.id);
      return undefined as T;
    }

    case "list_payroll":
      requireOpen();
      return state.payroll.slice().sort((left, right) => right.payDate.localeCompare(left.payDate)) as T;

    case "save_payroll": {
      requireOpen();
      const input = payload.input as PayrollInput;
      const overtimeRate = Math.round((input.payRateCents * 3) / 2);
      const gross = Math.round((input.regularHoursHundredths * input.payRateCents) / 100)
        + Math.round((input.overtimeHoursHundredths * overtimeRate) / 100);
      const deductions = (input.federalCents ?? 0) + (input.stateCents ?? 0)
        + (input.socialSecurityCents ?? 0) + (input.medicareCents ?? 0)
        + (input.otherDeductionsCents ?? 0);
      if (deductions > gross) throw new Error("deductions cannot exceed gross pay");
      const record: PayrollRun = {
        id: input.id ?? id("payroll"),
        employee: input.employee,
        payDate: input.payDate,
        checkNumber: input.checkNumber ?? "",
        payRateCents: input.payRateCents,
        regularHoursHundredths: input.regularHoursHundredths,
        overtimeHoursHundredths: input.overtimeHoursHundredths,
        grossCents: gross,
        federalCents: input.federalCents ?? 0,
        stateCents: input.stateCents ?? 0,
        socialSecurityCents: input.socialSecurityCents ?? 0,
        medicareCents: input.medicareCents ?? 0,
        otherDeductionsCents: input.otherDeductionsCents ?? 0,
        totalDeductionsCents: deductions,
        netCents: gross - deductions,
        journalEntryId: id("entry"),
      };
      const index = state.payroll.findIndex((candidate) => candidate.id === record.id);
      if (index >= 0) state.payroll[index] = record;
      else state.payroll.push(record);
      return record as T;
    }

    case "delete_payroll":
      requireOpen();
      state.payroll = state.payroll.filter((record) => record.id !== payload.id);
      return undefined as T;

    case "dashboard": {
      requireOpen();
      const numbers = totals();
      const recent = [
        ...state.income.map((record) => ({
          kind: "income",
          date: record.entryDate,
          description: record.description || record.category,
          party: record.customerName,
          amountCents: record.totalCents,
          isPaid: record.isPaid,
        })),
        ...state.expenses.map((record) => ({
          kind: "expense",
          date: record.entryDate,
          description: record.description || record.category,
          party: record.vendorName,
          amountCents: -record.totalCents,
          isPaid: record.isPaid,
        })),
      ]
        .sort((left, right) => right.date.localeCompare(left.date))
        .slice(0, 6);
      const summary: DashboardSummary = {
        incomeCents: numbers.income,
        expenseCents: numbers.expenses,
        netCents: numbers.income - numbers.expenses,
        cashCents: numbers.cash,
        unpaidIncomeCents: state.income.filter((record) => !record.isPaid).reduce((sum, record) => sum + record.totalCents, 0),
        unpaidExpenseCents: state.expenses.filter((record) => !record.isPaid).reduce((sum, record) => sum + record.totalCents, 0),
        invoiceOutstandingCents: state.invoices.filter((invoice) => invoice.status === "Sent").reduce((sum, invoice) => sum + invoice.totalCents, 0),
        salesTaxDueCents: numbers.taxCollected,
        inventoryValueCents: numbers.inventory,
        categories: groupByCategory(state.expenses.map((record) => ({ category: record.category, amountCents: record.totalCents }))),
        recent,
      };
      return summary as T;
    }

    case "profit_and_loss":
      requireOpen();
      return profitAndLoss() as T;

    case "balance_sheet":
      requireOpen();
      return balanceSheet() as T;

    case "tax_summary": {
      requireOpen();
      const taxable = state.income.filter((record) => record.taxBp > 0).reduce((sum, record) => sum + record.amountCents, 0);
      const untaxed = state.income.filter((record) => record.taxBp === 0).reduce((sum, record) => sum + record.amountCents, 0);
      const summary: TaxSummary = {
        from: (payload.from as string) ?? null,
        to: (payload.to as string) ?? null,
        taxableSalesCents: taxable,
        untaxedSalesCents: untaxed,
        salesTaxCollectedCents: state.income.reduce((sum, record) => sum + record.taxCents, 0)
          + state.invoices.reduce((sum, invoice) => sum + invoice.taxCents, 0),
        purchaseTaxCents: state.expenses.reduce((sum, record) => sum + record.taxCents, 0),
      };
      return summary as T;
    }

    case "list_settings":
      requireOpen();
      return Object.entries(state.settings)
        .map(([key, value]) => ({ key, value }))
        .sort((left, right) => left.key.localeCompare(right.key)) as T;

    case "save_setting": {
      requireOpen();
      state.settings[payload.key as string] = String(payload.value ?? "");
      return undefined as T;
    }

    case "list_accounts":
      requireOpen();
      return state.accounts.slice() as T;

    case "create_account": {
      requireOpen();
      const input = payload.input as { number: string; name: string; accountType: AccountType };
      const account: Account = {
        id: id("account"),
        number: input.number,
        name: input.name,
        accountType: input.accountType,
        subtype: null,
        parentId: null,
        currency: null,
        description: null,
        isActive: true,
        hasChildren: false,
        normalBalance: DEBIT_NORMAL.includes(input.accountType) ? "DEBIT" : "CREDIT",
      };
      state.accounts.push(account);
      return account as T;
    }

    case "set_account_active": {
      const account = state.accounts.find((candidate) => candidate.id === payload.accountId);
      if (account) account.isActive = Boolean(payload.active);
      return undefined as T;
    }

    case "list_journal_entries":
      return state.entries.slice(0, (payload.limit as number) ?? 100) as T;

    case "post_journal_entry": {
      requireOpen();
      const input = payload.input as JournalEntryInput;
      const entryId = id("entry");
      const summary: EntrySummary = {
        id: entryId,
        entryNo: state.entries.length + 1,
        entryDate: input.entryDate,
        memo: input.memo,
        reference: input.reference ?? null,
        source: input.source ?? "MANUAL",
        status: "POSTED",
        totalCents: input.lines.reduce((sum, line) => sum + line.debitCents, 0),
        lineCount: input.lines.length,
        createdAt: new Date().toISOString(),
      };
      state.entries.unshift(summary);
      state.linesByEntry.set(entryId, input.lines.map((line) => ({
        accountId: line.accountId,
        debitCents: line.debitCents,
        creditCents: line.creditCents,
        memo: line.memo ?? "",
      })));
      const detail: EntryDetail = {
        ...summary,
        lines: input.lines.map((line, index) => {
          const account = state.accounts.find((candidate) => candidate.id === line.accountId);
          return {
            id: index + 1,
            lineNo: index + 1,
            accountId: line.accountId,
            accountNumber: account?.number ?? "",
            accountName: account?.name ?? "",
            debitCents: line.debitCents,
            creditCents: line.creditCents,
            memo: line.memo ?? "",
          };
        }),
      };
      return detail as T;
    }

    case "void_journal_entry": {
      const entry = state.entries.find((candidate) => candidate.id === payload.entryId);
      if (entry) entry.status = "VOID";
      return undefined as T;
    }

    case "trial_balance":
      requireOpen();
      return trialBalance() as T;

    case "verify_audit_chain": {
      const report: ChainReport = {
        total: state.audit.length,
        sealed: state.audit.length,
        unsealed: 0,
        brokenAt: null,
        headHash: state.audit[0]?.hash ?? null,
        ok: true,
      };
      return report as T;
    }

    case "list_audit_log":
      return state.audit.slice(0, (payload.limit as number) ?? 200) as T;

    case "ledger_health": {
      const health: LedgerHealth = {
        schemaVersion: 2,
        integrity: "ok",
        balanced: true,
        accountCount: state.accounts.length,
        entryCount: state.entries.length,
      };
      return health as T;
    }

    default:
      throw new Error(`command '${command}' is not available in preview mode`);
  }
}
