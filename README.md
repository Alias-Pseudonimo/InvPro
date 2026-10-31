# LedgerWorks

A desktop bookkeeping application for people who run a business, not people who
keep accounts. You record **a quote, an order, an invoice, an expense, a
purchase or a pay run** in the words you already use; the double-entry ledger,
the trial balance and a tamper-evident audit trail are written for you.

React 18 + Tauri 2 (Rust) + SQLite. One company is one portable file.

## The idea

Most small-business accounting software asks the owner to think like an
accountant: pick a debit account, pick a credit account, balance the entry. This
app inverts that. The owner answers questions they can answer — *who paid me,
how much, was it in the bank or still owed?* — and the app derives the entry.

Two rules keep the simplification from becoming a cage:

1. **Categories come from a list you can extend.** Income picks from the
   categories already in use, then offers *+ New category*. A new name becomes a
   real account on the spot, so nothing needs setting up first and the chart
   grows the way the owner describes their own business.
2. **Account roles are data, not code.** Which account is "money in the bank",
   which collects sales tax, which holds stock — all live in `settings` as
   account ids. Point them anywhere and every future posting follows. Nothing is
   hard-wired.

What the owner records, and what the books receive:

| You record | Debit | Credit |
| --- | --- | --- |
| Income, already paid | Checking | the income category you typed |
| Income, still owed | Accounts Receivable | the income category you typed |
| Income with an invoice number | the invoice it creates or settles — revenue, tax and cash follow the invoice rules, never twice |
| Expense, already paid | the expense category you typed | Checking |
| Expense, still owed | the expense category you typed | Accounts Payable |
| Estimate or sales order | *nothing* — paperwork only, until it becomes an invoice |
| Invoice marked **Sent** | Accounts Receivable | revenue + sales tax payable |
| Invoice sold stock | Cost of goods sold | Inventory |
| Invoice marked **Paid** | Checking | Accounts Receivable |
| Purchase | the purchase category | Checking or Accounts Payable |
| Pay run | Wages | Checking (net) + payroll liabilities |

Editing any record voids its previous entry and posts the corrected one — the
ledger is never silently rewritten. Deleting reverses the entry the same way.
Both operations appear in the audit trail.

## What is in the app

- **Dashboard** — money in, money out, net, cash, what you are owed, what you
  owe, sales tax collected, stock value, spending by category, recent activity.
- **Income / Expenses** — plain records with paid/unpaid, tax rate, category,
  customer or vendor. An income record can carry an invoice number: the invoice
  is created from it (or the payment is applied to the invoice already there),
  so one sale never becomes two documents or two lots of revenue.
- **Invoices** — drafts are free; sending reserves receivables and takes stock
  out (booking cost of goods sold at item cost); paid moves the money to the
  bank. Reverting restores stock and voids the revenue. Automatic numbers skip
  every number already used, on an invoice or on an income record.
- **Estimates** — a quote with its own number series, a validity date and a
  status (draft, sent, accepted, declined, expired). It posts nothing. “Make
  order” or “Make invoice” copies its lines into the next document and freezes
  the quote, so a document that something else depends on is never edited.
- **Sales orders** — the order the customer actually placed, optionally raised
  from a quote. It carries what was ordered and when it is wanted, still posts
  nothing, and becomes a draft invoice with one click. Invoicing an order marks
  it fulfilled and freezes it.
- **Recurring invoices** — weekly, monthly, quarterly or yearly schedules that
  raise a real sent invoice for each cycle, dated the day it fell due; missed
  cycles are caught up the next time invoices are generated.
- **Purchases** — one record updates quantity, weighted-average cost, the linked
  expense posting, and vendor history. New item names are created on the way
  through.
- **Inventory** — products, consumables and services; quantity, cost, sell price,
  stock value.
- **Payroll** — gross from rate × hours plus 1.5× overtime, or a yearly salary
  split into the employee's own pay frequency (weekly, every two weeks, twice a
  month, or monthly — 52, 26, 24 or 12 checks), plus net pay and a balanced
  posting for wages and withheld amounts. A pay run records the basis it was paid
  on, so a raise or a move to salary never rewrites an old check. Federal
  withholding uses
  marital status (single or married) and withholding allowances: each allowance
  takes a slice of pay out of the federal base before the rate applies, and a
  W-4 extra amount is added after it. **No rate is fixed in the engine** —
  Social Security, Medicare, federal, state, the allowance value and the mileage
  rate are all admin settings, and each pay run keeps the figures it was paid
  under. The engine computes it, so the preview in the composer and the saved
  pay run can never disagree. Nobody is paid off the books: the composer lists
  roster people only, never a typed name, and its **Add an employee** link opens
  the roster form and hands the new hire straight back to the check being written.
