import { useState } from "react";
import { api, isDesktop } from "../api";
import { useBusinessProfile } from "../business";
import {
  DocumentTotals,
  LineEditor,
  blankLine,
  lineAmount,
  linesFrom,
  payloadLines,
  type DraftLine,
} from "../components/DocumentLines";
import { estimateDocument, printDocument, salesOrderDocument, saveDocument, type DocumentFile } from "../documents";
import { today } from "../format";
import type {
  Customer,
  Estimate,
  EstimateStatus,
  InventoryItem,
  SalesOrder,
  SalesOrderStatus,
} from "../types";
import { Empty, ErrorNote, Modal, Pill, field, money, submitHandler, useLoad } from "../ui";

interface Props {
  revision: number;
  changed: (message?: string) => void;
}

function statusTone(status: string): "paid" | "unpaid" | "draft" {
  if (status === "Accepted" || status === "Confirmed" || status === "Fulfilled") return "paid";
  if (status === "Draft") return "draft";
  return "unpaid";
}

/** Where this document went, said in one short line. */
function destination(record: { invoiceNo: string | null; orderNo?: string | null }): string {
  if (record.invoiceNo) return `Invoiced as ${record.invoiceNo}`;
  if (record.orderNo) return `Ordered as ${record.orderNo}`;
  return "";
}

function usePaperworkData(revision: number) {
  const customers = useLoad<Customer[]>(() => api.listCustomers(), [revision]).data ?? [];
  const items = useLoad<InventoryItem[]>(() => api.listInventory(), [revision]).data ?? [];
  const company = useLoad(() => api.currentCompany(), [revision]).data ?? null;
  const profile = useBusinessProfile(revision);
  return { customers, items, company, profile };
}

function PaperPreview({
  sheet,
  title,
  onClose,
  changed,
}: {
  sheet: DocumentFile;
  title: string;
  onClose: () => void;
  changed: (message?: string) => void;
}) {
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="modal-body">
        <iframe className="doc-frame" title={title} srcDoc={sheet.html} />
        <div className="settings-note">
          This is exactly what prints. Print opens the system dialog — choose “Microsoft Print to PDF” for a PDF copy,
          or Download to keep the file itself.
        </div>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              const where = await saveDocument(sheet);
              changed(isDesktop ? `Saved to ${where}` : `Downloaded ${where}`);
            } catch (err) {
              window.alert(String(err));
            }
          }}
        >
          Download
        </button>
        <button type="button" className="btn btn-primary" onClick={() => printDocument(sheet.html)}>
          Print
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Estimates                                                          */
/* ------------------------------------------------------------------ */

