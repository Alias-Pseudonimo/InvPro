import { api } from "../api";
import { ErrorNote, Empty, Stat, money, useLoad } from "../ui";

export default function Dashboard({
  revision,
  go,
}: {
  revision: number;
  go: (tab: string) => void;
}) {
  const { data, error } = useLoad(() => api.dashboard(), [revision]);

  if (error) return <ErrorNote text={error} />;
  if (!data) return <div className="empty">Opening your books…</div>;

  const categories = data.categories.filter((row) => row.amountCents > 0);
  const max = Math.max(1, ...categories.map((row) => row.amountCents));

  return (
    <div className="two-col">
      <div>
        <div className="grid grid-3">
          <Stat label="Money in" value={money(data.incomeCents)} hint="all time" tone="pos" />
          <Stat label="Money out" value={money(data.expenseCents)} hint="all time" tone="neg" />
          <Stat
            label="Net"
            value={money(data.netCents)}
            hint="in minus out"
            tone={data.netCents >= 0 ? "pos" : "neg"}
          />
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Where the money goes</h3>
            <span className="hint">by category</span>
          </div>
          <div className="card-pad">
            {categories.length === 0 ? (
              <Empty>No expenses recorded yet.</Empty>
            ) : (
              categories.map((row) => (
                <div className="bar-row" key={`${row.accountId}-${row.name}`}>
                  <div className="bar-label">{row.name}</div>
                  <div className="bar-track">
                    <div className="bar-fill rust" style={{ width: `${Math.round((row.amountCents / max) * 100)}%` }} />
                  </div>
                  <div className="bar-val num">{money(row.amountCents)}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Recent activity</h3>
            <span className="hint">latest income and spending</span>
          </div>
          <table>
            <tbody>
              {data.recent.length === 0 ? (
                <tr>
                  <td>
                    <Empty>Nothing recorded yet.</Empty>
                  </td>
                </tr>
              ) : (
                data.recent.map((row, index) => (
                  <tr key={`${row.kind}-${row.date}-${index}`}>
                    <td className="num date-cell">{row.date}</td>
                    <td>{row.description || row.party || "—"}</td>
                    <td style={{ width: 110 }}>
                      <span className={`pill ${row.kind === "income" ? "pill-paid" : "pill-unpaid"}`}>
                        {row.kind === "income" ? "Income" : "Expense"}
                      </span>
                    </td>
                    <td className={`num ${row.kind === "income" ? "money-pos" : "money-neg"}`} style={{ width: 120 }}>
                      {money(row.amountCents)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="card card-pad stamp-card">
          <div className="stamp">
            <div className="top">Net position</div>
            <div className="amt">{money(data.netCents)}</div>
            <div className="bot">{data.netCents >= 0 ? "In the black" : "In the red"}</div>
          </div>
        </div>

        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="panel-title">Cash on hand</div>
          <div className={`money-big ${data.cashCents >= 0 ? "" : "money-neg"}`}>{money(data.cashCents)}</div>
          <div className="muted small">From records marked paid</div>

          <div className="divider" />
          <div className="kv">
            <span>Owed to you</span>
            <strong className="num">{money(data.unpaidIncomeCents + data.invoiceOutstandingCents)}</strong>
          </div>
          <div className="kv">
            <span>You owe</span>
            <strong className="num">{money(data.unpaidExpenseCents)}</strong>
          </div>
          <div className="kv">
            <span>Sales tax collected</span>
            <strong className="num">{money(data.salesTaxDueCents)}</strong>
          </div>
          <div className="kv">
            <span>Stock on hand</span>
            <strong className="num">{money(data.inventoryValueCents)}</strong>
          </div>
        </div>

        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="panel-title">Quick add</div>
          <div className="stack">
            <button type="button" className="btn btn-primary" onClick={() => go("income")}>
              + Money in
            </button>
            <button type="button" className="btn" onClick={() => go("expenses")}>
              + Money out
            </button>
            <button type="button" className="btn" onClick={() => go("invoices")}>
              + Send an invoice
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
