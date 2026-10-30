import { useState } from "react";
import { api } from "../api";
import type { Customer, ExpenseRecord, IncomeRecord, Vendor } from "../types";
import {
  Empty,
  ErrorNote,
  Modal,
  Pill,
  centsInput,
  field,
  money,
  submitHandler,
  toCents,
  useLoad,
} from "../ui";
import { today } from "../format";

interface Props {
  revision: number;
  changed: (message?: string) => void;
}

const INCOME_CATEGORIES = ["Contract Revenue", "Service Revenue", "Sales Revenue", "Change Order Revenue"];
const EXPENSE_CATEGORIES = ["Materials", "Equipment Rental", "Vehicle & Fuel", "Insurance", "Office & Admin"];

export function IncomeScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listIncome(), [revision]);
  const customers = useLoad<Customer[]>(() => api.listCustomers(), [revision]).data ?? [];
  const [editing, setEditing] = useState<IncomeRecord | "new" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const categories = [...new Set([...INCOME_CATEGORIES, ...(data ?? []).map((record) => record.category)])];

  async function remove(record: IncomeRecord) {
    if (!window.confirm(`Delete this income of ${money(record.totalCents)}? The entry is reversed, not erased from the audit log.`)) return;
    try {
      await api.deleteIncome(record.id);
      changed("Income deleted");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          Money you have earned. Recording it here keeps your books right without you touching a journal.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          + Record income
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Customer</th>
              <th>Category</th>
              <th>Description</th>
              <th>Invoice #</th>
              <th>Status</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Empty>
                    Nothing recorded yet.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
                        + Record your first income
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((record) => (
                <tr key={record.id}>
                  <td className="num date-cell">{record.entryDate}</td>
                  <td>{record.customerName || "—"}</td>
                  <td>{record.category}</td>
                  <td>{record.description || "—"}</td>
                  <td className="muted">{record.invoiceNo || "—"}</td>
                  <td>
                    <Pill tone={record.isPaid ? "paid" : "unpaid"}>{record.isPaid ? "Paid" : "Unpaid"}</Pill>
                  </td>
                  <td className="num money-pos">{money(record.totalCents)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(record)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(record)}>
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
        <Modal title={editing === "new" ? "Record income" : "Edit income"} onClose={() => setEditing(null)}>
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.saveIncome({
                  id: editing === "new" ? null : editing.id,
                  entryDate: field(form, "entryDate") || today(),
                  customerId: Number(field(form, "customerId")) || null,
                  category: field(form, "category") || "Uncategorized",
                  description: field(form, "description"),
                  amountCents: toCents(form.get("amount")),
                  taxBp: Math.round(Number(field(form, "taxPct") || "0") * 100),
                  isPaid: field(form, "status") === "Paid",
                  invoiceNo: field(form, "invoiceNo"),
                });
                changed("Income saved");
              },
              setFormError,
              () => setEditing(null),
            )}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              <div className="field-row">
                <div className="field">
                  <label>Date</label>
                  <input type="date" name="entryDate" defaultValue={editing === "new" ? today() : editing.entryDate} />
                </div>
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
              </div>
              <div className="field">
                <label>Description</label>
                <input
                  name="description"
                  placeholder="What was this for?"
                  defaultValue={editing === "new" ? "" : editing.description}
                />
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>
                    Category <span className="hint-inline">new names become accounts</span>
                  </label>
                  <input list="income-categories" name="category" defaultValue={editing === "new" ? "Contract Revenue" : editing.category} />
                  <datalist id="income-categories">
                    {categories.map((category) => (
                      <option key={category} value={category} />
                    ))}
                  </datalist>
                </div>
                <div className="field">
                  <label>Amount</label>
                  <input name="amount" inputMode="decimal" defaultValue={editing === "new" ? "" : centsInput(editing.amountCents)} />
                </div>
                <div className="field">
                  <label>Sales tax %</label>
                  <input name="taxPct" inputMode="decimal" defaultValue={editing === "new" ? "0" : (editing.taxBp / 100).toFixed(2)} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Invoice #</label>
                  <input name="invoiceNo" defaultValue={editing === "new" ? "" : editing.invoiceNo} />
                </div>
                <div className="field">
                  <label>Status</label>
                  <select name="status" defaultValue={editing === "new" ? "Unpaid" : editing.isPaid ? "Paid" : "Unpaid"}>
                    <option value="Unpaid">Unpaid</option>
                    <option value="Paid">Paid</option>
                  </select>
                </div>
              </div>
              <div className="settings-note">
                Paid income goes straight to your bank account. Unpaid income waits in receivables until it arrives, so your
                cash figure stays honest.
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function ExpensesScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listExpenses(), [revision]);
  const vendors = useLoad<Vendor[]>(() => api.listVendors(), [revision]).data ?? [];
  const [editing, setEditing] = useState<ExpenseRecord | "new" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const categories = [...new Set([...EXPENSE_CATEGORIES, ...(data ?? []).map((record) => record.category)])];

  async function remove(record: ExpenseRecord) {
    if (!window.confirm(`Delete this expense of ${money(record.totalCents)}? The entry is reversed, not erased from the audit log.`)) return;
    try {
      await api.deleteExpense(record.id);
      changed("Expense deleted");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">Everything going out, recorded in your own words.</div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          + Record expense
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Vendor</th>
              <th>Category</th>
              <th>Description</th>
              <th>Status</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <Empty>
                    No expenses recorded yet.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
                        + Record your first expense
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((record) => (
                <tr key={record.id}>
                  <td className="num date-cell">{record.entryDate}</td>
                  <td>{record.vendorName || "—"}</td>
                  <td>{record.category}</td>
                  <td>{record.description || "—"}</td>
                  <td>
                    <Pill tone={record.isPaid ? "paid" : "unpaid"}>{record.isPaid ? "Paid" : "Unpaid"}</Pill>
                  </td>
                  <td className="num money-neg">{money(record.totalCents)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(record)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(record)}>
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
        <Modal title={editing === "new" ? "Record expense" : "Edit expense"} onClose={() => setEditing(null)}>
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.saveExpense({
                  id: editing === "new" ? null : editing.id,
                  entryDate: field(form, "entryDate") || today(),
                  vendorId: Number(field(form, "vendorId")) || null,
                  category: field(form, "category") || "Uncategorized",
                  description: field(form, "description"),
                  amountCents: toCents(form.get("amount")),
                  taxBp: Math.round(Number(field(form, "taxPct") || "0") * 100),
                  isPaid: field(form, "status") === "Paid",
                });
                changed("Expense saved");
              },
              setFormError,
              () => setEditing(null),
            )}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              <div className="field-row">
                <div className="field">
                  <label>Date</label>
                  <input type="date" name="entryDate" defaultValue={editing === "new" ? today() : editing.entryDate} />
                </div>
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
              </div>
              <div className="field">
                <label>Description</label>
                <input name="description" defaultValue={editing === "new" ? "" : editing.description} />
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>Category</label>
                  <input list="expense-categories" name="category" defaultValue={editing === "new" ? "Materials" : editing.category} />
                  <datalist id="expense-categories">
                    {categories.map((category) => (
                      <option key={category} value={category} />
                    ))}
                  </datalist>
                </div>
                <div className="field">
                  <label>Amount</label>
                  <input name="amount" inputMode="decimal" defaultValue={editing === "new" ? "" : centsInput(editing.amountCents)} />
                </div>
                <div className="field">
                  <label>Purchase tax %</label>
                  <input name="taxPct" inputMode="decimal" defaultValue={editing === "new" ? "0" : (editing.taxBp / 100).toFixed(2)} />
                </div>
              </div>
              <div className="field">
                <label>Status</label>
                <select name="status" defaultValue={editing === "new" ? "Unpaid" : editing.isPaid ? "Paid" : "Unpaid"}>
                  <option value="Unpaid">Unpaid — I owe it</option>
                  <option value="Paid">Paid — it has left the bank</option>
                </select>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
