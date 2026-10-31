import { useState } from "react";
import { api } from "../api";
import { errorText, today } from "../format";
import type { CreditMemo, CreditOutcome, CreditStatus, Invoice } from "../types";
import { Empty, ErrorNote, Modal, Pill, money, qtyInput, toHundredths, useLoad } from "../ui";

interface Props {
  revision: number;
  changed: (message?: string) => void;
}

const REASONS = [
  "Damaged goods",
  "Wrong item shipped",
  "Returned goods",
  "Pricing error",
  "Duplicate charge",
  "Service not delivered",
  "Customer goodwill",
];

const OUTCOMES: Array<{ id: CreditOutcome; title: string; blurb: string; note: string }> = [
  {
    id: "Apply",
    title: "Apply to outstanding balance",
    blurb: "Reduce what the customer currently owes.",
    note: "Nothing moves in the bank. The invoice's balance simply drops.",
  },
  {
    id: "Refund",
    title: "Refund customer",
    blurb: "Record a refund to the original payment method.",
    note: "Money leaves the bank and the customer's balance is untouched.",
  },
  {
    id: "Credit",
    title: "Keep as customer credit",
    blurb: "The customer can use the remaining credit toward a future invoice.",
    note: "Sits in Customer Credits, a liability, until it is applied.",
  },
];

function statusTone(status: CreditStatus): "paid" | "unpaid" | "draft" {
  return status === "Posted" ? "unpaid" : "draft";
}

function outcomeLabel(outcome: CreditOutcome): string {
  return outcome === "Apply" ? "Applied" : outcome === "Refund" ? "Refunded" : "Held as credit";
}

/* ------------------------------------------------------------------ */
/* Screen                                                             */
/* ------------------------------------------------------------------ */

