# LedgerWorks

A desktop bookkeeping application for people who run a business, not people who
keep accounts. You record **income, an expense, a purchase, an invoice or a pay
run** in the words you already use; the double-entry ledger, the trial balance
and a tamper-evident audit trail are written for you.

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
- **Recurring invoices** — weekly, monthly, quarterly or yearly schedules that
  raise a real sent invoice for each cycle, dated the day it fell due; missed
  cycles are caught up the next time invoices are generated.
- **Purchases** — one record updates quantity, weighted-average cost, the linked
  expense posting, and vendor history. New item names are created on the way
  through.
- **Inventory** — products, consumables and services; quantity, cost, sell price,
  stock value.
- **Payroll** — gross from rate × hours plus 1.5× overtime, deductions as
  percentages, net pay, and a balanced posting for wages and withheld amounts.
- **Customers / Vendors** — contact details plus what they were billed or what
  you spent, and what is still outstanding.
- **Reports** — Profit & Loss, Balance Sheet, Tax Summary. Every figure comes
  from posted journal lines, so a report can never drift from the ledger.
- **Printing and saving paper** — every invoice, and each of those three
  reports, has **Print** and **Download**. Print renders the document on its own
  page, clean of the app, and opens the system dialog (choose *Microsoft Print to
  PDF* for a PDF). Download writes the same document into the user's Downloads
  folder and reports the full path; an existing file is never overwritten. Each
  sheet carries the business details from Settings at the top, so a customer
  sees who billed them on the paper itself.
- **The ledger (Advanced)** — chart of accounts, manual journal, trial balance
  and audit trail for anyone who wants to see the machinery.
- **Settings** — business details (address, phone, email, website, printed on
  every document), company file, invoice defaults, and the account roles above.

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
  src/schema.rs              migrations v1 and v2, constraints, triggers
  src/journal.rs             validation, post, void, in-transaction variants
  src/simple.rs              plain-language records + their postings + reports
  src/accounts.rs            chart of accounts, seed chart, normal balances
  src/audit.rs               hash-chain sealing and verification
  src/company.rs             create / list / describe / copy company files
  src/reports.rs             trial balance, ledger balance check
  tests/ledger.rs            journal invariants (18 tests)
  tests/records.rs           records, postings, stock, reports, audit (14 tests)
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

1. **Orders and shippers** — a sales pipeline that becomes an invoice, with
   shipping and tracking.
2. **Credit memos** — returns and corrections that reduce what a customer owes.
3. **Banking** — statement import, matching, reconciliation.
4. **Multi-user host service** — ed25519 host identity, concurrent sessions
   against one company file, backup and restore.
5. **A real PDF engine** — printing today goes through the system dialog and
   downloads are HTML that opens and prints anywhere; statements and pay stubs
   are not laid out yet, and no PDF is produced without the print dialog.

## Verification status

`cargo test -p accounting-core`: 46 tests passing — journal invariants, raw-SQL
rejection, immutability, audit tamper detection, and the record layer (income,
expenses, tax, invoices with stock and cost of goods sold, invoice reverts,
income-to-invoice linking and numbering, recurring cycles and end dates,
weighted-average purchases, pay runs, date-ranged reports, schema migration from
v2, audit chain after a full day of bookkeeping).

The React app type-checks and bundles with `npm run build`.

The Tauri shell compile-checks on Windows with
`cargo check -p ledgerworks --all-targets`, and builds `.msi`/NSIS installers in
CI (`npm run tauri build` locally). Its `save_document` filename handling has
unit tests (`cargo test -p ledgerworks --lib`): a requested name stays one path
segment and an earlier download is kept as `name (2).html`.

Printed documents were verified in the running app: the P&L, Balance Sheet and
Tax Summary each produce their own file (sections, totals and period headings
checked in the saved bytes), and an invoice previews exactly what prints.
