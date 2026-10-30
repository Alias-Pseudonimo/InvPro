export type AccountType =
  | "ASSET"
  | "LIABILITY"
  | "EQUITY"
  | "INCOME"
  | "COGS"
  | "EXPENSE"
  | "OTHER_INCOME"
  | "OTHER_EXPENSE";

export type NormalBalance = "DEBIT" | "CREDIT";

export interface Account {
  id: number;
  number: string;
  name: string;
  accountType: AccountType;
  subtype: string | null;
  parentId: number | null;
  currency: string | null;
  description: string | null;
  isActive: boolean;
  hasChildren: boolean;
  normalBalance: NormalBalance;
}

export interface CompanySummary {
  path: string;
  fileName: string;
  name: string;
  legalName: string | null;
  fileId: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  schemaVersion: number;
  sizeBytes: number;
  modifiedAt: string;
}

export type EntryStatus = "DRAFT" | "POSTED" | "VOID";

export interface EntrySummary {
  id: number;
  entryNo: number;
  entryDate: string;
  memo: string;
  reference: string | null;
  source: string;
  status: EntryStatus;
  totalCents: number;
  lineCount: number;
  createdAt: string;
}

export interface EntryLine {
  id: number;
  lineNo: number;
  accountId: number;
  accountNumber: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo: string;
}

export interface EntryDetail extends EntrySummary {
  lines: EntryLine[];
}

export interface JournalLineInput {
  accountId: number;
  debitCents: number;
  creditCents: number;
  memo?: string;
}

export interface JournalEntryInput {
  entryDate: string;
  memo: string;
  reference?: string;
  source?: string;
  lines: JournalLineInput[];
}

export interface TrialBalanceRow {
  accountId: number;
  number: string;
  name: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
}

export interface TrialBalanceReport {
  rows: TrialBalanceRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  isBalanced: boolean;
  asOf: string | null;
}

export interface ChainReport {
  total: number;
  sealed: number;
  unsealed: number;
  brokenAt: number | null;
  headHash: string | null;
  ok: boolean;
}

export interface AuditRow {
  seq: number;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: number | null;
  beforeJson: string | null;
  afterJson: string | null;
  hash: string | null;
}

export interface LedgerHealth {
  schemaVersion: number;
  integrity: string;
  balanced: boolean;
  accountCount: number;
  entryCount: number;
}

/* ------------------------------------------------------------------ *
 * The plain-language records. These are what the app actually shows; the
 * journal above is what they post into.
 * ------------------------------------------------------------------ */

export interface Customer {
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  isActive: boolean;
  billedCents: number;
  outstandingCents: number;
}

export interface Vendor {
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  isActive: boolean;
  spentCents: number;
  outstandingCents: number;
}

