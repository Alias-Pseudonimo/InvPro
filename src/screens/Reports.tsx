import { useState } from "react";
import { api } from "../api";
import type { AccountBalance } from "../types";
import { ErrorNote, money, useLoad } from "../ui";

type Mode = "pl" | "balance" | "tax";

function yearStart(): string {
  return `${new Date().getFullYear()}-01-01`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function Rows({ title, rows, total, tone }: { title: string; rows: AccountBalance[]; total: number; tone?: "pos" | "neg" }) {
  return (
    <div className="report-block">
      <div className="report-head">
        <span>{title}</span>
        <span className="num">{money(total)}</span>
      </div>
      {rows.length === 0 ? (
        <div className="report-empty">Nothing in this period.</div>
      ) : (
        rows.map((row) => (
          <div className="report-row" key={`${row.accountId}-${row.name}`}>
            <span>
              {row.name}
              {row.number ? <span className="muted small"> · {row.number}</span> : null}
            </span>
            <span className={`num ${tone === "neg" ? "money-neg" : ""}`}>{money(row.amountCents)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export default function ReportsScreen({ mode, revision }: { mode: Mode; revision: number }) {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayISO());

  const pl = useLoad(() => api.profitAndLoss(from, to), [revision, from, to, mode === "pl"]);
  const sheet = useLoad(() => api.balanceSheet(to), [revision, to, mode === "balance"]);
  const tax = useLoad(() => api.taxSummary(from, to), [revision, from, to, mode === "tax"]);

  const error = mode === "pl" ? pl.error : mode === "balance" ? sheet.error : tax.error;
  if (error) return <ErrorNote text={error} />;

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          Every number here comes from the posted ledger, not from a separate tally — so it can never drift from your records.
        </div>
        <div className="date-range">
          <label>
            From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            {mode === "balance" ? "As of" : "To"}
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
      </div>

      {mode === "pl" && pl.data && (
        <div className="card card-pad report">
          <div className="report-title">
            <h2>Profit &amp; Loss</h2>
            <span className="muted">
              {from} to {to}
            </span>
          </div>
          <Rows title="Income" rows={pl.data.income} total={pl.data.totalIncomeCents} />
          <Rows title="Costs and expenses" rows={pl.data.expenses} total={pl.data.totalExpenseCents} tone="neg" />
          <div className={`report-total ${pl.data.netCents >= 0 ? "money-pos" : "money-neg"}`}>
            <span>Net profit</span>
            <span className="num">{money(pl.data.netCents)}</span>
          </div>
        </div>
      )}

      {mode === "balance" && sheet.data && (
        <div className="card card-pad report">
          <div className="report-title">
            <h2>Balance Sheet</h2>
            <span className="muted">as of {to}</span>
          </div>
          <Rows title="Assets" rows={sheet.data.assets} total={sheet.data.totalAssetsCents} />
          <Rows title="Liabilities" rows={sheet.data.liabilities} total={sheet.data.totalLiabilitiesCents} tone="neg" />
          <Rows title="Equity" rows={sheet.data.equity} total={sheet.data.totalEquityCents} />
          <div className="report-row">
            <span className="muted">Profit so far, included in equity</span>
            <span className="num">{money(sheet.data.netIncomeCents)}</span>
          </div>
          <div className={`report-total ${sheet.data.balanced ? "money-pos" : "money-neg"}`}>
            <span>{sheet.data.balanced ? "Assets = liabilities + equity" : "Out of balance — check the ledger"}</span>
            <span className="num">{money(sheet.data.totalAssetsCents)}</span>
          </div>
        </div>
      )}

      {mode === "tax" && tax.data && (
        <div className="card card-pad report">
          <div className="report-title">
            <h2>Tax Summary</h2>
            <span className="muted">
              {from} to {to}
            </span>
          </div>
          <div className="report-row">
            <span>Sales with tax</span>
            <span className="num">{money(tax.data.taxableSalesCents)}</span>
          </div>
          <div className="report-row">
            <span>Sales without tax</span>
            <span className="num">{money(tax.data.untaxedSalesCents)}</span>
          </div>
          <div className="report-row">
            <span>Sales tax collected</span>
            <span className="num">{money(tax.data.salesTaxCollectedCents)}</span>
          </div>
          <div className="report-row">
            <span>Tax paid on purchases</span>
            <span className="num">{money(tax.data.purchaseTaxCents)}</span>
          </div>
          <div className="report-total">
            <span>Sales tax to set aside</span>
            <span className="num">{money(tax.data.salesTaxCollectedCents)}</span>
          </div>
          <div className="settings-note">
            Tax rates are what you typed on each record. This is a working summary for setting money aside, not a filed return.
          </div>
        </div>
      )}
    </>
  );
}