export function EstimatesScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listEstimates(), [revision]);
  const { customers, items, company, profile } = usePaperworkData(revision);

  const [editing, setEditing] = useState<Estimate | "new" | null>(null);
  const [viewing, setViewing] = useState<Estimate | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [taxPct, setTaxPct] = useState("0");
  const [formError, setFormError] = useState<string | null>(null);

  function open(record: Estimate | "new") {
    setEditing(record);
    setFormError(null);
    if (record === "new") {
      setLines([blankLine()]);
      setTaxPct("0");
    } else {
      setLines(linesFrom(record.lines));
      setTaxPct((record.taxBp / 100).toFixed(2));
    }
  }

  const subtotal = lines.reduce((sum, line) => sum + lineAmount(line), 0);
  const tax = Math.round((subtotal * (Number(taxPct) || 0) * 100) / 10_000);

  const sheet = viewing
    ? estimateDocument(
        viewing,
        company,
        profile,
        customers.find((customer) => customer.id === viewing.customerId),
      )
    : null;

  async function convert(record: Estimate, target: "order" | "invoice") {
    try {
      if (target === "order") {
        const order = await api.convertEstimateToOrder(record.id, today());
        changed(`${record.estimateNo} became sales order ${order.orderNo}`);
      } else {
        const invoice = await api.convertEstimateToInvoice(record.id, today());
        changed(`${record.estimateNo} became invoice ${invoice.invoiceNo} — still a draft until you send it`);
      }
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function remove(record: Estimate) {
    if (!window.confirm(`Delete ${record.estimateNo}?`)) return;
    try {
      await api.deleteEstimate(record.id);
      changed("Estimate deleted");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          A quote is not a bill. Nothing is posted to the books until it becomes an invoice, and once it has, what it
          said is frozen.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => open("new")}>
          + New estimate
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Estimate #</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Valid until</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <Empty>
                    No estimates yet.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => open("new")}>
                        + Quote your first job
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((estimate) => (
                <tr key={estimate.id}>
                  <td className="strong">{estimate.estimateNo}</td>
                  <td>{estimate.customerName || "—"}</td>
                  <td className="muted">{estimate.estimateDate}</td>
                  <td className="muted">{estimate.expiryDate || "—"}</td>
                  <td>
                    <Pill tone={statusTone(estimate.status)}>{estimate.status}</Pill>
                    {destination(estimate) && <div className="muted small">{destination(estimate)}</div>}
                  </td>
                  <td className="num">{money(estimate.totalCents)}</td>
                  <td>
                    <div className="row-actions">
                      {!estimate.convertedInvoiceId && !estimate.convertedOrderId && (
                        <>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void convert(estimate, "order")}>
                            Make order
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void convert(estimate, "invoice")}>
                            Make invoice
                          </button>
                        </>
                      )}
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => open(estimate)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setViewing(estimate)}>
                        Print
                      </button>
                      {!estimate.convertedAt && (
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(estimate)}>
                          Delete
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

      {editing && (
        <Modal
          title={editing === "new" ? "New estimate" : `Edit ${editing.estimateNo}`}
          onClose={() => setEditing(null)}
          wide
        >
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.saveEstimate({
                  id: editing === "new" ? null : editing.id,
                  estimateNo: field(form, "estimateNo") || null,
                  customerId: Number(field(form, "customerId")) || null,
                  estimateDate: field(form, "estimateDate") || today(),
                  expiryDate: field(form, "expiryDate") || null,
                  status: field(form, "status") as EstimateStatus,
                  taxBp: Math.round(Number(taxPct || "0") * 100),
                  notes: field(form, "notes"),
                  lines: payloadLines(lines),
                });
                changed("Estimate saved");
              },
              setFormError,
              () => setEditing(null),
            )}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              {editing !== "new" && editing.convertedAt && (
                <div className="role-banner">
                  <strong>This quote has already been used.</strong> It became{" "}
                  {editing.invoiceNo ?? editing.orderNo ?? "another document"}, so its lines stay exactly as they were.
                  Start a new estimate if the job changed.
                </div>
              )}
              <div className="field-row3">
                <div className="field">
                  <label>Estimate #</label>
                  <input name="estimateNo" defaultValue={editing === "new" ? "" : editing.estimateNo} placeholder="automatic" />
                </div>
                <div className="field">
                  <label>Date</label>
                  <input type="date" name="estimateDate" defaultValue={editing === "new" ? today() : editing.estimateDate} />
                </div>
                <div className="field">
                  <label>Valid until</label>
                  <input type="date" name="expiryDate" defaultValue={editing === "new" ? "" : editing.expiryDate ?? ""} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Customer</label>
                  <select name="customerId" defaultValue={editing === "new" ? "" : editing.customerId ?? ""}>
                    <option value="">— no customer —</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Status</label>
                  <select name="status" defaultValue={editing === "new" ? "Draft" : editing.status}>
                    <option value="Draft">Draft — still working on it</option>
                    <option value="Sent">Sent — with the customer</option>
                    <option value="Accepted">Accepted — they said yes</option>
                    <option value="Declined">Declined — they said no</option>
                    <option value="Expired">Expired — too old to use</option>
                  </select>
                </div>
              </div>

              <label>What you would do</label>
              <LineEditor
                lines={lines}
                setLines={setLines}
                items={items}
                placeholder="What are you quoting for?"
                totals={
                  <DocumentTotals subtotal={subtotal} taxPct={taxPct} setTaxPct={setTaxPct} tax={tax} total={subtotal + tax} />
                }
              />
              <div className="field">
                <label>Note on the quote</label>
                <input name="notes" defaultValue={editing === "new" ? "" : editing.notes} placeholder="Valid for 30 days" />
              </div>
              <div className="settings-note">
                An estimate never touches your books. Making it an order or an invoice copies these lines into the next
                document and freezes this one.
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save estimate
              </button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && sheet && (
        <PaperPreview
          sheet={sheet}
          title={`Estimate ${viewing.estimateNo}`}
          onClose={() => setViewing(null)}
          changed={changed}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sales orders                                                       */
/* ------------------------------------------------------------------ */

export function SalesOrdersScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listSalesOrders(), [revision]);
  const { customers, items, company, profile } = usePaperworkData(revision);

  const [editing, setEditing] = useState<SalesOrder | "new" | null>(null);
  const [viewing, setViewing] = useState<SalesOrder | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [taxPct, setTaxPct] = useState("0");
  const [formError, setFormError] = useState<string | null>(null);

  function open(record: SalesOrder | "new") {
    setEditing(record);
    setFormError(null);
    if (record === "new") {
      setLines([blankLine()]);
      setTaxPct("0");
    } else {
      setLines(linesFrom(record.lines));
      setTaxPct((record.taxBp / 100).toFixed(2));
    }
  }

  const subtotal = lines.reduce((sum, line) => sum + lineAmount(line), 0);
  const tax = Math.round((subtotal * (Number(taxPct) || 0) * 100) / 10_000);

  const sheet = viewing
    ? salesOrderDocument(
        viewing,
        company,
        profile,
        customers.find((customer) => customer.id === viewing.customerId),
      )
    : null;

  async function invoiceIt(record: SalesOrder) {
    try {
      const invoice = await api.convertSalesOrderToInvoice(record.id, today());
      changed(`${record.orderNo} became invoice ${invoice.invoiceNo} — still a draft until you send it`);
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function remove(record: SalesOrder) {
    if (!window.confirm(`Delete ${record.orderNo}?`)) return;
    try {
      await api.deleteSalesOrder(record.id);
      changed("Sales order deleted");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          The order the customer actually placed. It becomes money when you invoice it — until then it only holds the
          promise, not the receivable.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => open("new")}>
          + New sales order
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Order #</th>
              <th>Customer</th>
              <th>Came from</th>
              <th>Date</th>
              <th>Wanted by</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Empty>
                    No sales orders yet. A confirmed quote becomes one with “Make order”, or start one here.
                  </Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((order) => (
                <tr key={order.id}>
                  <td className="strong">{order.orderNo}</td>
                  <td>{order.customerName || "—"}</td>
                  <td className="muted">{order.estimateNo ?? "—"}</td>
                  <td className="muted">{order.orderDate}</td>
                  <td className="muted">{order.requestedDate || "—"}</td>
                  <td>
                    <Pill tone={statusTone(order.status)}>{order.status}</Pill>
                    {order.invoiceNo && <div className="muted small">Invoiced as {order.invoiceNo}</div>}
                  </td>
                  <td className="num">{money(order.totalCents)}</td>
                  <td>
                    <div className="row-actions">
                      {!order.invoiceId && order.status !== "Cancelled" && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void invoiceIt(order)}>
                          Make invoice
                        </button>
                      )}
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => open(order)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setViewing(order)}>
                        Print
                      </button>
                      {!order.invoiceId && (
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(order)}>
                          Delete
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

      {editing && (
        <Modal
          title={editing === "new" ? "New sales order" : `Edit ${editing.orderNo}`}
          onClose={() => setEditing(null)}
          wide
        >
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.saveSalesOrder({
                  id: editing === "new" ? null : editing.id,
                  orderNo: field(form, "orderNo") || null,
                  customerId: Number(field(form, "customerId")) || null,
                  orderDate: field(form, "orderDate") || today(),
                  requestedDate: field(form, "requestedDate") || null,
                  status: field(form, "status") as SalesOrderStatus,
                  taxBp: Math.round(Number(taxPct || "0") * 100),
                  notes: field(form, "notes"),
                  lines: payloadLines(lines),
                });
                changed("Sales order saved");
              },
              setFormError,
              () => setEditing(null),
            )}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              {editing !== "new" && editing.invoiceId && (
                <div className="role-banner">
                  <strong>This order has already been invoiced.</strong> Its lines stay as they were, so the bill and the
                  order always agree. Start a new order if something changed.
                </div>
              )}
              <div className="field-row3">
                <div className="field">
                  <label>Order #</label>
                  <input name="orderNo" defaultValue={editing === "new" ? "" : editing.orderNo} placeholder="automatic" />
                </div>
                <div className="field">
                  <label>Order date</label>
                  <input type="date" name="orderDate" defaultValue={editing === "new" ? today() : editing.orderDate} />
                </div>
                <div className="field">
                  <label>Wanted by</label>
                  <input type="date" name="requestedDate" defaultValue={editing === "new" ? "" : editing.requestedDate ?? ""} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Customer</label>
                  <select name="customerId" defaultValue={editing === "new" ? "" : editing.customerId ?? ""}>
                    <option value="">— no customer —</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Status</label>
                  <select name="status" defaultValue={editing === "new" ? "Draft" : editing.status}>
                    <option value="Draft">Draft — not confirmed yet</option>
                    <option value="Confirmed">Confirmed — the customer ordered it</option>
                    <option value="Fulfilled">Fulfilled — delivered and invoiced</option>
                    <option value="Cancelled">Cancelled — not going ahead</option>
                  </select>
                </div>
              </div>

              <label>What they ordered</label>
              <LineEditor
                lines={lines}
                setLines={setLines}
                items={items}
                placeholder="What did they order?"
                totals={
                  <DocumentTotals subtotal={subtotal} taxPct={taxPct} setTaxPct={setTaxPct} tax={tax} total={subtotal + tax} />
                }
              />
              <div className="field">
                <label>Note</label>
                <input name="notes" defaultValue={editing === "new" ? "" : editing.notes} placeholder="Deliver to the site office" />
              </div>
              <div className="settings-note">
                Confirming an order still posts nothing. “Make invoice” turns it into a draft bill with these exact
                lines; sending that invoice is what moves receivables and stock.
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save order
              </button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && sheet && (
        <PaperPreview
          sheet={sheet}
          title={`Sales order ${viewing.orderNo}`}
          onClose={() => setViewing(null)}
          changed={changed}
        />
      )}
    </>
  );
}
