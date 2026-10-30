import { useState } from "react";
import { api } from "../api";
import type { Customer, InventoryItem, Invoice, InvoiceStatus, Purchase, Vendor } from "../types";
import { Empty, ErrorNote, Modal, Pill, centsInput, field, money, qtyInput, submitHandler, toCents, toHundredths, useLoad } from "../ui";
import { today } from "../format";

interface Props {
  revision: number;
  changed: (message?: string) => void;
}

interface DraftLine {
  key: number;
  description: string;
  qty: string;
  price: string;
  itemId: string;
}

let lineKey = 0;
function blankLine(price = ""): DraftLine {
  lineKey += 1;
  return { key: lineKey, description: "", qty: "1", price, itemId: "" };
}

function lineAmount(line: DraftLine): number {
  const qty = Number(line.qty) || 0;
  const price = Number(line.price) || 0;
  return Math.round(qty * price * 100);
}

function statusTone(status: InvoiceStatus): "paid" | "unpaid" | "draft" {
  return status === "Paid" ? "paid" : status === "Draft" ? "draft" : "unpaid";
}

/* ------------------------------------------------------------------ */
/* Invoices                                                           */
/* ------------------------------------------------------------------ */

export function InvoicesScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listInvoices(), [revision]);
  const customers = useLoad<Customer[]>(() => api.listCustomers(), [revision]).data ?? [];
  const items = useLoad<InventoryItem[]>(() => api.listInventory(), [revision]).data ?? [];

  const [editing, setEditing] = useState<Invoice | "new" | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [taxPct, setTaxPct] = useState("0");
  const [formError, setFormError] = useState<string | null>(null);

  function open(record: Invoice | "new") {
    setEditing(record);
    setFormError(null);
    if (record === "new") {
      setLines([blankLine()]);
      setTaxPct("0");
    } else {
      setLines(
        record.lines.map((line) => ({
          key: ++lineKey,
          description: line.description,
          qty: qtyInput(line.qtyHundredths),
          price: centsInput(line.unitPriceCents),
          itemId: line.inventoryItemId ? String(line.inventoryItemId) : "",
        })),
      );
      setTaxPct((record.taxBp / 100).toFixed(2));
    }
  }

  function updateLine(key: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function pickItem(key: number, itemId: string) {
    const item = items.find((candidate) => String(candidate.id) === itemId);
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? {
              ...line,
              itemId,
              description: item && !line.description ? item.name : line.description,
              price: item && item.salePriceCents > 0 ? centsInput(item.salePriceCents) : line.price,
            }
          : line,
      ),
    );
  }

  const subtotal = lines.reduce((sum, line) => sum + lineAmount(line), 0);
  const tax = Math.round((subtotal * (Number(taxPct) || 0) * 100) / 10_000);

  async function setStatus(invoice: Invoice, status: InvoiceStatus) {
    try {
      await api.saveInvoice({
        id: invoice.id,
        invoiceNo: invoice.invoiceNo,
        customerId: invoice.customerId,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        status,
        taxBp: invoice.taxBp,
        lines: invoice.lines.map((line) => ({
          description: line.description,
          qtyHundredths: line.qtyHundredths,
          unitPriceCents: line.unitPriceCents,
          inventoryItemId: line.inventoryItemId,
        })),
      });
      changed(
        status === "Paid"
          ? `${invoice.invoiceNo} marked paid — money is in the bank`
          : status === "Sent"
            ? `${invoice.invoiceNo} sent — stock and receivables updated`
            : `${invoice.invoiceNo} moved back to draft`,
      );
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function remove(invoice: Invoice) {
    if (!window.confirm(`Delete ${invoice.invoiceNo}? Any stock it used is put back.`)) return;
    try {
      await api.deleteInvoice(invoice.id);
      changed("Invoice deleted");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          Drafts cost nothing. Marking an invoice Sent puts it in receivables and takes stock out; Paid moves it to the bank.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => open("new")}>
          + New invoice
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Due</th>
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
                    No invoices yet.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => open("new")}>
                        + Create your first invoice
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((invoice) => (
                <tr key={invoice.id}>
                  <td className="strong">{invoice.invoiceNo}</td>
                  <td>{invoice.customerName || "—"}</td>
                  <td className="muted">{invoice.invoiceDate}</td>
                  <td className="muted">{invoice.dueDate || "—"}</td>
                  <td>
                    <Pill tone={statusTone(invoice.status)}>{invoice.status}</Pill>
                  </td>
                  <td className="num">{money(invoice.totalCents)}</td>
                  <td>
                    <div className="row-actions">
                      {invoice.status === "Draft" && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void setStatus(invoice, "Sent")}>
                          Send
                        </button>
                      )}
                      {invoice.status === "Sent" && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void setStatus(invoice, "Paid")}>
                          Mark paid
                        </button>
                      )}
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => open(invoice)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(invoice)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal title={editing === "new" ? "New invoice" : `Edit ${editing.invoiceNo}`} onClose={() => setEditing(null)} wide>
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.saveInvoice({
                  id: editing === "new" ? null : editing.id,
                  invoiceNo: field(form, "invoiceNo") || null,
                  customerId: Number(field(form, "customerId")) || null,
                  invoiceDate: field(form, "invoiceDate") || today(),
                  dueDate: field(form, "dueDate") || null,
                  status: field(form, "status") as InvoiceStatus,
                  taxBp: Math.round(Number(taxPct || "0") * 100),
                  lines: lines
                    .filter((line) => line.description.trim() || Number(line.price) > 0)
                    .map((line) => ({
                      description: line.description,
                      qtyHundredths: toHundredths(line.qty),
                      unitPriceCents: toCents(line.price),
                      inventoryItemId: Number(line.itemId) || null,
                    })),
                });
                changed("Invoice saved");
              },
              setFormError,
              () => setEditing(null),
            )}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              <div className="field-row3">
                <div className="field">
                  <label>Invoice #</label>
                  <input name="invoiceNo" defaultValue={editing === "new" ? "" : editing.invoiceNo} placeholder="automatic" />
                </div>
                <div className="field">
                  <label>Date</label>
                  <input type="date" name="invoiceDate" defaultValue={editing === "new" ? today() : editing.invoiceDate} />
                </div>
                <div className="field">
                  <label>Due date</label>
                  <input type="date" name="dueDate" defaultValue={editing === "new" ? "" : editing.dueDate ?? ""} />
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
                    <option value="Draft">Draft — not sent</option>
                    <option value="Sent">Sent — owed to you</option>
                    <option value="Paid">Paid — money received</option>
                  </select>
                </div>
              </div>

              <label>Lines</label>
              <div className="line-grid line-head">
                <span>Description</span>
                <span>Stock item</span>
                <span>Qty</span>
                <span>Price</span>
                <span />
              </div>
              {lines.map((line) => (
                <div className="line-grid" key={line.key}>
                  <input
                    placeholder="What are you billing for?"
                    value={line.description}
                    onChange={(event) => updateLine(line.key, { description: event.target.value })}
                  />
                  <select value={line.itemId} onChange={(event) => pickItem(line.key, event.target.value)}>
                    <option value="">— none —</option>
                    {items
                      .filter((item) => item.kind !== "Consumable")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                  <input value={line.qty} onChange={(event) => updateLine(line.key, { qty: event.target.value })} />
                  <input value={line.price} onChange={(event) => updateLine(line.key, { price: event.target.value })} />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setLines((current) => (current.length === 1 ? [blankLine()] : current.filter((row) => row.key !== line.key)))}
                    aria-label="Remove line"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="line-foot">
                <button type="button" className="btn btn-sm" onClick={() => setLines((current) => [...current, blankLine()])}>
                  + Add line
                </button>
                <div className="totals">
                  <div className="kv">
                    <span>Subtotal</span>
                    <strong className="num">{money(subtotal)}</strong>
                  </div>
                  <div className="kv">
                    <span>
                      Tax %
                      <input className="tiny-input" value={taxPct} onChange={(event) => setTaxPct(event.target.value)} />
                    </span>
                    <strong className="num">{money(tax)}</strong>
                  </div>
                  <div className="kv total">
                    <span>Total</span>
                    <strong className="num">{money(subtotal + tax)}</strong>
                  </div>
                </div>
              </div>
              <div className="settings-note">
                Linking a line to a stock item carries the item through: sending the invoice lowers the quantity and books the
                cost of goods sold at the item's cost.
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save invoice
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Purchases                                                          */
/* ------------------------------------------------------------------ */

export function PurchasesScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listPurchases(), [revision]);
  const vendors = useLoad<Vendor[]>(() => api.listVendors(), [revision]).data ?? [];
  const items = useLoad<InventoryItem[]>(() => api.listInventory(), [revision]).data ?? [];

  const [editing, setEditing] = useState<Purchase | "new" | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [formError, setFormError] = useState<string | null>(null);

  function open(record: Purchase | "new") {
    setEditing(record);
    setFormError(null);
    if (record === "new") {
      setLines([blankLine()]);
    } else {
      setLines(
        record.lines.map((line) => ({
          key: ++lineKey,
          description: line.description,
          qty: qtyInput(line.qtyHundredths),
          price: centsInput(line.unitCostCents),
          itemId: line.inventoryItemId ? String(line.inventoryItemId) : "",
        })),
      );
    }
  }

  function updateLine(key: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function pickItem(key: number, itemId: string) {
    const item = items.find((candidate) => String(candidate.id) === itemId);
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? {
              ...line,
              itemId,
              description: item && !line.description ? item.name : line.description,
              price: item && item.unitCostCents > 0 ? centsInput(item.unitCostCents) : line.price,
            }
          : line,
      ),
    );
  }

  const total = lines.reduce((sum, line) => sum + lineAmount(line), 0);

  async function remove(purchase: Purchase) {
    if (!window.confirm(`Delete this purchase of ${money(purchase.totalCents)}? Its stock is taken back out.`)) return;
    try {
      await api.deletePurchase(purchase.id);
      changed("Purchase deleted — stock reversed");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          Buying stock: one record updates quantity, average cost and the books together.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => open("new")}>
          + New purchase
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Vendor</th>
              <th>Items</th>
              <th>Category</th>
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
                    No purchases yet.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => open("new")}>
                        + Record your first purchase
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((purchase) => (
                <tr key={purchase.id}>
                  <td className="muted">{purchase.purchaseDate}</td>
                  <td className="strong">{purchase.vendorName || "—"}</td>
                  <td className="muted">
                    {purchase.lines.length} line{purchase.lines.length === 1 ? "" : "s"}
                  </td>
                  <td>{purchase.category}</td>
                  <td>
                    <Pill tone={purchase.isPaid ? "paid" : "unpaid"}>{purchase.isPaid ? "Paid" : "Unpaid"}</Pill>
                  </td>
                  <td className="num">{money(purchase.totalCents)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => open(purchase)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(purchase)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal title={editing === "new" ? "New purchase" : "Edit purchase"} onClose={() => setEditing(null)} wide>
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.savePurchase({
                  id: editing === "new" ? null : editing.id,
                  purchaseDate: field(form, "purchaseDate") || today(),
                  vendorId: Number(field(form, "vendorId")) || null,
                  category: field(form, "category") || "Materials",
                  note: field(form, "note"),
                  isPaid: field(form, "status") === "Paid",
                  lines: lines
                    .filter((line) => line.description.trim() || Number(line.price) > 0)
                    .map((line) => ({
                      description: line.description,
                      qtyHundredths: toHundredths(line.qty),
                      unitCostCents: toCents(line.price),
                      salePriceCents: 0,
                      inventoryItemId: Number(line.itemId) || null,
                    })),
                });
                changed("Purchase saved");
              },
              setFormError,
              () => setEditing(null),
            )}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              <div className="field-row3">
                <div className="field">
                  <label>Vendor</label>
                  <select name="vendorId" defaultValue={editing === "new" ? "" : editing.vendorId ?? ""}>
                    <option value="">— no vendor —</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Date</label>
                  <input type="date" name="purchaseDate" defaultValue={editing === "new" ? today() : editing.purchaseDate} />
                </div>
                <div className="field">
                  <label>Category</label>
                  <input name="category" defaultValue={editing === "new" ? "Materials" : editing.category} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Note</label>
                  <input name="note" placeholder="Why this purchase, for later" defaultValue={editing === "new" ? "" : editing.note} />
                </div>
                <div className="field">
                  <label>Status</label>
                  <select name="status" defaultValue={editing === "new" ? "Paid" : editing.isPaid ? "Paid" : "Unpaid"}>
                    <option value="Paid">Paid</option>
                    <option value="Unpaid">Unpaid — I owe it</option>
                  </select>
                </div>
              </div>

              <label>Lines</label>
              <div className="line-grid line-head">
                <span>Item or description</span>
                <span>Link to stock</span>
                <span>Qty</span>
                <span>Cost each</span>
                <span />
              </div>
              {lines.map((line) => (
                <div className="line-grid" key={line.key}>
                  <input
                    placeholder="Type a new item name, or pick one"
                    value={line.description}
                    onChange={(event) => updateLine(line.key, { description: event.target.value })}
                  />
                  <select value={line.itemId} onChange={(event) => pickItem(line.key, event.target.value)}>
                    <option value="">— new item —</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <input value={line.qty} onChange={(event) => updateLine(line.key, { qty: event.target.value })} />
                  <input value={line.price} onChange={(event) => updateLine(line.key, { price: event.target.value })} />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setLines((current) => (current.length === 1 ? [blankLine()] : current.filter((row) => row.key !== line.key)))}
                    aria-label="Remove line"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="line-foot">
                <button type="button" className="btn btn-sm" onClick={() => setLines((current) => [...current, blankLine()])}>
                  + Add line
                </button>
                <div className="totals">
                  <div className="kv total">
                    <span>Total</span>
                    <strong className="num">{money(total)}</strong>
                  </div>
                </div>
              </div>
              <div className="settings-note">
                A name that is not in stock yet becomes a new item with this cost. Editing a purchase recalculates the average
                cost from what is on hand, which can shift slightly if later movements exist.
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save purchase
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