export function CreditMemosScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listCreditMemos(), [revision]);
  const invoices = useLoad(() => api.listInvoices(), [revision]).data ?? [];
  const [composing, setComposing] = useState<{ invoice: Invoice; memo?: CreditMemo } | null>(null);
  const [picking, setPicking] = useState(false);

  const memos = data ?? [];
  const creditable = invoices.filter((invoice) => invoice.status !== "Draft" && invoice.totalCents > invoice.creditedCents);

  async function post(memo: CreditMemo) {
    if (
      memo.outcome === "Refund" &&
      !window.confirm(`Post ${memo.memoNo}? This takes ${money(memo.totalCents)} out of the bank.`)
    ) {
      return;
    }
    try {
      const saved = await api.saveCreditMemo({
        id: memo.id,
        invoiceId: memo.invoiceId,
        memoNo: memo.memoNo,
        memoDate: memo.memoDate,
        reason: memo.reason,
        status: "Posted",
        outcome: memo.outcome,
        taxBp: memo.taxBp,
        lines: memo.lines.map((line) => ({
          invoiceLineId: line.invoiceLineId,
          description: line.description,
          qtyHundredths: line.qtyHundredths,
          unitPriceCents: line.unitPriceCents,
          inventoryItemId: line.inventoryItemId,
        })),
      });
      changed(`${saved.memoNo} posted — ${money(saved.totalCents)} ${outcomeLabel(saved.outcome).toLowerCase()}`);
    } catch (err) {
      window.alert(errorText(err));
    }
  }

  async function remove(memo: CreditMemo) {
    if (!window.confirm(`Delete draft ${memo.memoNo}? Nothing has been posted for it.`)) return;
    try {
      await api.deleteCreditMemo(memo.id);
      changed("Draft credit memo deleted");
    } catch (err) {
      window.alert(errorText(err));
    }
  }

  async function voidMemo(memo: CreditMemo) {
    if (!window.confirm(`Void ${memo.memoNo}? A reversing entry is posted and the file keeps the history.`)) return;
    try {
      await api.voidCreditMemo(memo.id);
      changed(`${memo.memoNo} voided`);
    } catch (err) {
      window.alert(errorText(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          A credit memo always belongs to an invoice. Saved as a draft it costs nothing; posted it reduces the invoice, and
          the money goes exactly one of three ways.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setPicking(true)} disabled={creditable.length === 0}>
          + New credit memo
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Memo #</th>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Reason</th>
              <th>Status</th>
              <th>What happened</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {memos.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <Empty>
                    No credit memos yet.
                    <div className="cta">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => setPicking(true)}
                        disabled={creditable.length === 0}
                      >
                        + Credit something back
                      </button>
                    </div>
                    <div className="muted small" style={{ marginTop: 8 }}>
                      Invoices need to be sent before they can be credited.
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              memos.map((memo) => (
                <tr key={memo.id} className={memo.status === "Void" ? "muted" : undefined}>
                  <td className="strong">{memo.memoNo}</td>
                  <td className="mono">{memo.invoiceNo}</td>
                  <td>{memo.customerName || "—"}</td>
                  <td className="muted">{memo.memoDate}</td>
                  <td>{memo.reason}</td>
                  <td>
                    <Pill tone={statusTone(memo.status)}>{memo.status}</Pill>
                  </td>
                  <td className="muted">
                    {memo.status === "Draft"
                      ? "—"
                      : memo.status === "Void"
                        ? "Voided — nothing counted"
                        : outcomeLabel(memo.outcome)}
                  </td>
                  <td className="num">{money(memo.totalCents)}</td>
                  <td>
                    <div className="row-actions">
                      {memo.status === "Draft" && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                              const invoice = invoices.find((candidate) => candidate.id === memo.invoiceId);
                              if (invoice) setComposing({ invoice, memo });
                            }}
                          >
                            Edit
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void post(memo)}>
                            Post
                          </button>
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(memo)}>
                            Delete
                          </button>
                        </>
                      )}
                      {memo.status === "Posted" && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                              const invoice = invoices.find((candidate) => candidate.id === memo.invoiceId);
                              if (invoice) setComposing({ invoice, memo });
                            }}
                          >
                            Review
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void voidMemo(memo)}>
                            Void
                          </button>
                        </>
                      )}
                      {memo.status === "Void" && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => {
                            const invoice = invoices.find((candidate) => candidate.id === memo.invoiceId);
                            if (invoice) setComposing({ invoice, memo });
                          }}
                        >
                          Review
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {picking && (
        <Modal title="Which invoice is this credit for?" onClose={() => setPicking(false)}>
          <div className="modal-body">
            <p className="muted small">
              Only invoices that have been sent can be credited. The invoice and customer carry over automatically.
            </p>
            {creditable.length === 0 ? (
              <Empty>Every invoice is either a draft or has already been fully credited.</Empty>
            ) : (
              <div className="pick-list">
                {creditable.map((invoice) => (
                  <button
                    type="button"
                    key={invoice.id}
                    className="pick-row"
                    onClick={() => {
                      setPicking(false);
                      setComposing({ invoice });
                    }}
                  >
                    <span>
                      <span className="strong mono">{invoice.invoiceNo}</span>
                      <span className="muted"> · {invoice.customerName || "no customer"}</span>
                    </span>
                    <span className="num">
                      {money(invoice.totalCents - invoice.creditedCents)} left
                      {invoice.creditedCents > 0 && (
                        <span className="muted small"> of {money(invoice.totalCents)}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setPicking(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {composing && (
        <CreditMemoComposer
          invoice={composing.invoice}
          memo={composing.memo}
          memos={memos}
          onClose={() => setComposing(null)}
          onSaved={(message) => changed(message)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The composer                                                       */
/* ------------------------------------------------------------------ */

interface DraftCreditLine {
  key: number;
  invoiceLineId: number;
  description: string;
  originalQty: number;
  price: number;
  alreadyCredited: number;
  qty: string;
}

export function CreditMemoComposer({
  invoice,
  memo,
  memos,
  onClose,
  onSaved,
}: {
  invoice: Invoice;
  memo?: CreditMemo;
  memos: CreditMemo[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const frozen = memo ? memo.status !== "Draft" : false;
  const [date, setDate] = useState(memo?.memoDate ?? today());
  const [reason, setReason] = useState(memo?.reason ?? "");
  const [outcome, setOutcome] = useState<CreditOutcome>(memo?.outcome ?? "Apply");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [lines, setLines] = useState<DraftCreditLine[]>(() =>
    invoice.lines.map((line, index) => {
      const usedByOthers = memos
        .filter((candidate) => candidate.status !== "Void" && candidate.id !== memo?.id)
        .flatMap((candidate) => candidate.lines)
        .filter((candidate) => candidate.invoiceLineId === line.id)
        .reduce((sum, candidate) => sum + candidate.qtyHundredths, 0);
      const mine = memo?.lines.find((candidate) => candidate.invoiceLineId === line.id);
      return {
        key: index,
        invoiceLineId: line.id,
        description: line.description,
        originalQty: line.qtyHundredths,
        price: line.unitPriceCents,
        alreadyCredited: usedByOthers,
        qty: mine ? qtyInput(mine.qtyHundredths) : "",
      };
    }),
  );

  const amountOf = (line: DraftCreditLine) => Math.round((toHundredths(line.qty) * line.price) / 100);
  const subtotal = lines.reduce((sum, line) => sum + amountOf(line), 0);
  const tax = Math.round((subtotal * invoice.taxBp) / 10_000);
  const total = subtotal + tax;
  const picked = lines.filter((line) => toHundredths(line.qty) > 0);
  const remainingOnInvoice = invoice.totalCents - invoice.creditedCents;

  function updateQty(key: number, value: string) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, qty: value } : line)));
  }

  async function save(status: CreditStatus) {
    setError(null);
    if (!reason.trim()) {
      setError("Choose a reason for the credit — it is what shows on the customer's statement and in the history.");
      return;
    }
    if (picked.length === 0) {
      setError("Enter a credit quantity on at least one line.");
      return;
    }
    const over = lines.find(
      (line) => toHundredths(line.qty) > line.originalQty - line.alreadyCredited,
    );
    if (over) {
      setError(`Invoice ${invoice.invoiceNo} only has ${qtyInput(over.originalQty - over.alreadyCredited)} of "${over.description}" left to credit.`);
      return;
    }
    if (status === "Posted" && outcome === "Refund" && !window.confirm(`Post this credit and refund ${money(total)}? Money will leave the bank.`)) {
      return;
    }
    setBusy(true);
    try {
      const saved = await api.saveCreditMemo({
        id: memo?.id ?? null,
        invoiceId: invoice.id,
        memoNo: memo?.memoNo ?? null,
        memoDate: date,
        reason: reason.trim(),
        status,
        outcome,
        taxBp: invoice.taxBp,
        lines: picked.map((line) => ({
          invoiceLineId: line.invoiceLineId,
          description: line.description,
          qtyHundredths: toHundredths(line.qty),
          unitPriceCents: line.price,
          inventoryItemId: null,
        })),
      });
      onSaved(
        status === "Posted"
          ? `${saved.memoNo} posted — ${money(saved.totalCents)} ${outcomeLabel(saved.outcome).toLowerCase()}`
          : `${saved.memoNo} saved as a draft`,
      );
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function voidMemo() {
    if (!memo) return;
    if (!window.confirm(`Void ${memo.memoNo}? A reversing entry is posted and the history is kept.`)) return;
    setBusy(true);
    try {
      await api.voidCreditMemo(memo.id);
      onSaved(`${memo.memoNo} voided`);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const title = memo ? `Credit memo ${memo.memoNo}` : "New credit memo";

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="modal-body">
        <div className="credit-head">
          <div>
            <div className="muted small">Based on invoice</div>
            <div className="strong mono">{invoice.invoiceNo}</div>
            <div className="muted small">{invoice.customerName || "No customer on the invoice"}</div>
          </div>
          <div className="credit-head-side">
            <Pill tone={statusTone(memo?.status ?? "Draft")}>{memo?.status ?? "Draft"}</Pill>
            <label className="field inline-field">
              <span>Credit date</span>
              <input type="date" value={date} disabled={frozen} onChange={(event) => setDate(event.target.value)} />
            </label>
          </div>
        </div>

        {error && <ErrorNote text={error} />}

        <div className="panel-title" style={{ marginTop: 8 }}>
          Select what you're crediting
        </div>
        <div className="credit-lines">
          {lines.map((line) => {
            const left = line.originalQty - line.alreadyCredited;
            const over = toHundredths(line.qty) > left;
            return (
              <div className={over ? "credit-line over" : "credit-line"} key={line.key}>
                <div className="credit-line-what">
                  <div className="strong">{line.description || "Line"}</div>
                  <div className="muted small">
                    Original: {qtyInput(line.originalQty)} × {money(line.price)}
                    {line.alreadyCredited > 0 && <> · {qtyInput(line.alreadyCredited)} already credited</>}
                    {" · "}
                    {qtyInput(left)} left
                  </div>
                </div>
                <label className="field inline-field">
                  <span>Credit qty.</span>
                  <input
                    value={line.qty}
                    disabled={frozen || left <= 0}
                    placeholder={left <= 0 ? "None left" : "0"}
                    onChange={(event) => updateQty(line.key, event.target.value)}
                  />
                </label>
                <div className="credit-line-amount num">{money(amountOf(line))}</div>
              </div>
            );
          })}
        </div>

        <div className="field-row">
          <div className="field">
            <label>Reason for credit</label>
            <select value={reason} disabled={frozen} onChange={(event) => setReason(event.target.value)}>
              <option value="">Select a reason…</option>
              {REASONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Credit amount</label>
            <div className="credit-total">
              <strong>{money(total)}</strong>
              <span className="muted small">
                {tax > 0 ? `includes ${money(tax)} sales tax` : "no sales tax"} · invoice has {money(remainingOnInvoice)} left
              </span>
            </div>
          </div>
        </div>

        <div className="panel-title" style={{ marginTop: 12 }}>
          What happens to this credit?
        </div>
        <div className="outcome-grid">
          {OUTCOMES.map((option) => (
            <button
              type="button"
              key={option.id}
              className={outcome === option.id ? "outcome-card selected" : "outcome-card"}
              onClick={() => !frozen && setOutcome(option.id)}
              disabled={frozen}
            >
              <span className="outcome-radio" aria-hidden="true" />
              <span>
                <span className="outcome-title">{option.title}</span>
                <span className="outcome-blurb">{option.blurb}</span>
                <span className="outcome-note">{option.note}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="settings-note">
          These are three different financial events and they are never combined: applying keeps the money with the
          business, refunding sends it back, and keeping it leaves the customer a credit to spend later.
        </div>

        {memo && memo.status !== "Draft" && (
          <div className="settings-note">
            Posted memos are fixed. {memo.stockReturned && "The stock it returned has been put back on the shelf. "}
            A correction is a void plus a new memo, so the history and the ledger agree.
          </div>
        )}
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
        {memo && memo.status === "Posted" && (
          <button type="button" className="btn btn-danger" onClick={() => void voidMemo()} disabled={busy}>
            Void this credit
          </button>
        )}
        {!frozen && (
          <>
            <button type="button" className="btn" onClick={() => void save("Draft")} disabled={busy}>
              Save draft
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save("Posted")} disabled={busy}>
              Post credit memo
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