export interface PartyInput {
  id?: number | null;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export type ItemKind = "Product" | "Consumable" | "Service";

export interface InventoryItem {
  id: number;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  kind: ItemKind;
  qtyHundredths: number;
  unitCostCents: number;
  salePriceCents: number;
  isActive: boolean;
  stockValueCents: number;
}

export interface InventoryInput {
  id?: number | null;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  kind?: ItemKind;
  qtyHundredths?: number;
  unitCostCents?: number;
  salePriceCents?: number;
}

export interface IncomeRecord {
  id: number;
  entryDate: string;
  customerId: number | null;
  customerName: string;
  category: string;
  description: string;
  amountCents: number;
  taxBp: number;
  taxCents: number;
  totalCents: number;
  isPaid: boolean;
  invoiceNo: string;
  invoiceId: number | null;
  journalEntryId: number | null;
}

export interface IncomeInput {
  id?: number | null;
  entryDate: string;
  customerId?: number | null;
  category: string;
  description?: string;
  amountCents: number;
  taxBp?: number;
  isPaid?: boolean;
  invoiceNo?: string;
}

export interface ExpenseRecord {
  id: number;
  entryDate: string;
  vendorId: number | null;
  vendorName: string;
  category: string;
  description: string;
  amountCents: number;
  taxBp: number;
  taxCents: number;
  totalCents: number;
  isPaid: boolean;
  journalEntryId: number | null;
}

export interface ExpenseInput {
  id?: number | null;
  entryDate: string;
  vendorId?: number | null;
  category: string;
  description?: string;
  amountCents: number;
  taxBp?: number;
  isPaid?: boolean;
}

export type InvoiceStatus = "Draft" | "Sent" | "Paid";

export interface InvoiceLine {
  id: number;
  position: number;
  description: string;
  qtyHundredths: number;
  unitPriceCents: number;
  amountCents: number;
  inventoryItemId: number | null;
}

export interface Invoice {
  id: number;
  invoiceNo: string;
  customerId: number | null;
  customerName: string;
  invoiceDate: string;
  dueDate: string | null;
  status: InvoiceStatus;
  taxBp: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  stockDeducted: boolean;
  lines: InvoiceLine[];
}

export interface InvoiceLineInput {
  description: string;
  qtyHundredths: number;
  unitPriceCents: number;
  inventoryItemId?: number | null;
}

export interface InvoiceInput {
  id?: number | null;
  invoiceNo?: string | null;
  customerId?: number | null;
  invoiceDate: string;
  dueDate?: string | null;
  status: InvoiceStatus;
  taxBp: number;
  lines: InvoiceLineInput[];
}

export type RecurringFrequency = "Weekly" | "Monthly" | "Quarterly" | "Yearly";

export interface RecurringInvoice {
  id: number;
  customerId: number | null;
  customerName: string;
  description: string;
  frequency: RecurringFrequency;
  startDate: string;
  nextDate: string;
  endDate: string | null;
  taxBp: number;
  isActive: boolean;
  subtotalCents: number;
  totalCents: number;
  lines: InvoiceLine[];
}

export interface RecurringInvoiceInput {
  id?: number | null;
  customerId?: number | null;
  description?: string;
  frequency: RecurringFrequency;
  startDate: string;
  endDate?: string | null;
  taxBp: number;
  isActive?: boolean;
  lines: InvoiceLineInput[];
}

export interface PurchaseLine {
  id: number;
  position: number;
  description: string;
  qtyHundredths: number;
  unitCostCents: number;
  salePriceCents: number;
  amountCents: number;
  inventoryItemId: number | null;
}

export interface Purchase {
  id: number;
  purchaseDate: string;
  vendorId: number | null;
  vendorName: string;
  category: string;
  note: string;
  isPaid: boolean;
  totalCents: number;
  lines: PurchaseLine[];
}

export interface PurchaseLineInput {
  description: string;
  qtyHundredths: number;
  unitCostCents: number;
  salePriceCents: number;
  inventoryItemId?: number | null;
}

export interface PurchaseInput {
  id?: number | null;
  purchaseDate: string;
  vendorId?: number | null;
  category: string;
  note?: string;
  isPaid?: boolean;
  lines: PurchaseLineInput[];
}

export interface PayrollRun {
  id: number;
  employee: string;
  payDate: string;
  checkNumber: string;
  payRateCents: number;
  regularHoursHundredths: number;
  overtimeHoursHundredths: number;
  grossCents: number;
  federalCents: number;
  stateCents: number;
  socialSecurityCents: number;
  medicareCents: number;
  otherDeductionsCents: number;
  totalDeductionsCents: number;
  netCents: number;
  journalEntryId: number | null;
}

export interface PayrollInput {
  id?: number | null;
  employee: string;
  payDate: string;
  checkNumber?: string;
  payRateCents: number;
  regularHoursHundredths: number;
  overtimeHoursHundredths: number;
  federalCents?: number;
  stateCents?: number;
  socialSecurityCents?: number;
  medicareCents?: number;
  otherDeductionsCents?: number;
}

export interface AccountBalance {
  accountId: number;
  number: string;
  name: string;
  amountCents: number;
}

export interface ProfitAndLoss {
  from: string | null;
  to: string | null;
  income: AccountBalance[];
  expenses: AccountBalance[];
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
}

export interface BalanceSheet {
  asOf: string | null;
  assets: AccountBalance[];
  liabilities: AccountBalance[];
  equity: AccountBalance[];
  netIncomeCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  totalEquityCents: number;
  balanced: boolean;
}

export interface TaxSummary {
  from: string | null;
  to: string | null;
  taxableSalesCents: number;
  untaxedSalesCents: number;
  salesTaxCollectedCents: number;
  purchaseTaxCents: number;
}

export interface Activity {
  kind: string;
  date: string;
  description: string;
  party: string;
  amountCents: number;
  isPaid: boolean;
}

export interface DashboardSummary {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  cashCents: number;
  unpaidIncomeCents: number;
  unpaidExpenseCents: number;
  invoiceOutstandingCents: number;
  salesTaxDueCents: number;
  inventoryValueCents: number;
  categories: AccountBalance[];
  recent: Activity[];
}

export interface Setting {
  key: string;
  value: string;
}
