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
  CreditMemo,
  CreditMemoInput,
  CreditMemoLine,
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
  InvoiceLine,
  JournalEntryInput,
  LedgerHealth,
  MileageDue,
  PartyInput,
  PayFrequency,
  PayrollInput,
  PayrollRun,
  PayType,
  ProfitAndLoss,
  Purchase,
  PurchaseInput,
  PurchaseLine,
  RecurringFrequency,
  RecurringInvoice,
  RecurringInvoiceInput,
  SalesOrder,
  SalesOrderInput,
  TaxSummary,
  TimeEntry,
  TimeEntryInput,
  TrialBalanceReport,
  User,
  UserInput,
  Vendor,
} from "./types";
import { PAY_PERIODS } from "./format";

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
  ["6310", "Employee Reimbursements", "EXPENSE", "Payroll"],
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
  estimates: Estimate[];
  salesOrders: SalesOrder[];
  creditMemos: CreditMemo[];
  users: User[];
  currentUserId: number | null;
  timeEntries: TimeEntry[];
  employees: Employee[];
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
    estimates: [],
    salesOrders: [],
    creditMemos: [],
    users: [],
    currentUserId: null,
    timeEntries: [],
    employees: [],
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

type MockMarital = "Single" | "Married";

function settingNumber(key: string, fallback: number): number {
  const value = Number(state.settings[key]);
  return state.settings[key] !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The preview stand-in for the engine's withholding estimate. Every rate comes
 *  from settings, exactly like the engine, so the demo never shows a different
 *  net pay than the desktop app. */
function withholding(gross: number, marital: MockMarital, allowances: number, extra = 0) {
  const apply = (amount: number, bp: number) => Math.round((amount * bp) / 10_000);
  const allowanceValue = settingNumber("payroll_allowance_cents", 19_400);
  const federalBp = marital === "Married"
    ? settingNumber("payroll_federal_married_bp", 800)
    : settingNumber("payroll_federal_single_bp", 1_200);
  const base = Math.max(0, gross - allowanceValue * allowances);
  return {
    federal: Math.min(gross, apply(base, federalBp) + extra),
    state: apply(gross, settingNumber("payroll_state_bp", 400)),
    social: apply(gross, settingNumber("payroll_social_security_bp", 620)),
    medicare: apply(gross, settingNumber("payroll_medicare_bp", 145)),
  };
}

/** Miles belong to the employee who logged them: by user link when there is
 *  one, otherwise by the name on the sheet. */
function mileageBelongsTo(entry: TimeEntry, employee: Employee): boolean {
  if (entry.kind !== "Mileage") return false;
  if (employee.userId !== null) return entry.userId === employee.userId;
  return entry.enteredBy.toLowerCase() === employee.name.toLowerCase();
}

function mileageFor(employee: Employee | null, includingRun: number | null = null): MileageDue {
  const rateCents = settingNumber("payroll_mileage_rate_cents", 67);
  if (!employee) return { milesHundredths: 0, rateCents, amountCents: 0, linked: false };
  const milesHundredths = state.timeEntries
    .filter(
      (entry) =>
        mileageBelongsTo(entry, employee) &&
        (entry.reimbursedRunId === null || entry.reimbursedRunId === includingRun),
    )
    .reduce((sum, entry) => sum + entry.quantityHundredths, 0);
  return {
    milesHundredths,
    rateCents,
    amountCents: Math.round((milesHundredths * rateCents) / 100),
    linked: employee.userId !== null || milesHundredths > 0,
  };
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
    schemaVersion: 7,
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
  state.settings.business_address = "1420 Harbor Way\nAlameda, CA 94501";
  state.settings.business_phone = "(510) 555-0142";
  state.settings.business_email = "books@riverbend.example";
  state.settings.business_website = "riverbendcontracting.example";

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
      creditedCents: 0,
      stockDeducted: status !== "Draft",
      lines,
    };
    state.invoices.push(record);
    return record;
  };

  const phase2 = invoice("INV-1005", alameda, "2026-07-15", "2026-08-14", "Sent", [
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

  state.settings.company_name = "Riverbend Contracting LLC";
  state.settings.business_address = "1420 Harbor Way\nAlameda, CA 94501";
  state.settings.business_phone = "(510) 555-0142";
  state.settings.business_email = "books@riverbend.example";
  state.settings.business_website = "riverbendcontracting.example";
  state.settings.cash_account = String(state.accounts.find((account) => account.number === "1000")?.id ?? 1);
  state.settings.receivable_account = String(state.accounts.find((account) => account.number === "1100")?.id ?? 2);
  state.settings.payable_account = String(state.accounts.find((account) => account.number === "2000")?.id ?? 3);
  state.settings.sales_tax_account = String(state.accounts.find((account) => account.number === "2200")?.id ?? 4);

  // People, with one of each access level so the preview shows the differences.
  const person = (name: string, email: string, access: User["access"]): User => {
    const record: User = {
      id: id("user"),
      name,
      email,
      access,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    state.users.push(record);
    return record;
  };
  const owner = person("Owner", "", "Admin");
  const sam = person("Sam Okafor", "sam@riverbend.example", "Standard");
  person("Priya Raman", "priya@riverbend.example", "Payroll");
  const rae = person("Rae Lin", "rae@riverbend.example", "TimeEntry");
  person("Dana Whitfield", "dana@bookkeeping.example", "ReadOnly");
  state.currentUserId = owner.id;

  const timeEntry = (
    who: User,
    date: string,
    kind: TimeEntry["kind"],
    description: string,
    customer: string,
    quantity: number,
    rate: number,
    billable = true,
  ): TimeEntry => {
    const quantityHundredths = Math.round(quantity * 100);
    const record: TimeEntry = {
      id: id("time"),
      userId: who.id,
      enteredBy: who.name,
      entryDate: date,
      kind,
      description,
      customer,
      quantityHundredths,
      rateCents: rate,
      amountCents: Math.round((quantityHundredths * rate) / 100),
      isBillable: billable,
      reimbursedRunId: null,
      createdAt: new Date().toISOString(),
    };
    state.timeEntries.push(record);
    return record;
  };
  timeEntry(rae, "2026-08-04", "Time", "Fence install — Castellano", "Castellano Residence", 6.5, 8_500);
  timeEntry(rae, "2026-08-05", "Mileage", "Site visit round trip", "Alameda Property Group", 42, 67);
  timeEntry(sam, "2026-08-06", "Time", "Books cleanup", "", 3, 6_500, false);

  // The payroll roster. None of these people needs an account: only Rae Lin
  // also logs time, so she is the one linked to a user.
  const hire = (
    name: string,
    rate: number,
    marital: MockMarital,
    allowances: number,
    extra: {
      userId?: number;
      allowanceCents?: number;
      mileageReimbursement?: boolean;
      ssn?: string;
      payType?: PayType;
      payFrequency?: PayFrequency;
      salaryCents?: number;
    } = {},
  ): Employee => {
    const ssn = extra.ssn ?? "";
    const record: Employee = {
      id: id("employee"),
      name,
      employeeNo: `E-00${state.employees.length + 1}`,
      email: "",
      phone: "",
      address: "",
      ssn,
      ssnLast4: ssn.slice(-4),
      hireDate: "2025-04-01",
      jobTitle: "",
      userId: extra.userId ?? null,
      filingStatus: marital,
      allowances,
      extraWithholdingCents: 0,
      payType: extra.payType ?? "Hourly",
      payFrequency: extra.payFrequency ?? "BiWeekly",
      payRateCents: rate,
      salaryCents: extra.salaryCents ?? 0,
      allowanceCents: extra.allowanceCents ?? 0,
      mileageReimbursement: extra.mileageReimbursement ?? false,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    state.employees.push(record);
    return record;
  };
  const alvarez = hire("J. Alvarez", 4_000, "Married", 2, {
    ssn: "412884821",
  });
  // Okafor is salaried: $91,000 a year every two weeks is the same $3,500 a
  // period the hourly rate used to pay, so the history reads the same.
  const okafor = hire("T. Okafor", 0, "Single", 0, {
    ssn: "556901334",
    payType: "Salary",
    payFrequency: "BiWeekly",
    salaryCents: 9_100_000,
  });
  const lin = hire("Rae Lin", 4_200, "Single", 0, {
    userId: rae.id,
    allowanceCents: 5_000,
    mileageReimbursement: true,
    ssn: "601445482",
  });

  const payRun = (
    person: Employee,
    date: string,
    rate: number,
    regular: number,
    overtime: number,
    marital: MockMarital,
    allowances: number,
    check: string,
    additions: { mileageHundredths?: number; mileageCents?: number; allowanceCents?: number } = {},
    basis: { payType?: PayType; payFrequency?: PayFrequency; salaryCents?: number } = {},
  ) => {
    const payType = basis.payType ?? "Hourly";
    const payFrequency = basis.payFrequency ?? person.payFrequency;
    const salaryCents = payType === "Salary" ? basis.salaryCents ?? person.salaryCents : 0;
    const gross = payType === "Salary"
      ? Math.round(salaryCents / PAY_PERIODS[payFrequency])
      : Math.round(rate * regular + rate * 1.5 * overtime);
    const tax = withholding(gross, marital, allowances);
    const totalDeductions = tax.federal + tax.state + tax.social + tax.medicare;
    const mileageCents = additions.mileageCents ?? 0;
    const allowanceCents = additions.allowanceCents ?? 0;
    const net = gross - totalDeductions;
    const record: PayrollRun = {
      id: id("payroll"),
      employee: person.name,
      employeeId: person.id,
      payDate: date,
      checkNumber: check,
      payType,
      payFrequency,
      periodsPerYear: payType === "Salary" ? PAY_PERIODS[payFrequency] : 0,
      payRateCents: payType === "Salary" ? 0 : rate,
      salaryCents,
      regularHoursHundredths: payType === "Salary" ? 0 : regular * 100,
      overtimeHoursHundredths: payType === "Salary" ? 0 : overtime * 100,
      grossCents: gross,
      maritalStatus: marital,
      allowances,
      extraWithholdingCents: 0,
      federalCents: tax.federal,
      stateCents: tax.state,
      socialSecurityCents: tax.social,
      medicareCents: tax.medicare,
      otherDeductionsCents: 0,
      totalDeductionsCents: totalDeductions,
      mileageHundredths: additions.mileageHundredths ?? 0,
      mileageCents,
      allowanceCents,
      additionsCents: mileageCents + allowanceCents,
      netCents: net,
      paidCents: net + mileageCents + allowanceCents,
      journalEntryId: id("entry"),
    };
    state.payroll.push(record);
    return record;
  };

  payRun(alvarez, "2026-07-31", 4_000, 80, 5, "Married", 2, "1058");
  payRun(okafor, "2026-07-31", 0, 0, 0, "Single", 0, "1059", {}, {
    payType: "Salary",
    payFrequency: "BiWeekly",
    salaryCents: 9_100_000,
  });

  // One run that paid mileage and an allowance, so the preview shows additions.
  const mileageCents = Math.round(
    (state.timeEntries
      .filter((entry) => mileageBelongsTo(entry, lin))
      .reduce((sum, entry) => sum + entry.quantityHundredths, 0) * 67) / 100,
  );
  const paidLin = payRun(lin, "2026-08-07", 4_200, 80, 0, "Single", 0, "1060", {
    mileageHundredths: state.timeEntries
      .filter((entry) => mileageBelongsTo(entry, lin))
      .reduce((sum, entry) => sum + entry.quantityHundredths, 0),
    mileageCents,
    allowanceCents: 5_000,
  });
  for (const entry of state.timeEntries) {
    if (mileageBelongsTo(entry, lin)) entry.reimbursedRunId = paidLin.id;
  }

  // Miles logged after that run are still waiting for the next one.
  timeEntry(rae, "2026-08-12", "Mileage", "Material pickup", "Castellano Residence", 18, 67);

  // The paperwork before the invoice: one quote still out with the customer and
  // one quote that has already become a confirmed order.
  const quoteLines = (rows: Array<[string, number, number]>): Estimate["lines"] =>
    rows.map(([description, qty, price], index) => ({
      id: id("estimate_line"),
      position: index + 1,
      description,
      qtyHundredths: Math.round(qty * 100),
      unitPriceCents: price,
      amountCents: Math.round(qty * price),
      inventoryItemId: null,
    }));

  const acceptedQuote = quoteLines([
    ["Gate install — hardware", 2, 8_500],
    ["Gate install — labour", 1, 52_000],
  ]);
  const acceptedTotals = pipelineTotals(acceptedQuote, 0);
  const quoteId = id("estimate");
  const orderLines: SalesOrder["lines"] = acceptedQuote.map((line, index) => ({
    ...line,
    id: id("order_line"),
    position: index + 1,
  }));
  const order: SalesOrder = {
    id: id("order"),
    orderNo: "SO-1001",
    customerId: state.customers[3].id,
    customerName: state.customers[3].name,
    orderDate: "2026-08-02",
    requestedDate: "2026-08-20",
    status: "Confirmed",
    taxBp: 0,
    notes: "Customer confirmed the gate quote",
    subtotalCents: acceptedTotals.subtotal,
    taxCents: acceptedTotals.tax,
    totalCents: acceptedTotals.total,
    invoiceId: null,
    invoiceNo: null,
    estimateId: null,
    estimateNo: null,
    convertedAt: null,
    lines: orderLines,
  };
  state.salesOrders.push(order);

  const accepted: Estimate = {
    id: quoteId,
    estimateNo: "EST-0999",
    customerId: order.customerId,
    customerName: order.customerName,
    estimateDate: "2026-07-28",
    expiryDate: "2026-08-28",
    status: "Accepted",
    taxBp: 0,
    notes: String(state.customers[3].notes ?? ""),
    subtotalCents: acceptedTotals.subtotal,
    taxCents: acceptedTotals.tax,
    totalCents: acceptedTotals.total,
    convertedOrderId: order.id,
    convertedInvoiceId: null,
    convertedAt: new Date().toISOString(),
    orderNo: order.orderNo,
    invoiceNo: null,
    lines: acceptedQuote,
  };
  state.estimates.push(accepted);
  order.estimateId = accepted.id;
  order.estimateNo = accepted.estimateNo;

  const openLines = quoteLines([
    ["Deck rebuild — phase 3 labour", 1, 320_000],
    ["Composite decking & fixings", 1, 64_000],
  ]);
  const openTotals = pipelineTotals(openLines, 0);
  state.estimates.push({
    id: id("estimate"),
    estimateNo: "EST-1000",
    customerId: state.customers[0].id,
    customerName: state.customers[0].name,
    estimateDate: "2026-08-06",
    expiryDate: "2026-09-05",
    status: "Sent",
    taxBp: 0,
    notes: "Sent by email — waiting to hear back",
    subtotalCents: openTotals.subtotal,
    taxCents: openTotals.tax,
    totalCents: openTotals.total,
    convertedOrderId: null,
    convertedInvoiceId: null,
    convertedAt: null,
    orderNo: null,
    invoiceNo: null,
    lines: openLines,
  });

  // One credit memo already posted against INV-1005, and one still a draft.
  const creditLine = (invoiceLine: InvoiceLine, qty: number): CreditMemoLine => ({
    id: id("credit_line"),
    position: 1,
    invoiceLineId: invoiceLine.id,
    description: invoiceLine.description,
    qtyHundredths: Math.round(qty * 100),
    unitPriceCents: invoiceLine.unitPriceCents,
    amountCents: Math.round((qty * invoiceLine.unitPriceCents)),
    inventoryItemId: invoiceLine.inventoryItemId,
  });
  const finish = creditLine(phase2.lines[1], 1);
  finish.position = 1;
  state.creditMemos.push({
    id: id("credit"),
    memoNo: "CM-1001",
    invoiceId: phase2.id,
    invoiceNo: phase2.invoiceNo,
    customerId: phase2.customerId,
    customerName: phase2.customerName,
    memoDate: "2026-07-28",
    reason: "Service not delivered",
    status: "Posted",
    outcome: "Apply",
    taxBp: 0,
    subtotalCents: finish.amountCents,
    taxCents: 0,
    totalCents: finish.amountCents,
    stockReturned: false,
    createdAt: new Date().toISOString(),
    postedAt: new Date().toISOString(),
    voidedAt: null,
    lines: [finish],
  });
  phase2.creditedCents = finish.amountCents;
}

/** Preview stand-in for the engine's "already credited" figure. */
function creditedOn(invoiceId: number, excluding?: number | null): number {
  return state.creditMemos
    .filter((memo) => memo.invoiceId === invoiceId && memo.status === "Posted" && memo.id !== excluding)
    .reduce((sum, memo) => sum + memo.totalCents, 0);
}

function actingUser(): User {
  const user = state.users.find((candidate) => candidate.id === state.currentUserId)
    ?? state.users.find((candidate) => candidate.isActive);
  if (!user) throw new Error("this company file has no active user");
  return user;
}

function restock(memo: CreditMemo, direction: 1 | -1) {
  for (const line of memo.lines) {
    if (!line.inventoryItemId) continue;
    const item = state.items.find((candidate) => candidate.id === line.inventoryItemId);
    if (!item) continue;
    item.qtyHundredths = Math.max(0, item.qtyHundredths + direction * line.qtyHundredths);
    item.stockValueCents = Math.round((item.qtyHundredths * item.unitCostCents) / 100);
  }
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
    + state.payroll.reduce((sum, record) => sum + record.grossCents + record.additionsCents, 0);
  const cash = state.income.filter((record) => record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    + state.invoices.filter((invoice) => invoice.status === "Paid").reduce((sum, invoice) => sum + invoice.totalCents, 0)
    - state.expenses.filter((record) => record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    - state.purchases.filter((record) => record.isPaid).reduce((sum, record) => sum + record.totalCents, 0)
    - state.payroll.reduce((sum, record) => sum + record.paidCents, 0);
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
    ...state.payroll
      .filter((record) => record.additionsCents > 0)
      .map((record) => ({ category: "Employee Reimbursements", amountCents: record.additionsCents })),
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One place that writes an invoice, so a conversion from a quote or an order
 *  produces exactly the same record as the invoice screen does. */
function writeInvoice(input: InvoiceInput): Invoice {
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
    creditedCents: existing?.creditedCents ?? 0,
    stockDeducted: input.status !== "Draft",
    lines,
  };
  record.creditedCents = creditedOn(record.id);
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
  return record;
}

/** Ditto for the two documents that lead to an invoice. */
function writePipelineLines(input: { description: string; qtyHundredths: number; unitPriceCents: number; inventoryItemId?: number | null }[]) {
  return input.map((line, index) => ({
    id: id("pipeline_line"),
    position: index + 1,
    description: line.description,
    qtyHundredths: line.qtyHundredths,
    unitPriceCents: line.unitPriceCents,
    amountCents: Math.round((line.qtyHundredths * line.unitPriceCents) / 100),
    inventoryItemId: line.inventoryItemId ?? null,
  }));
}

function nextSeries(prefix: string, numbers: string[]): string {
  let highest = 1000;
  for (const number of numbers) {
    const value = Number((number.split("-").pop() ?? "").trim());
    if (Number.isFinite(value)) highest = Math.max(highest, value);
  }
  return `${prefix}-${highest + 1}`;
}

function pipelineTotals(lines: { amountCents: number }[], taxBp: number) {
  const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const tax = Math.round((subtotal * taxBp) / 10_000);
  return { subtotal, tax, total: subtotal + tax };
}

function invoiceInputFrom(
  customerId: number | null,
  date: string,
  taxBp: number,
  lines: { description: string; qtyHundredths: number; unitPriceCents: number; inventoryItemId: number | null }[],
): InvoiceInput {
  return {
    id: null,
    invoiceNo: null,
    customerId,
    invoiceDate: date,
    dueDate: null,
    status: "Draft",
    taxBp,
    lines: lines.map((line) => ({
      description: line.description,
      qtyHundredths: line.qtyHundredths,
      unitPriceCents: line.unitPriceCents,
      inventoryItemId: line.inventoryItemId,
    })),
  };
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
            creditedCents: 0,
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
        if (invoice) invoiceId = invoice.id;
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
      return writeInvoice(payload.input as InvoiceInput) as T;
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
      // The quote or order that pointed here is open again.
      for (const estimate of state.estimates) {
        if (estimate.convertedInvoiceId === payload.id) {
          estimate.convertedInvoiceId = null;
          estimate.invoiceNo = null;
          if (!estimate.convertedOrderId) estimate.convertedAt = null;
        }
      }
      for (const order of state.salesOrders) {
        if (order.invoiceId === payload.id) {
          order.invoiceId = null;
          order.invoiceNo = null;
          order.convertedAt = null;
          if (order.status === "Fulfilled") order.status = "Confirmed";
        }
      }
      return undefined as T;
    }

    case "list_credit_memos": {
      requireOpen();
      return state.creditMemos
        .slice()
        .sort((left, right) => right.memoDate.localeCompare(left.memoDate) || right.id - left.id) as T;
    }

    case "get_credit_memo": {
      requireOpen();
      const memo = state.creditMemos.find((candidate) => candidate.id === payload.id);
      if (!memo) throw new Error("credit memo does not exist");
      return memo as T;
    }

    case "save_credit_memo": {
      requireOpen();
      const input = payload.input as CreditMemoInput;
      const bill = state.invoices.find((candidate) => candidate.id === input.invoiceId);
      if (!bill) throw new Error("a credit memo must be based on an invoice; that invoice does not exist");
      if (bill.status === "Draft") {
        throw new Error(`invoice ${bill.invoiceNo} is still a draft — send it before crediting it, because a draft has not touched the books yet`);
      }
      const reason = (input.reason ?? "").trim();
      if (!reason) throw new Error("choose a reason for the credit");
      const existing = state.creditMemos.find((candidate) => candidate.id === input.id);
      if (existing && existing.status !== "Draft") {
        throw new Error("this credit memo is already posted; void it and issue a new one instead of editing it");
      }

      const lines: CreditMemoLine[] = [];
      input.lines.forEach((line, index) => {
        if (line.qtyHundredths <= 0) return;
        const original = line.invoiceLineId
          ? bill.lines.find((candidate) => candidate.id === line.invoiceLineId)
          : undefined;
        if (!original && !line.description.trim()) throw new Error("a credit line needs a description");
        if (original) {
          const already = state.creditMemos
            .filter((memo) => memo.status !== "Void" && memo.id !== input.id)
            .flatMap((memo) => memo.lines)
            .filter((memoLine) => memoLine.invoiceLineId === original.id)
            .reduce((sum, memoLine) => sum + memoLine.qtyHundredths, 0);
          if (line.qtyHundredths + already > original.qtyHundredths) {
            throw new Error(
              `invoice ${bill.invoiceNo} only has ${((original.qtyHundredths - already) / 100).toFixed(2)} of "${original.description}" left to credit`,
            );
          }
        }
        const price = original?.unitPriceCents ?? line.unitPriceCents;
        lines.push({
          id: id("credit_line"),
          position: index + 1,
          invoiceLineId: original?.id ?? null,
          description: original?.description ?? line.description,
          qtyHundredths: line.qtyHundredths,
          unitPriceCents: price,
          amountCents: Math.round((line.qtyHundredths * price) / 100),
          inventoryItemId: original?.inventoryItemId ?? line.inventoryItemId ?? null,
        });
      });
      if (lines.length === 0) throw new Error("choose at least one thing to credit");

      const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
      const tax = Math.round((subtotal * input.taxBp) / 10_000);
      const total = subtotal + tax;
      if (total <= 0) throw new Error("a credit memo must be worth more than zero");
      const already = creditedOn(bill.id, input.id);
      if (already + total > bill.totalCents) {
        throw new Error(
          `that would credit ${((already + total) / 100).toFixed(2)} against an invoice worth ${(bill.totalCents / 100).toFixed(2)}`,
        );
      }

      const status = input.status === "Posted" ? "Posted" : "Draft";
      const highest = state.creditMemos.reduce((best, memo) => {
        const digits = Number(memo.memoNo.split("-").pop());
        return Number.isFinite(digits) ? Math.max(best, digits) : best;
      }, 1000);
      const record: CreditMemo = {
        id: existing?.id ?? id("credit"),
        memoNo: input.memoNo?.trim() || existing?.memoNo || `CM-${highest + 1}`,
        invoiceId: bill.id,
        invoiceNo: bill.invoiceNo,
        customerId: bill.customerId,
        customerName: bill.customerName,
        memoDate: input.memoDate,
        reason,
        status,
        outcome: input.outcome,
        taxBp: input.taxBp,
        subtotalCents: subtotal,
        taxCents: tax,
        totalCents: total,
        stockReturned: false,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        postedAt: status === "Posted" ? new Date().toISOString() : null,
        voidedAt: null,
        lines,
      };
      if (existing) Object.assign(existing, record);
      else state.creditMemos.push(record);
      const saved = existing ?? record;

      if (saved.status === "Posted") {
        restock(saved, 1);
        saved.stockReturned = saved.lines.some((line) => line.inventoryItemId !== null);
      }
      bill.creditedCents = creditedOn(bill.id);
      auditRow(existing ? "UPDATE" : "INSERT", "credit_memos", saved.id, saved);
      return saved as T;
    }

    case "delete_credit_memo": {
      requireOpen();
      const memo = state.creditMemos.find((candidate) => candidate.id === payload.id);
      if (!memo) throw new Error("credit memo does not exist");
      if (memo.status !== "Draft") {
        throw new Error("a posted or voided credit memo stays on the books; void it instead of deleting it");
      }
      state.creditMemos = state.creditMemos.filter((candidate) => candidate.id !== memo.id);
      auditRow("DELETE", "credit_memos", memo.id, memo);
      return undefined as T;
    }

    case "void_credit_memo": {
      requireOpen();
      const memo = state.creditMemos.find((candidate) => candidate.id === payload.id);
      if (!memo) throw new Error("credit memo does not exist");
      if (memo.status !== "Posted") {
        throw new Error("only a posted credit memo can be voided; a draft can simply be deleted");
      }
      if (memo.stockReturned) restock(memo, -1);
      memo.status = "Void";
      memo.voidedAt = new Date().toISOString();
      memo.stockReturned = false;
      const bill = state.invoices.find((candidate) => candidate.id === memo.invoiceId);
      if (bill) bill.creditedCents = creditedOn(bill.id);
      auditRow("UPDATE", "credit_memos", memo.id, memo);
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
            creditedCents: 0,
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

    case "preview_payroll":
    case "save_payroll": {
      requireOpen();
      const input = payload.input as PayrollInput;
      const person = state.employees.find((candidate) => candidate.id === input.employeeId) ?? null;
      const employee = (input.employee ?? "").trim() || person?.name || "";
      if (!employee) throw new Error("choose an employee for this pay run");
      if (input.payMileage && !person) {
        throw new Error("mileage is reimbursed to an employee record; add this person under Employees first");
      }
      const payType: PayType = input.payType === "Salary" ? "Salary" : "Hourly";
      const payFrequency: PayFrequency = input.payFrequency ?? "BiWeekly";
      const salaryCents = payType === "Salary" ? Math.max(0, Math.round(input.salaryCents ?? 0)) : 0;
      let gross: number;
      if (payType === "Salary") {
        if (salaryCents <= 0) throw new Error("enter an annual salary for this salaried pay run");
        if (input.regularHoursHundredths > 0 || input.overtimeHoursHundredths > 0) {
          throw new Error(
            "a salary is a fixed amount each period; clear the hours, or record extra pay as an addition",
          );
        }
        gross = Math.round(salaryCents / PAY_PERIODS[payFrequency]);
      } else {
        const overtimeRate = Math.round((input.payRateCents * 3) / 2);
        gross = Math.round((input.regularHoursHundredths * input.payRateCents) / 100)
          + Math.round((input.overtimeHoursHundredths * overtimeRate) / 100);
      }
      if (gross <= 0) throw new Error("enter hours and a pay rate so the pay run is worth something");
      const marital: MockMarital = input.maritalStatus === "Married" ? "Married" : "Single";
      const allowances = Math.max(0, Math.round(input.allowances ?? 0));
      const extra = Math.max(0, Math.round(input.extraWithholdingCents ?? 0));
      const tax = withholding(gross, marital, allowances, extra);
      const other = Math.max(0, input.otherDeductionsCents ?? 0);
      const deductions = tax.federal + tax.state + tax.social + tax.medicare + other;
      if (deductions > gross) throw new Error("deductions cannot exceed gross pay");

      // Additions. Miles are only on the check when the toggle says yes, and a
      // mile this run already paid still counts while it is being edited.
      const runId = input.id ?? null;
      const due = mileageFor(person, runId);
      const mileageHundredths = input.payMileage ? due.milesHundredths : 0;
      const mileageCents = input.payMileage ? due.amountCents : 0;
      const allowanceCents = input.payAllowance ? Math.max(0, Math.round(input.allowanceCents ?? 0)) : 0;
      const additionsCents = mileageCents + allowanceCents;
      const net = gross - deductions;

      const record: PayrollRun = {
        id: runId ?? id("payroll"),
        employee,
        employeeId: input.employeeId ?? null,
        payDate: input.payDate,
        checkNumber: input.checkNumber ?? "",
        payType,
        payFrequency,
        periodsPerYear: payType === "Salary" ? PAY_PERIODS[payFrequency] : 0,
        payRateCents: payType === "Salary" ? 0 : input.payRateCents,
        salaryCents,
        regularHoursHundredths: payType === "Salary" ? 0 : input.regularHoursHundredths,
        overtimeHoursHundredths: payType === "Salary" ? 0 : input.overtimeHoursHundredths,
        grossCents: gross,
        maritalStatus: marital,
        allowances,
        extraWithholdingCents: extra,
        federalCents: tax.federal,
        stateCents: tax.state,
        socialSecurityCents: tax.social,
        medicareCents: tax.medicare,
        otherDeductionsCents: other,
        totalDeductionsCents: deductions,
        mileageHundredths,
        mileageCents,
        allowanceCents,
        additionsCents,
        netCents: net,
        paidCents: net + additionsCents,
        journalEntryId: command === "preview_payroll" ? null : id("entry"),
      };
      if (command === "preview_payroll") return record as T;

      // Release anything this run claimed before, then claim the miles it pays.
      for (const entry of state.timeEntries) {
        if (entry.reimbursedRunId === record.id) entry.reimbursedRunId = null;
      }
      if (input.payMileage && person) {
        for (const entry of state.timeEntries) {
          if (mileageBelongsTo(entry, person) && entry.reimbursedRunId === null) {
            entry.reimbursedRunId = record.id;
          }
        }
      }
      const index = state.payroll.findIndex((candidate) => candidate.id === record.id);
      if (index >= 0) state.payroll[index] = record;
      else state.payroll.push(record);
      return record as T;
    }

    case "delete_payroll":
      requireOpen();
      state.payroll = state.payroll.filter((record) => record.id !== payload.id);
      for (const entry of state.timeEntries) {
        if (entry.reimbursedRunId === payload.id) entry.reimbursedRunId = null;
      }
      return undefined as T;

    case "list_employees":
      requireOpen();
      return state.employees
        .slice()
        .sort((left, right) => Number(right.isActive) - Number(left.isActive) || left.name.localeCompare(right.name)) as T;

    case "save_employee": {
      requireOpen();
      const input = payload.input as EmployeeInput;
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("an employee name is required");
      const digits = (input.ssn ?? "").replace(/\D/g, "");
      if (digits.length !== 0 && digits.length !== 4 && digits.length !== 9) {
        throw new Error("enter the Social Security number as nine digits, or just the last four");
      }
      const ssn = digits.length === 9 ? digits : "";
      const ssnLast4 = digits.slice(-4);
      const payType: PayType = input.payType === "Salary" ? "Salary" : "Hourly";
      const payFrequency: PayFrequency = input.payFrequency ?? "BiWeekly";
      const salaryCents = Math.max(0, Math.round(input.salaryCents ?? 0));
      if (payType === "Salary" && salaryCents <= 0) {
        throw new Error("a salaried employee needs an annual salary");
      }
      const clash = state.employees.find(
        (candidate) => candidate.name.toLowerCase() === name.toLowerCase() && candidate.id !== input.id,
      );
      if (clash) throw new Error(`there is already an employee called ${name}`);
      const existing = state.employees.find((candidate) => candidate.id === input.id);
      const record: Employee = {
        id: existing?.id ?? id("employee"),
        name,
        employeeNo: (input.employeeNo ?? existing?.employeeNo ?? "").trim(),
        email: (input.email ?? existing?.email ?? "").trim(),
        phone: (input.phone ?? existing?.phone ?? "").trim(),
        address: (input.address ?? existing?.address ?? "").trim(),
        ssn,
        ssnLast4,
        hireDate: input.hireDate ?? existing?.hireDate ?? null,
        jobTitle: (input.jobTitle ?? existing?.jobTitle ?? "").trim(),
        userId: input.userId === undefined ? existing?.userId ?? null : input.userId,
        filingStatus: input.filingStatus === "Married" ? "Married" : "Single",
        allowances: Math.max(0, Math.round(input.allowances ?? 0)),
        extraWithholdingCents: Math.max(0, Math.round(input.extraWithholdingCents ?? 0)),
        payType,
        payFrequency,
        payRateCents: Math.max(0, Math.round(input.payRateCents ?? 0)),
        salaryCents,
        allowanceCents: Math.max(0, Math.round(input.allowanceCents ?? 0)),
        mileageReimbursement: input.mileageReimbursement ?? false,
        isActive: input.isActive ?? existing?.isActive ?? true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      if (existing) Object.assign(existing, record);
      else state.employees.push(record);
      auditRow(existing ? "UPDATE" : "INSERT", "employees", record.id, record);
      return record as T;
    }

    case "delete_employee": {
      requireOpen();
      if (state.payroll.some((run) => run.employeeId === payload.id)) {
        throw new Error("this employee has pay runs on file, so keep them and mark them inactive instead");
      }
      const existing = state.employees.find((candidate) => candidate.id === payload.id);
      if (!existing) throw new Error("that employee does not exist");
      state.employees = state.employees.filter((candidate) => candidate.id !== existing.id);
      auditRow("DELETE", "employees", existing.id, existing);
      return undefined as T;
    }

    case "mileage_due": {
      requireOpen();
      const person = state.employees.find((candidate) => candidate.id === payload.employeeId) ?? null;
      return mileageFor(person) as T;
    }

    case "list_estimates":
      requireOpen();
      return state.estimates
        .slice()
        .sort((left, right) => right.estimateDate.localeCompare(left.estimateDate) || right.id - left.id) as T;

    case "get_estimate": {
      requireOpen();
      const estimate = state.estimates.find((candidate) => candidate.id === payload.id);
      if (!estimate) throw new Error("estimate does not exist");
      return estimate as T;
    }

    case "save_estimate": {
      requireOpen();
      const input = payload.input as EstimateInput;
      const existing = state.estimates.find((candidate) => candidate.id === input.id);
      if (existing?.convertedAt) {
        throw new Error(
          "this estimate has already become an order or an invoice, so its contents are fixed; start a new estimate if the quote changed",
        );
      }
      const lines = writePipelineLines(input.lines.filter((line) => line.description.trim() || line.unitPriceCents > 0));
      if (lines.length === 0) throw new Error("add at least one line to the document");
      const totals = pipelineTotals(lines, input.taxBp);
      if (totals.total <= 0) throw new Error("an estimate must be worth more than zero");
      const customer = state.customers.find((candidate) => candidate.id === input.customerId);
      const record: Estimate = {
        id: input.id ?? id("estimate"),
        estimateNo:
          input.estimateNo?.trim() ||
          nextSeries("EST", state.estimates.map((candidate) => candidate.estimateNo)),
        customerId: input.customerId ?? null,
        customerName: customer?.name ?? "",
        estimateDate: input.estimateDate,
        expiryDate: input.expiryDate ?? null,
        status: input.status,
        taxBp: input.taxBp,
        notes: input.notes ?? "",
        subtotalCents: totals.subtotal,
        taxCents: totals.tax,
        totalCents: totals.total,
        convertedOrderId: existing?.convertedOrderId ?? null,
        convertedInvoiceId: existing?.convertedInvoiceId ?? null,
        convertedAt: existing?.convertedAt ?? null,
        orderNo: existing?.orderNo ?? null,
        invoiceNo: existing?.invoiceNo ?? null,
        lines,
      };
      if (existing) Object.assign(existing, record);
      else state.estimates.push(record);
      auditRow(existing ? "UPDATE" : "INSERT", "estimates", record.id, record);
      return record as T;
    }

    case "delete_estimate": {
      requireOpen();
      const estimate = state.estimates.find((candidate) => candidate.id === payload.id);
      if (!estimate) throw new Error("estimate does not exist");
      if (estimate.convertedAt) {
        throw new Error("this estimate already became an order or an invoice, so it stays on file");
      }
      state.estimates = state.estimates.filter((candidate) => candidate.id !== estimate.id);
      auditRow("DELETE", "estimates", estimate.id, estimate);
      return undefined as T;
    }

    case "convert_estimate_to_order": {
      requireOpen();
      const estimate = state.estimates.find((candidate) => candidate.id === payload.id);
      if (!estimate) throw new Error("estimate does not exist");
      if (estimate.convertedAt) {
        throw new Error(`${estimate.estimateNo} has already become ${estimate.invoiceNo ?? estimate.orderNo ?? "another document"}`);
      }
      if (estimate.status === "Declined" || estimate.status === "Expired") {
        throw new Error(`${estimate.estimateNo} is ${estimate.status}, so it cannot become an order`);
      }
      const date = (payload.orderDate as string) || today();
      const totals = pipelineTotals(estimate.lines, estimate.taxBp);
      const order: SalesOrder = {
        id: id("order"),
        orderNo: nextSeries("SO", state.salesOrders.map((candidate) => candidate.orderNo)),
        customerId: estimate.customerId,
        customerName: estimate.customerName,
        orderDate: date,
        requestedDate: estimate.expiryDate,
        status: "Confirmed",
        taxBp: estimate.taxBp,
        notes: estimate.notes,
        subtotalCents: totals.subtotal,
        taxCents: totals.tax,
        totalCents: totals.total,
        invoiceId: null,
        invoiceNo: null,
        estimateId: estimate.id,
        estimateNo: estimate.estimateNo,
        convertedAt: null,
        lines: estimate.lines.map((line, index) => ({ ...line, id: id("order_line"), position: index + 1 })),
      };
      state.salesOrders.push(order);
      estimate.convertedOrderId = order.id;
      estimate.convertedAt = new Date().toISOString();
      estimate.status = "Accepted";
      estimate.orderNo = order.orderNo;
      auditRow("UPDATE", "estimates", estimate.id, estimate);
      return order as T;
    }

    case "convert_estimate_to_invoice": {
      requireOpen();
      const estimate = state.estimates.find((candidate) => candidate.id === payload.id);
      if (!estimate) throw new Error("estimate does not exist");
      if (estimate.convertedInvoiceId) throw new Error(`${estimate.estimateNo} has already been invoiced`);
      if (estimate.status === "Declined" || estimate.status === "Expired") {
        throw new Error(`${estimate.estimateNo} is ${estimate.status}, so it cannot be invoiced`);
      }
      const date = (payload.invoiceDate as string) || today();
      const invoice = writeInvoice(
        invoiceInputFrom(estimate.customerId, date, estimate.taxBp, estimate.lines),
      );
      estimate.convertedInvoiceId = invoice.id;
      estimate.convertedAt = new Date().toISOString();
      estimate.status = "Accepted";
      estimate.invoiceNo = invoice.invoiceNo;
      return invoice as T;
    }

    case "list_sales_orders":
      requireOpen();
      return state.salesOrders
        .slice()
        .sort((left, right) => right.orderDate.localeCompare(left.orderDate) || right.id - left.id) as T;

    case "get_sales_order": {
      requireOpen();
      const order = state.salesOrders.find((candidate) => candidate.id === payload.id);
      if (!order) throw new Error("sales order does not exist");
      return order as T;
    }

    case "save_sales_order": {
      requireOpen();
      const input = payload.input as SalesOrderInput;
      const existing = state.salesOrders.find((candidate) => candidate.id === input.id);
      if (existing?.invoiceId) {
        throw new Error(
          "this order has already been invoiced, so its contents are fixed; start a new order if it changed",
        );
      }
      const lines = writePipelineLines(input.lines.filter((line) => line.description.trim() || line.unitPriceCents > 0));
      if (lines.length === 0) throw new Error("add at least one line to the document");
      const totals = pipelineTotals(lines, input.taxBp);
      if (totals.total <= 0) throw new Error("a sales order must be worth more than zero");
      const customer = state.customers.find((candidate) => candidate.id === input.customerId);
      const record: SalesOrder = {
        id: input.id ?? id("order"),
        orderNo:
          input.orderNo?.trim() ||
          nextSeries("SO", state.salesOrders.map((candidate) => candidate.orderNo)),
        customerId: input.customerId ?? null,
        customerName: customer?.name ?? "",
        orderDate: input.orderDate,
        requestedDate: input.requestedDate ?? null,
        status: input.status,
        taxBp: input.taxBp,
        notes: input.notes ?? "",
        subtotalCents: totals.subtotal,
        taxCents: totals.tax,
        totalCents: totals.total,
        invoiceId: existing?.invoiceId ?? null,
        invoiceNo: existing?.invoiceNo ?? null,
        estimateId: existing?.estimateId ?? null,
        estimateNo: existing?.estimateNo ?? null,
        convertedAt: existing?.convertedAt ?? null,
        lines,
      };
      if (existing) Object.assign(existing, record);
      else state.salesOrders.push(record);
      auditRow(existing ? "UPDATE" : "INSERT", "sales_orders", record.id, record);
      return record as T;
    }

    case "delete_sales_order": {
      requireOpen();
      const order = state.salesOrders.find((candidate) => candidate.id === payload.id);
      if (!order) throw new Error("sales order does not exist");
      if (order.invoiceId) throw new Error("this order has already been invoiced, so it stays on file");
      state.salesOrders = state.salesOrders.filter((candidate) => candidate.id !== order.id);
      for (const estimate of state.estimates) {
        if (estimate.convertedOrderId === order.id) {
          estimate.convertedOrderId = null;
          estimate.orderNo = null;
        }
      }
      auditRow("DELETE", "sales_orders", order.id, order);
      return undefined as T;
    }

    case "convert_sales_order_to_invoice": {
      requireOpen();
      const order = state.salesOrders.find((candidate) => candidate.id === payload.id);
      if (!order) throw new Error("sales order does not exist");
      if (order.invoiceId) throw new Error(`${order.orderNo} has already been invoiced`);
      if (order.status === "Cancelled") throw new Error(`${order.orderNo} is cancelled, so it cannot be invoiced`);
      const date = (payload.invoiceDate as string) || today();
      const invoice = writeInvoice(invoiceInputFrom(order.customerId, date, order.taxBp, order.lines));
      order.invoiceId = invoice.id;
      order.invoiceNo = invoice.invoiceNo;
      order.convertedAt = new Date().toISOString();
      order.status = "Fulfilled";
      for (const estimate of state.estimates) {
        if (estimate.convertedOrderId === order.id) estimate.convertedInvoiceId = invoice.id;
      }
      return invoice as T;
    }

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

    case "current_user":
      return actingUser() as T;

    case "switch_user": {
      const user = state.users.find((candidate) => candidate.id === payload.id);
      if (!user) throw new Error("that user does not exist");
      if (!user.isActive) throw new Error(`${user.name} is switched off; switch them back on first`);
      state.currentUserId = user.id;
      return user as T;
    }

    case "list_people": {
      requireOpen();
      return state.users.map((user) => ({
        id: user.id,
        name: user.name,
        access: user.access,
        isActive: user.isActive,
      })) as T;
    }

    case "list_users": {
      requireOpen();
      return state.users.slice().sort((left, right) => left.name.localeCompare(right.name)) as T;
    }

    case "save_user": {
      requireOpen();
      const input = payload.input as UserInput;
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("a user needs a name");
      if (state.users.some((candidate) => candidate.name.toLowerCase() === name.toLowerCase() && candidate.id !== input.id)) {
        throw new Error(`there is already a user called ${name}`);
      }
      const existing = state.users.find((candidate) => candidate.id === input.id);
      const access = input.access ?? "Standard";
      const isActive = input.isActive ?? true;
      if (existing && existing.access === "Admin" && existing.isActive && (access !== "Admin" || !isActive)) {
        const otherAdmins = state.users.filter(
          (candidate) => candidate.id !== existing.id && candidate.access === "Admin" && candidate.isActive,
        ).length;
        if (otherAdmins === 0) throw new Error("this is the last admin; promote someone else before changing this user");
      }
      const record: User = {
        id: existing?.id ?? id("user"),
        name,
        email: (input.email ?? "").trim(),
        access,
        isActive,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      if (existing) Object.assign(existing, record);
      else state.users.push(record);
      auditRow(existing ? "UPDATE" : "INSERT", "users", record.id, record);
      return record as T;
    }

    case "delete_user": {
      requireOpen();
      const user = state.users.find((candidate) => candidate.id === payload.id);
      if (!user) throw new Error("that user does not exist");
      if (user.access === "Admin" && user.isActive) {
        const otherAdmins = state.users.filter(
          (candidate) => candidate.id !== user.id && candidate.access === "Admin" && candidate.isActive,
        ).length;
        if (otherAdmins === 0) throw new Error("this is the last admin; promote someone else before deleting this user");
      }
      state.users = state.users.filter((candidate) => candidate.id !== user.id);
      state.timeEntries = state.timeEntries.filter((entry) => entry.userId !== user.id);
      if (state.currentUserId === user.id) state.currentUserId = actingUser().id;
      auditRow("DELETE", "users", user.id, user);
      return undefined as T;
    }

    case "list_time_entries": {
      requireOpen();
      const me = actingUser();
      const entries = me.access === "TimeEntry" ? state.timeEntries.filter((entry) => entry.userId === me.id) : state.timeEntries;
      return entries
        .slice()
        .sort((left, right) => right.entryDate.localeCompare(left.entryDate) || right.id - left.id) as T;
    }

    case "save_time_entry": {
      requireOpen();
      const input = payload.input as TimeEntryInput;
      const me = actingUser();
      if (!input.entryDate) throw new Error("the date is required");
      if (input.quantityHundredths <= 0) {
        throw new Error(input.kind === "Mileage" ? "enter the miles driven" : "enter the hours worked");
      }
      const ownerId = me.access === "TimeEntry" ? me.id : input.userId ?? me.id;
      const owner = state.users.find((candidate) => candidate.id === ownerId);
      if (!owner) throw new Error("that person is not on this company file");
      const existing = state.timeEntries.find((candidate) => candidate.id === input.id);
      if (existing && me.access === "TimeEntry" && existing.userId !== me.id) {
        throw new Error("that time entry belongs to someone else");
      }
      if (existing?.reimbursedRunId) {
        throw new Error("this mileage was already reimbursed on a pay run; it stays as it was paid");
      }
      const record: TimeEntry = {
        id: existing?.id ?? id("time"),
        userId: owner.id,
        enteredBy: owner.name,
        entryDate: input.entryDate,
        kind: input.kind,
        description: (input.description ?? "").trim(),
        customer: (input.customer ?? "").trim(),
        quantityHundredths: input.quantityHundredths,
        rateCents: input.rateCents,
        amountCents: Math.round((input.quantityHundredths * input.rateCents) / 100),
        isBillable: input.isBillable ?? true,
        reimbursedRunId: existing?.reimbursedRunId ?? null,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      if (existing) Object.assign(existing, record);
      else state.timeEntries.push(record);
      auditRow(existing ? "UPDATE" : "INSERT", "time_entries", record.id, record);
      return record as T;
    }

    case "delete_time_entry": {
      requireOpen();
      const me = actingUser();
      const entry = state.timeEntries.find((candidate) => candidate.id === payload.id);
      if (!entry) throw new Error("that time entry does not exist");
      if (me.access === "TimeEntry" && entry.userId !== me.id) {
        throw new Error("that time entry belongs to someone else");
      }
      if (entry.reimbursedRunId) {
        throw new Error("this mileage was reimbursed on a pay run; delete that pay run first");
      }
      state.timeEntries = state.timeEntries.filter((candidate) => candidate.id !== entry.id);
      auditRow("DELETE", "time_entries", entry.id, entry);
      return undefined as T;
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

    case "save_document": {
      // In the browser preview the paper arrives as an ordinary download.
      const fileName = String(payload.fileName ?? "document.html");
      const contents = String(payload.contents ?? "");
      const url = URL.createObjectURL(new Blob([contents], { type: "text/html;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      return fileName as T;
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
        schemaVersion: 7,
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
