import { api } from "./api";
import type { BusinessProfile } from "./business";
import { formatCents, today } from "./format";
import type { AccountBalance, BalanceSheet, CompanySummary, Invoice, ProfitAndLoss, TaxSummary } from "./types";

/** A finished piece of paper: the HTML, and the name it saves under. */
export interface DocumentFile {
  html: string;
  fileName: string;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                         */
/* ------------------------------------------------------------------ */

function dollars(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${formatCents(Math.abs(cents))}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `2026-10-30` → `30 Oct 2026`, without drifting a day across time zones. */
function prettyDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const parsed = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
}

function slug(value: string): string {
  return value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function businessName(company: CompanySummary | null): string {
  return company?.legalName || company?.name || "Your business";
}

function quantity(hundredths: number): string {
  return (hundredths / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ */
/* Paper styling                                                      */
/* ------------------------------------------------------------------ */

const DOC_STYLE = `
@page { size: letter; margin: 16mm 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body {
  font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
  color: #1d1d1b;
  font-size: 12px;
  line-height: 1.45;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.doc { max-width: 720px; margin: 0 auto; padding: 28px 26px; }
.doc-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  border-bottom: 2px solid #1d1d1b;
  padding-bottom: 14px;
}
.business { font-size: 17px; font-weight: 700; letter-spacing: 0.01em; }
.business small {
  display: block;
  margin-top: 4px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6b6a63;
}
.business .contact {
  margin-top: 7px;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.55;
  color: #6b6a63;
  white-space: pre-line;
}
.doc-kind { text-align: right; }
.doc-kind .kind { font-size: 19px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
.doc-kind .no { font-family: ui-monospace, Consolas, "Courier New", monospace; font-size: 13px; margin-top: 2px; }
.doc-kind .when { font-size: 11px; color: #6b6a63; margin-top: 2px; }
.meta { display: flex; flex-wrap: wrap; gap: 28px 44px; margin: 18px 0 22px; }
.meta div span {
  display: block;
  margin-bottom: 3px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6b6a63;
}
.meta div strong { font-weight: 600; }
.meta .address { white-space: pre-line; }
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left;
  padding: 0 8px 6px;
  font-size: 10px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #6b6a63;
  border-bottom: 1px solid #cdcbc2;
}
td { padding: 7px 8px; border-bottom: 1px solid #e7e5dc; vertical-align: top; }
th.num, td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.totals { margin: 12px 0 0 auto; width: 240px; }
.totals .row { display: flex; justify-content: space-between; padding: 4px 0; }
.totals .grand {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 2px solid #1d1d1b;
  font-size: 14px;
  font-weight: 700;
}
.badge {
  display: inline-block;
  padding: 1px 9px;
  border: 1px solid #1d1d1b;
  border-radius: 999px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.section-title {
  display: flex;
  justify-content: space-between;
  margin: 20px 0 2px;
  padding-bottom: 5px;
  border-bottom: 1px solid #cdcbc2;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #6b6a63;
}
.row-line { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px dotted #ddd9cf; }
.row-line .value { white-space: nowrap; font-variant-numeric: tabular-nums; }
.muted { color: #8a887f; }
.conclusion {
  display: flex;
  justify-content: space-between;
  margin-top: 16px;
  padding-top: 10px;
  border-top: 2px solid #1d1d1b;
  font-size: 15px;
  font-weight: 700;
}
.note {
  margin-top: 26px;
  padding-top: 8px;
  border-top: 1px solid #e7e5dc;
  font-size: 10.5px;
  color: #8a887f;
}
.note p { margin: 0 0 3px; }
@media print { .doc { padding: 0; max-width: none; } }
`;

function wrap(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title><style>${DOC_STYLE}</style></head>
<body><main class="doc">${body}</main></body>
</html>`;
}

function contactLines(profile: BusinessProfile): string {
  const lines: string[] = [];
  if (profile.address) lines.push(escapeHtml(profile.address).replace(/\r?\n/g, "<br />"));
  const inline = [profile.phone, profile.email, profile.website].filter(Boolean).map(escapeHtml);
  if (inline.length > 0) lines.push(inline.join(" · "));
  return lines.length === 0 ? "" : `<div class="contact">${lines.join("<br />")}</div>`;
}

function header(
  company: CompanySummary | null,
  profile: BusinessProfile,
  kind: string,
  reference: string,
  when: string,
): string {
  const currency = company?.baseCurrency ? `Amounts in ${company.baseCurrency}` : "";
  return `<header class="doc-head">
  <div class="business">${escapeHtml(businessName(company))}${currency ? `<small>${escapeHtml(currency)}</small>` : ""}${contactLines(profile)}</div>
  <div class="doc-kind">
    <div class="kind">${escapeHtml(kind)}</div>
    ${reference ? `<div class="no">${escapeHtml(reference)}</div>` : ""}
    <div class="when">${escapeHtml(when)}</div>
  </div>
</header>`;
}

function footer(company: CompanySummary | null): string {
  return `<div class="note">
  <p>${escapeHtml(businessName(company))}${company?.legalName && company?.name ? ` · ${escapeHtml(company.name)}` : ""}</p>
  <p>Prepared from the posted double-entry ledger on ${escapeHtml(prettyDate(today()))}. Internal copy — keep with your accounting records.</p>
</div>`;
}

/* ------------------------------------------------------------------ */
/* Invoice                                                            */
/* ------------------------------------------------------------------ */

export interface InvoiceParty {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
}

export function invoiceDocument(
  invoice: Invoice,
  company: CompanySummary | null,
  profile: BusinessProfile,
  customer?: InvoiceParty,
): DocumentFile {
  const taxPct = invoice.taxBp / 100;
  const rows = invoice.lines
    .map(
      (line) => `<tr>
      <td>${escapeHtml(line.description || "—")}</td>
      <td class="num">${escapeHtml(quantity(line.qtyHundredths))}</td>
      <td class="num">${dollars(line.unitPriceCents)}</td>
      <td class="num">${dollars(line.amountCents)}</td>
    </tr>`,
    )
    .join("");

  const party = customer ?? { name: invoice.customerName };
  const billTo = `<div class="meta">
    <div>
      <span>Billed to</span>
      <strong>${escapeHtml(party.name || "—")}</strong>
      ${party.address ? `<div class="address muted">${escapeHtml(party.address)}</div>` : ""}
      ${party.email ? `<div class="muted">${escapeHtml(party.email)}</div>` : ""}
      ${party.phone ? `<div class="muted">${escapeHtml(party.phone)}</div>` : ""}
    </div>
    <div><span>Invoice date</span><strong>${escapeHtml(prettyDate(invoice.invoiceDate))}</strong></div>
    <div><span>Due date</span><strong>${escapeHtml(prettyDate(invoice.dueDate))}</strong></div>
    <div><span>Status</span><strong><span class="badge">${escapeHtml(invoice.status)}</span></strong></div>
  </div>`;

  const taxLabel = taxPct > 0 ? `Tax ${taxPct.toFixed(2).replace(/\.?0+$/, "")}%` : "Tax";
  const totals = `<div class="totals">
    <div class="row"><span>Subtotal</span><span class="value">${dollars(invoice.subtotalCents)}</span></div>
    <div class="row"><span>${escapeHtml(taxLabel)}</span><span class="value">${dollars(invoice.taxCents)}</span></div>
    <div class="grand"><span>Total</span><span class="value">${dollars(invoice.totalCents)}</span></div>
  </div>`;

  const closing =
    invoice.status === "Paid"
      ? `Paid in full — thank you.`
      : invoice.status === "Draft"
        ? `Draft — not yet sent to the customer.`
        : invoice.dueDate
          ? `Payment due by ${prettyDate(invoice.dueDate)}.`
          : `Payment due on receipt.`;

  const title = `Invoice ${invoice.invoiceNo}`;
  const body = `${header(company, profile, "Invoice", invoice.invoiceNo, `Issued ${prettyDate(invoice.invoiceDate)}`)}
${billTo}
<table>
  <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="4" class="muted">This invoice has no lines.</td></tr>`}</tbody>
</table>
${totals}
<div class="note"><p>${escapeHtml(closing)}</p></div>
${footer(company)}`;

  return { html: wrap(title, body), fileName: `Invoice-${slug(invoice.invoiceNo) || invoice.id}-${invoice.invoiceDate}.html` };
}

/* ------------------------------------------------------------------ */
/* Reports                                                            */
/* ------------------------------------------------------------------ */

function section(title: string, rows: AccountBalance[], total: number, empty: string): string {
  const body =
    rows.length === 0
      ? `<div class="row-line muted">${escapeHtml(empty)}</div>`
      : rows
          .map(
            (row) => `<div class="row-line">
      <span>${escapeHtml(row.name)}${row.number ? `<span class="muted"> · ${escapeHtml(row.number)}</span>` : ""}</span>
      <span class="value">${dollars(row.amountCents)}</span>
    </div>`,
          )
          .join("");
  return `<div class="section-title"><span>${escapeHtml(title)}</span><span>${dollars(total)}</span></div>${body}`;
}

export function profitAndLossDocument(
  report: ProfitAndLoss,
  from: string,
  to: string,
  company: CompanySummary | null,
  profile: BusinessProfile,
): DocumentFile {
  const period = `${prettyDate(from)} to ${prettyDate(to)}`;
  const body = `${header(company, profile, "Profit & Loss", "", period)}
${section("Income", report.income, report.totalIncomeCents, "No income in this period.")}
${section("Costs and expenses", report.expenses, report.totalExpenseCents, "No costs in this period.")}
<div class="conclusion"><span>Net profit</span><span>${dollars(report.netCents)}</span></div>
${footer(company)}`;
  return { html: wrap("Profit & Loss", body), fileName: `Profit-and-Loss-${from}-to-${to}.html` };
}

export function balanceSheetDocument(
  report: BalanceSheet,
  asOf: string,
  company: CompanySummary | null,
  profile: BusinessProfile,
): DocumentFile {
  const body = `${header(company, profile, "Balance Sheet", "", `As of ${prettyDate(asOf)}`)}
${section("Assets", report.assets, report.totalAssetsCents, "No assets.")}
${section("Liabilities", report.liabilities, report.totalLiabilitiesCents, "No liabilities.")}
${section("Equity", report.equity, report.totalEquityCents, "No equity accounts.")}
<div class="row-line"><span>Profit so far, included in equity</span><span class="value">${dollars(report.netIncomeCents)}</span></div>
<div class="conclusion"><span>${report.balanced ? "Assets = liabilities + equity" : "Assets do not match liabilities and equity — check the ledger"}</span><span>${dollars(report.totalAssetsCents)}</span></div>
${footer(company)}`;
  return { html: wrap("Balance Sheet", body), fileName: `Balance-Sheet-${asOf}.html` };
}

export function taxSummaryDocument(
  report: TaxSummary,
  from: string,
  to: string,
  company: CompanySummary | null,
  profile: BusinessProfile,
): DocumentFile {
  const line = (label: string, cents: number) =>
    `<div class="row-line"><span>${escapeHtml(label)}</span><span class="value">${dollars(cents)}</span></div>`;
  const body = `${header(company, profile, "Tax Summary", "", `${prettyDate(from)} to ${prettyDate(to)}`)}
${line("Sales with tax", report.taxableSalesCents)}
${line("Sales without tax", report.untaxedSalesCents)}
${line("Sales tax collected", report.salesTaxCollectedCents)}
${line("Tax paid on purchases", report.purchaseTaxCents)}
<div class="conclusion"><span>Sales tax to set aside</span><span>${dollars(report.salesTaxCollectedCents)}</span></div>
<div class="note"><p>Tax rates are those entered on each record. This is a working summary for setting money aside, not a filed return.</p></div>
${footer(company)}`;
  return { html: wrap("Tax Summary", body), fileName: `Tax-Summary-${from}-to-${to}.html` };
}

/* ------------------------------------------------------------------ */
/* Printing and saving                                                */
/* ------------------------------------------------------------------ */

/**
 * Send a document to the printer through a hidden frame, so the app window
 * itself is never part of the page. On Windows the system dialog offers
 * "Microsoft Print to PDF" for a PDF copy.
 */
export function printDocument(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", "Printable document");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";
  frame.srcdoc = html;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) {
      frame.remove();
      return;
    }
    win.focus();
    win.print();
    window.setTimeout(() => frame.remove(), 2000);
  };
  globalThis.document.body.appendChild(frame);
}

/**
 * Save the document on the user's computer. In the desktop shell the Rust side
 * writes it to the Downloads folder and returns the full path; in the browser
 * preview it arrives as an ordinary download.
 */
export async function saveDocument(file: DocumentFile): Promise<string> {
  return api.saveDocument(file.fileName, file.html);
}
