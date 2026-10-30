import { useState } from "react";
import { api } from "../api";
import type { InventoryItem, PayrollRun } from "../types";
import { Empty, ErrorNote, Modal, centsInput, field, money, qtyInput, submitHandler, toCents, toHundredths, useLoad } from "../ui";
import { today } from "../format";

interface Props {
  revision: number;
  changed: (message?: string) => void;
}

export function InventoryScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listInventory(), [revision]);
  const [editing, setEditing] = useState<InventoryItem | "new" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function remove(item: InventoryItem) {
    if (!window.confirm(`Delete ${item.name}?`)) return;
    try {
      await api.deleteInventoryItem(item.id);
      changed("Item deleted");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          Stock is tracked here, but you never have to visit this screen to keep the books right — purchases and invoices do it.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          + Add item
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>SKU</th>
              <th>Kind</th>
              <th className="num">On hand</th>
              <th className="num">Cost</th>
              <th className="num">Sell</th>
              <th className="num">Stock value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Empty>
                    No items yet.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
                        + Add your first item
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((item) => (
                <tr key={item.id}>
                  <td className="strong">{item.name}</td>
                  <td className="muted">{item.sku || "—"}</td>
                  <td>
                    <span className="pill pill-draft">{item.kind}</span>
                  </td>
                  <td className={`num ${item.kind !== "Service" && item.qtyHundredths <= 0 ? "money-neg" : ""}`}>
                    {item.kind === "Service" ? "—" : qtyInput(item.qtyHundredths)}
                  </td>
                  <td className="num">{money(item.unitCostCents)}</td>
                  <td className="num">{money(item.salePriceCents)}</td>
                  <td className="num">{money(item.stockValueCents)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(item)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(item)}>
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
        <Modal title={editing === "new" ? "Add item" : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.saveInventoryItem({
                  id: editing === "new" ? null : editing.id,
                  name: field(form, "name"),
                  sku: field(form, "sku"),
                  barcode: field(form, "barcode"),
                  category: field(form, "category"),
                  kind: field(form, "kind") as InventoryItem["kind"],
                  qtyHundredths: toHundredths(field(form, "qty")),
                  unitCostCents: toCents(form.get("cost")),
                  salePriceCents: toCents(form.get("price")),
                });
                changed("Item saved");
              },
              setFormError,
              () => setEditing(null),
            )}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              <div className="field">
                <label>Name</label>
                <input name="name" required defaultValue={editing === "new" ? "" : editing.name} />
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>SKU</label>
                  <input name="sku" defaultValue={editing === "new" ? "" : editing.sku} />
                </div>
                <div className="field">
                  <label>Barcode</label>
                  <input name="barcode" defaultValue={editing === "new" ? "" : editing.barcode} />
                </div>
                <div className="field">
                  <label>Kind</label>
                  <select name="kind" defaultValue={editing === "new" ? "Product" : editing.kind}>
                    <option value="Product">Product — stock counted</option>
                    <option value="Consumable">Consumable</option>
                    <option value="Service">Service — nothing to count</option>
                  </select>
                </div>
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>Quantity on hand</label>
                  <input name="qty" defaultValue={editing === "new" ? "0" : qtyInput(editing.qtyHundredths)} />
                </div>
                <div className="field">
                  <label>Cost each</label>
                  <input name="cost" defaultValue={editing === "new" ? "0" : centsInput(editing.unitCostCents)} />
                </div>
                <div className="field">
                  <label>Sell for</label>
                  <input name="price" defaultValue={editing === "new" ? "0" : centsInput(editing.salePriceCents)} />
                </div>
              </div>
              <div className="field">
                <label>Category</label>
                <input name="category" defaultValue={editing === "new" ? "" : editing.category} />
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

const DEFAULTS = { federal: "12", state: "4", social: "6.2", medicare: "1.45" };

export function PayrollScreen({ revision, changed }: Props) {
  const { data, error } = useLoad(() => api.listPayroll(), [revision]);
  const [editing, setEditing] = useState<PayrollRun | "new" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [rate, setRate] = useState("");
  const [regular, setRegular] = useState("80");
  const [overtime, setOvertime] = useState("0");
  const [pcts, setPcts] = useState(DEFAULTS);
  const [other, setOther] = useState("0");

  function open(record: PayrollRun | "new") {
    setEditing(record);
    setFormError(null);
    if (record === "new") {
      setRate("");
      setRegular("80");
      setOvertime("0");
      setPcts(DEFAULTS);
      setOther("0");
    } else {
      setRate(centsInput(record.payRateCents));
      setRegular((record.regularHoursHundredths / 100).toFixed(2));
      setOvertime((record.overtimeHoursHundredths / 100).toFixed(2));
      const gross = record.grossCents || 1;
      setPcts({
        federal: ((record.federalCents / gross) * 100).toFixed(2),
        state: ((record.stateCents / gross) * 100).toFixed(2),
        social: ((record.socialSecurityCents / gross) * 100).toFixed(2),
        medicare: ((record.medicareCents / gross) * 100).toFixed(2),
      });
      setOther(centsInput(record.otherDeductionsCents));
    }
  }

  const rateCents = toCents(rate);
  const gross = Math.round((Number(regular || "0") * rateCents)) + Math.round(Number(overtime || "0") * rateCents * 1.5);
  const deductionCents = (key: keyof typeof DEFAULTS) => Math.round((gross * (Number(pcts[key]) || 0)) / 100);
  const otherCents = toCents(other);
  const totalDeductions = deductionCents("federal") + deductionCents("state") + deductionCents("social") + deductionCents("medicare") + otherCents;
  const net = gross - totalDeductions;

  async function remove(run: PayrollRun) {
    if (!window.confirm(`Delete the pay run for ${run.employee}?`)) return;
    try {
      await api.deletePayroll(run.id);
      changed("Pay run deleted");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          Pay runs split gross pay between the bank and what you owe the tax authorities, and record the wage expense.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => open("new")}>
          + Add pay run
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Employee</th>
              <th className="num">Rate</th>
              <th className="num">Hours</th>
              <th className="num">Gross</th>
              <th className="num">Deductions</th>
              <th className="num">Net pay</th>
              <th>Check #</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <Empty>No pay runs recorded yet.</Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((run) => (
                <tr key={run.id}>
                  <td className="muted">{run.payDate}</td>
                  <td className="strong">{run.employee}</td>
                  <td className="num">{money(run.payRateCents)}</td>
                  <td className="num">
                    {(run.regularHoursHundredths / 100).toFixed(1)}
                    {run.overtimeHoursHundredths > 0 ? ` + ${(run.overtimeHoursHundredths / 100).toFixed(1)} OT` : ""}
                  </td>
                  <td className="num">{money(run.grossCents)}</td>
                  <td className="num muted">{money(run.totalDeductionsCents)}</td>
                  <td className="num strong">{money(run.netCents)}</td>
                  <td className="muted">{run.checkNumber || "—"}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => open(run)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(run)}>
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
        <Modal title={editing === "new" ? "Add pay run" : "Edit pay run"} onClose={() => setEditing(null)}>
          <form
            onSubmit={submitHandler(
              async (form) => {
                await api.savePayroll({
                  id: editing === "new" ? null : editing.id,
                  employee: field(form, "employee"),
                  payDate: field(form, "payDate") || today(),
                  checkNumber: field(form, "checkNumber"),
                  payRateCents: rateCents,
                  regularHoursHundredths: toHundredths(regular),
                  overtimeHoursHundredths: toHundredths(overtime),
                  federalCents: deductionCents("federal"),
                  stateCents: deductionCents("state"),
                  socialSecurityCents: deductionCents("social"),
                  medicareCents: deductionCents("medicare"),
                  otherDeductionsCents: otherCents,
                });
                changed("Pay run saved");
              },
              setFormError,
              () => setEditing(null),
            )}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              <div className="field-row">
                <div className="field">
                  <label>Employee</label>
                  <input name="employee" required defaultValue={editing === "new" ? "" : editing.employee} />
                </div>
                <div className="field">
                  <label>Pay date</label>
                  <input type="date" name="payDate" defaultValue={editing === "new" ? today() : editing.payDate} />
                </div>
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>Rate per hour</label>
                  <input value={rate} onChange={(event) => setRate(event.target.value)} inputMode="decimal" />
                </div>
                <div className="field">
                  <label>Regular hours</label>
                  <input value={regular} onChange={(event) => setRegular(event.target.value)} />
                </div>
                <div className="field">
                  <label>Overtime hours (1.5×)</label>
                  <input value={overtime} onChange={(event) => setOvertime(event.target.value)} />
                </div>
              </div>
              <div className="muted small" style={{ marginBottom: 10 }}>
                Gross pay <strong className="num">{money(gross)}</strong>
              </div>

              <label>Deductions, % of gross</label>
              <div className="field-row3">
                {(["federal", "state", "social", "medicare"] as const).map((key) => (
                  <div className="field" key={key}>
                    <label className="muted">
                      {key === "federal" ? "Federal tax" : key === "state" ? "State tax" : key === "social" ? "Social Security" : "Medicare"}
                    </label>
                    <input
                      value={pcts[key]}
                      onChange={(event) => setPcts((current) => ({ ...current, [key]: event.target.value }))}
                      inputMode="decimal"
                    />
                    <div className="hint-inline num">{money(deductionCents(key))}</div>
                  </div>
                ))}
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Other deductions</label>
                  <input value={other} onChange={(event) => setOther(event.target.value)} inputMode="decimal" />
                </div>
                <div className="field">
                  <label>Check #</label>
                  <input name="checkNumber" defaultValue={editing === "new" ? "" : editing.checkNumber} />
                </div>
              </div>
              <div className="kv total">
                <span>Net pay</span>
                <strong className="num">{money(net)}</strong>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save pay run
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