- **Additions** — money on the check that is not wages: reimbursed business
  miles (from the person's own unreimbursed log, at the mileage rate) and a
  per-period allowance, each a plain Yes/No on the run. Additions are never
  taxed and never join gross pay; they post to Employee Reimbursements, and the
  miles they pay are marked so a mile is only ever reimbursed once.
- **Employees** — a payroll roster separate from the people who log in, and the
  only place a pay run can draw a name from. Adding
  an employee walks the W-4 (filing status, allowances, extra withholding) and
  the W-2 identity (name, address, Social Security number, hire date, employee
  number), plus pay basis (hourly or salary, and how often), the amount, and a
  per-period allowance. The whole Social Security number is kept so a W-2 can be
  produced; lists show the last four for readability, and the audit trail records
  a correction with the number before and after it. A login is optional and only
  exists to attribute time and mileage. Someone with pay runs on file is retired
  rather than deleted, so W-2 history keeps a name. The **time sheet** lives here
  too — billable hours and miles are paid work, not a separate part of the
  business.
- **Customers / Vendors** — contact details plus what they were billed or what
  you spent, and what is still outstanding.
- **Reports** — Profit & Loss, Balance Sheet, Tax Summary. Every figure comes
  from posted journal lines, so a report can never drift from the ledger.
- **Printing and saving paper** — every invoice, estimate, sales order and each
  of those three reports, has **Print** and **Download**. Print renders the document on its own
  page, clean of the app, and opens the system dialog (choose *Microsoft Print to
  PDF* for a PDF). Download writes the same document into the user's Downloads
  folder and reports the full path; an existing file is never overwritten. Each
  sheet carries the business details from Settings at the top, so a customer
  sees who billed them on the paper itself.
- **The ledger (Advanced)** — chart of accounts, manual journal, trial balance
  and audit trail for anyone who wants to see the machinery.
- **Settings** — business details (address, phone, email, website, printed on
  every document), company file, invoice defaults, and the account roles above.

## Who can do what

Every command in the shell declares what it needs, and the engine checks the
acting user's level before it runs — a screen cannot widen its own permissions.

| Level | Reaches | Does not reach |
| --- | --- | --- |
| Admin | Everything, including people, settings, payroll and closing the books | — |
| Standard | Every book transaction and report, plus time and mileage | Payroll, the roster, settings, people |
| Payroll | Pay runs, the employee roster, and time and mileage | Invoices, journals, reports, settings, people |
| Time entry | Their own hours and miles | Everything else |
| Read only | Viewing transactions and reports | Creating or editing anything |

Payroll is deliberately its own door rather than a checkbox on Standard: wages
and Social Security numbers belong to the admin and the person who runs payroll,
not to whoever happens to be invoicing.

## The rules that cannot be broken

The SQLite schema enforces the same invariants the app relies on, so an
importer, a future sync worker or a hand-opened `sqlite3` session cannot corrupt
the books:

| Invariant | Enforced by |
| --- | --- |
| A line carries exactly one of debit/credit, never both, never zero | `CHECK` on `journal_lines` |
| Debits must equal credits before an entry can post | `trg_entry_post_guard` |
| An entry needs at least two lines and a non-zero value | `trg_entry_post_guard` |
| Entries are created as drafts and then posted | `trg_entry_create_as_draft` |
| Posted entries cannot be edited or deleted, only voided | `trg_entry_posted_immutable`, `trg_entry_no_delete_posted` |
| Lines only change while the entry is a draft | `trg_lines_draft_only_*` |
| No posting to an inactive or header account | `trg_lines_account_rules_*` |
| A sub-account must share its parent's type | `trg_accounts_parent_type_*` |
| A converted estimate or invoiced order cannot change or be deleted | `trg_estimate_lines_*`, `trg_sales_order_lines_*`, `trg_estimates_no_delete_converted`, `trg_sales_orders_no_delete_invoiced` |
| A posted credit memo is frozen; corrections are a void plus a new memo | `trg_credit_memo_posted_immutable`, `trg_credit_memo_lines_*` |
| Every write to accounts, entries, lines and every record table is logged | `trg_audit_*` |

Audit rows are written by triggers with the acting user from `app_session`, then
sealed into a SHA-256 chain in the same transaction as the change:

```
hash(n) = SHA-256( hash(n-1) | seq | at | actor | action | entity | entity_id | before | after )
```

Settings → *Verify the audit chain* recomputes it and reports the first row that
does not verify, or reports rows that were never sealed rather than trusting them.

## Layout

```
crates/accounting-core/      the engine, with no Tauri dependency
  src/schema.rs              migrations v1–v8, constraints, triggers
  src/journal.rs             validation, post, void, in-transaction variants
  src/simple.rs              plain-language records + their postings + reports
  src/credits.rs             credit memos: apply, refund, retain, void
  src/pipeline.rs            estimates and sales orders, and their conversions
  src/users.rs               people, access levels, time and mileage
  src/employees.rs           payroll roster: W-4, W-2, pay basis, mileage due
  src/accounts.rs            chart of accounts, seed chart, normal balances
  src/audit.rs               hash-chain sealing and verification
  src/company.rs             create / list / describe / copy company files
  src/reports.rs             trial balance, ledger balance check
  tests/ledger.rs            journal invariants (18 tests)
  tests/records.rs           records, postings, stock, reports, audit (21 tests)
  tests/credits.rs           the three credit outcomes, access levels and their posting (14 tests)
  tests/pipeline.rs          quotes, orders, conversions, payroll withholding (7 tests)
  tests/payroll.rs           rates, additions, mileage, salary, SSNs, employees (18 tests)
src-tauri/                   Tauri shell: one command per operation
src/                         React UI (screens/, ui.tsx, api.ts, mock.ts)
```

`src/mock.ts` is a browser-only stand-in so the UI can be reviewed without the
desktop shell; the desktop build always writes through SQLite.

## Development

```bash
npm install
npm run dev                # UI in a browser, in-memory preview backend
npm run tauri dev          # the real desktop app
cargo test -p accounting-core
npm run build              # tsc --noEmit + vite build
npm run tauri build        # Windows .msi (WiX) and .exe (NSIS)
```

Windows build prerequisites: Rust stable (MSVC), Visual Studio Build Tools with
the C++ workload, WebView2 (preinstalled on Windows 10/11), and WiX v3, which
Tauri downloads for the MSI target.

### Installers from CI

`.github/workflows/windows-installers.yml` builds the desktop app on
`windows-latest` and needs no Windows machine of your own. It runs the engine
tests, type-checks the Tauri command layer, bundles both installers, keeps them
as a workflow artifact, and — when the run came from a `v*` tag — attaches them
to a draft release. Run it from the Actions tab, or push a tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Money is stored as signed integer cents and tax rates as basis points; quantities
as hundredths. No floats touch an amount.

## Not built yet

Ordered by what the books need next, not by what is easiest:

1. **Shipping and tracking** on sales orders — what was sent, when, and by whom.
2. **Banking** — statement import, matching, reconciliation.
3. **Multi-user host service** — ed25519 host identity, concurrent sessions
   against one company file, backup and restore.
4. **A real PDF engine** — printing today goes through the system dialog and
   downloads are HTML that opens and prints anywhere; statements and pay stubs
   are not laid out yet, and no PDF is produced without the print dialog.

## Verification status

`cargo test -p accounting-core`: 89 tests passing — journal invariants, raw-SQL
rejection, immutability, audit tamper detection, and the record layer (income,
expenses, tax, invoices with stock and cost of goods sold, invoice reverts,
income-to-invoice linking and numbering, recurring cycles and end dates,
weighted-average purchases, pay runs with marital status and allowances,
date-ranged reports, schema migrations through v8 including the users rebuild,
the access-level matrix with payroll as its own level, the three credit-memo
outcomes, quotes and orders that never touch the ledger until invoiced, and the
audit chain after a full day of bookkeeping).

The React app type-checks and bundles with `npm run build`.

The Tauri shell compile-checks on Windows with
`cargo check -p ledgerworks --all-targets`, and builds `.msi`/NSIS installers in
CI (`npm run tauri build` locally). Its `save_document` filename handling has
unit tests (`cargo test -p ledgerworks --lib`): a requested name stays one path
segment and an earlier download is kept as `name (2).html`.

Printed documents were verified in the running app: the P&L, Balance Sheet and
Tax Summary each produce their own file (sections, totals and period headings
checked in the saved bytes), and an invoice previews exactly what prints.
