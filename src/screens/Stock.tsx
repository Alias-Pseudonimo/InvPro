import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { PAY_PERIODS, errorText, payFrequencyLabel, salaryPerPeriod, today } from "../format";
import type {
  Employee,
  InventoryItem,
  MaritalStatus,
  MileageDue,
  PayFrequency,
  PayType,
  PayrollRun,
  User,
} from "../types";
import { Empty, ErrorNote, Modal, centsInput, field, money, qtyInput, submitHandler, toCents, toHundredths, useLoad } from "../ui";
import { EmployeesScreen } from "./Employees";
import { TimeSheet } from "./Time";

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

export function PayrollScreen({ revision, changed, me }: Props & { me: User }) {
  const timeOnly = me.access === "TimeEntry";
  const [view, setView] = useState<"runs" | "employees" | "time">(timeOnly ? "time" : "runs");
  const { data, error } = useLoad<PayrollRun[]>(
    () => (timeOnly ? Promise.resolve([]) : api.listPayroll()),
    [revision, timeOnly],
  );
  const employees = useLoad<Employee[]>(
    () => (timeOnly ? Promise.resolve([]) : api.listEmployees()),
    [revision, timeOnly],
  ).data ?? [];

  const [editing, setEditing] = useState<PayrollRun | "new" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  // Set when the roster form is being opened from the pay-run composer.
  const [rosterNew, setRosterNew] = useState(false);
  const [employee, setEmployee] = useState("");
  const [payDate, setPayDate] = useState(today());
  const [checkNumber, setCheckNumber] = useState("");
  const [payType, setPayType] = useState<PayType>("Hourly");
  const [payFrequency, setPayFrequency] = useState<PayFrequency>("BiWeekly");
  const [salary, setSalary] = useState("0.00");
  const [rate, setRate] = useState("");
  const [regular, setRegular] = useState("80");
  const [overtime, setOvertime] = useState("0");
  const [marital, setMarital] = useState<MaritalStatus>("Single");
  const [allowances, setAllowances] = useState("0");
  const [extra, setExtra] = useState("0.00");
  const [other, setOther] = useState("0.00");
  const [payMileage, setPayMileage] = useState(false);
  const [payAllowance, setPayAllowance] = useState(false);
  const [allowance, setAllowance] = useState("0.00");
  const [mileage, setMileage] = useState<MileageDue | null>(null);
  const [preview, setPreview] = useState<PayrollRun | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);

  function open(record: PayrollRun | "new") {
    setEditing(record);
    setFormError(null);
    if (record === "new") {
      setEmployeeId(null);
      setEmployee("");
      setPayDate(today());
      setCheckNumber("");
      setPayType("Hourly");
      setPayFrequency("BiWeekly");
      setSalary("0.00");
      setRate("");
      setRegular("80");
      setOvertime("0");
      setMarital("Single");
      setAllowances("0");
      setExtra("0.00");
      setOther("0.00");
      setPayMileage(false);
      setPayAllowance(false);
      setAllowance("0.00");
    } else {
      setEmployeeId(record.employeeId);
      setEmployee(record.employee);
      setPayDate(record.payDate);
      setCheckNumber(record.checkNumber);
      setPayType(record.payType);
      setPayFrequency(record.payFrequency);
      setSalary(centsInput(record.salaryCents));
      setRate(centsInput(record.payRateCents));
      setRegular((record.regularHoursHundredths / 100).toFixed(2));
      setOvertime((record.overtimeHoursHundredths / 100).toFixed(2));
      setMarital(record.maritalStatus);
      setAllowances(String(record.allowances));
      setExtra(centsInput(record.extraWithholdingCents));
      setOther(centsInput(record.otherDeductionsCents));
      setPayMileage(record.mileageHundredths > 0);
      setPayAllowance(record.allowanceCents > 0);
      setAllowance(centsInput(record.allowanceCents));
    }
  }

  /** Choosing a person fills in their W-4 and rate, but every figure stays editable. */
  function pickEmployee(value: string) {
    const chosen = employees.find((candidate) => String(candidate.id) === value) ?? null;
    if (chosen) applyEmployee(chosen);
  }

  /** The same, for someone who was just added to the roster. */
  function applyEmployee(chosen: Employee) {
    setEmployeeId(chosen.id);
    setEmployee(chosen.name);
    setPayType(chosen.payType);
    setPayFrequency(chosen.payFrequency);
    setSalary(centsInput(chosen.salaryCents));
    if (chosen.payRateCents > 0) setRate(centsInput(chosen.payRateCents));
    // A salary is a fixed amount, so the hour boxes start empty rather than at
    // the last person's eighty hours.
    if (chosen.payType === "Salary") {
      setRegular("0");
      setOvertime("0");
    }
    setMarital(chosen.filingStatus);
    setAllowances(String(chosen.allowances));
    setExtra(centsInput(chosen.extraWithholdingCents));
    setAllowance(centsInput(chosen.allowanceCents));
    setPayAllowance(chosen.allowanceCents > 0);
    setPayMileage(chosen.mileageReimbursement);
  }

  // How many miles are still outstanding for this person, shown before the
  // toggle is switched on so the number is never a surprise.
  useEffect(() => {
    if (!editing || employeeId === null) {
      setMileage(null);
      return;
    }
    let live = true;
    api
      .mileageDue(employeeId)
      .then((due) => {
        if (live) setMileage(due);
      })
      .catch(() => {
        if (live) setMileage(null);
      });
    return () => {
      live = false;
      setMileage(null);
    };
  }, [editing, employeeId, revision]);

  // The engine computes withholding, so the composer asks it what this pay run
  // would look like instead of keeping a second copy of the tax rules.
  useEffect(() => {
    if (!editing) {
      setPreview(null);
      return;
    }
    const salaried = payType === "Salary";
    if (salaried ? toCents(salary) <= 0 : toCents(rate) <= 0) {
      setPreview(null);
      setPreviewNote(
        salaried
          ? "Enter an annual salary to see the withholding."
          : "Enter an hourly rate to see the withholding.",
      );
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .previewPayroll({
          id: editing === "new" ? null : editing.id,
          employeeId,
          employee,
          payDate,
          checkNumber,
          payType,
          payFrequency,
          salaryCents: toCents(salary),
          payRateCents: toCents(rate),
          regularHoursHundredths: toHundredths(regular),
          overtimeHoursHundredths: toHundredths(overtime),
          maritalStatus: marital,
          allowances: Number(allowances) || 0,
          extraWithholdingCents: toCents(extra),
          otherDeductionsCents: toCents(other),
          payMileage,
          payAllowance,
          allowanceCents: toCents(allowance),
        })
        .then((run) => {
          if (!live) return;
          setPreview(run);
          setPreviewNote(null);
        })
        .catch((err) => {
          if (!live) return;
          setPreview(null);
          setPreviewNote(errorText(err));
        });
    }, 140);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    editing,
    employeeId,
    employee,
    payDate,
    checkNumber,
    payType,
    payFrequency,
    salary,
    rate,
    regular,
    overtime,
    marital,
    allowances,
    extra,
    other,
    payMileage,
    payAllowance,
    allowance,
  ]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    if (employeeId === null) {
      setFormError(
        "Choose who this check is for. Everyone you pay is on the payroll roster, where their W-2 identity and W-4 withholding live.",
      );
      return;
    }
    try {
      await api.savePayroll({
        id: editing === "new" ? null : editing.id,
        employeeId,
        employee,
        payDate,
        checkNumber,
        payType,
        payFrequency,
        salaryCents: toCents(salary),
        payRateCents: toCents(rate),
        regularHoursHundredths: toHundredths(regular),
        overtimeHoursHundredths: toHundredths(overtime),
        maritalStatus: marital,
        allowances: Number(allowances) || 0,
        extraWithholdingCents: toCents(extra),
        otherDeductionsCents: toCents(other),
        payMileage,
        payAllowance,
        allowanceCents: toCents(allowance),
      });
      changed("Pay run saved");
      setEditing(null);
    } catch (err) {
      setFormError(errorText(err));
    }
  }

  async function remove(run: PayrollRun) {
    if (!window.confirm(`Delete the pay run for ${run.employee}?`)) return;
    try {
      await api.deletePayroll(run.id);
      changed("Pay run deleted");
    } catch (err) {
      window.alert(errorText(err));
    }
  }

  if (timeOnly) {
    return <TimeSheet revision={revision} changed={changed} me={me} />;
  }

  const mileageHint = employeeId === null
    ? "Choose an employee to see their unreimbursed miles."
    : mileage === null
      ? "Checking their mileage log…"
      : mileage.milesHundredths > 0
        ? `${qtyInput(mileage.milesHundredths)} mi × ${money(mileage.rateCents)} = ${money(mileage.amountCents)}`
        : mileage.linked
          ? "No unreimbursed miles on their sheet."
          : "Link this employee to a user to reimburse their miles.";

  return (
    <>
      <div className="toolbar">
        <div className="row-actions" role="tablist" aria-label="Payroll sections">
          <button
            type="button"
            role="tab"
            aria-selected={view === "runs"}
            className={`btn btn-sm ${view === "runs" ? "btn-primary" : ""}`}
            onClick={() => setView("runs")}
          >
            Pay runs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "employees"}
            className={`btn btn-sm ${view === "employees" ? "btn-primary" : ""}`}
            onClick={() => setView("employees")}
          >
            Employees
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "time"}
            className={`btn btn-sm ${view === "time" ? "btn-primary" : ""}`}
            onClick={() => setView("time")}
          >
            Time &amp; mileage
          </button>
        </div>
        {view === "runs" && (
          <button type="button" className="btn btn-primary" onClick={() => open("new")}>
            + Add pay run
          </button>
        )}
      </div>

      {view === "employees" ? (
        <EmployeesScreen
          revision={revision}
          changed={changed}
          startNew={rosterNew}
          onStartedNew={() => setRosterNew(false)}
          onAdded={(person) => {
            // Straight back to the check they were writing, with the new hire
            // already on it.
            setView("runs");
            open("new");
            applyEmployee(person);
          }}
        />
      ) : view === "time" ? (
        <TimeSheet revision={revision} changed={changed} me={me} />
      ) : (
        <>
          <div className="muted small" style={{ marginBottom: 12 }}>
            Every check here is written to someone on the payroll roster — their name, Social Security number and
            W-4 withholding are collected once on the Employees tab, and each pay run picks them up. Gross pay splits
            between the bank and what you owe the tax authorities. Hourly pay is hours at a rate; a salary is a yearly
            amount split into the employee's own pay frequency; the engine works the federal tax out from marital
            status and allowances when you save. Additions — reimbursed miles and an allowance — ride on top without
            being taxed.
          </div>

          {error && <ErrorNote text={error} />}

          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Employee</th>
                  <th>Tax basis</th>
                  <th>Pay basis</th>
                  <th className="num">Gross</th>
                  <th className="num">Additions</th>
                  <th className="num">Deductions</th>
                  <th className="num">Paid</th>
                  <th>Check #</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={10}>
                      <Empty>No pay runs recorded yet.</Empty>
                    </td>
                  </tr>
                ) : (
                  (data ?? []).map((run) => (
                    <tr key={run.id}>
                      <td className="muted">{run.payDate}</td>
                      <td className="strong">{run.employee}</td>
                      <td className="muted">
                        {run.maritalStatus}
                        {run.allowances > 0
                          ? ` · ${run.allowances} allowance${run.allowances === 1 ? "" : "s"}`
                          : ""}
                        {run.extraWithholdingCents > 0 ? ` · +${money(run.extraWithholdingCents)}` : ""}
                      </td>
                      <td className="muted">
                        {run.payType === "Salary"
                          ? `Salary · ${payFrequencyLabel(run.payFrequency)}`
                          : `${(run.regularHoursHundredths / 100).toFixed(1)} h${
                              run.overtimeHoursHundredths > 0
                                ? ` + ${(run.overtimeHoursHundredths / 100).toFixed(1)} OT`
                                : ""
                            }`}
                      </td>
                      <td className="num">{money(run.grossCents)}</td>
                      <td className="num muted">
                        {run.additionsCents > 0 ? money(run.additionsCents) : "—"}
                      </td>
                      <td className="num muted">{money(run.totalDeductionsCents)}</td>
                      <td className="num strong">{money(run.paidCents)}</td>
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
        </>
      )}

      {editing && (
        <Modal title={editing === "new" ? "Add pay run" : "Edit pay run"} onClose={() => setEditing(null)} wide>
          <form onSubmit={save}>
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              <div className="field-row3">
                <div className="field">
                  <label>Employee</label>
                  {employees.length > 0 ? (
                    <select
                      value={employeeId === null ? "" : String(employeeId)}
                      onChange={(event) => pickEmployee(event.target.value)}
                    >
                      <option value="">Choose someone on the roster…</option>
                      {employees
                        .filter((person) => person.isActive || person.id === employeeId)
                        .map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name}
                            {person.jobTitle ? ` · ${person.jobTitle}` : ""}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div className="muted small">Nobody is on the payroll roster yet.</div>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ marginTop: 6 }}
                    onClick={() => {
                      setEditing(null);
                      setRosterNew(true);
                      setView("employees");
                    }}
                  >
                    + Add an employee
                  </button>
                  <div className="hint-inline">
                    {employeeId === null
                      ? "New hire? Their W-2 identity and W-4 withholding are collected once on the roster; the check comes back to you afterwards."
                      : "Their W-4 and pay rate came across from the roster. Change anything here and it only affects this run."}
                  </div>
                </div>
                <div className="field">
                  <label>Pay date</label>
                  <input type="date" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
                </div>
                <div className="field">
                  <label>Check #</label>
                  <input value={checkNumber} onChange={(event) => setCheckNumber(event.target.value)} />
                </div>
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>Paid by</label>
                  <select
                    value={payType}
                    onChange={(event) => {
                      const next = event.target.value as PayType;
                      setPayType(next);
                      if (next === "Salary") {
                        setRegular("0");
                        setOvertime("0");
                      }
                    }}
                  >
                    <option value="Hourly">Hourly — hours times a rate</option>
                    <option value="Salary">Salary — a yearly amount</option>
                  </select>
                </div>
                {payType === "Hourly" ? (
                  <>
                    <div className="field">
                      <label>Rate per hour</label>
                      <input value={rate} onChange={(event) => setRate(event.target.value)} inputMode="decimal" />
                    </div>
                    <div className="field">
                      <label>Regular hours</label>
                      <input value={regular} onChange={(event) => setRegular(event.target.value)} />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="field">
                      <label>Annual salary</label>
                      <input value={salary} onChange={(event) => setSalary(event.target.value)} inputMode="decimal" />
                    </div>
                    <div className="field">
                      <label>Paid</label>
                      <select
                        value={payFrequency}
                        onChange={(event) => setPayFrequency(event.target.value as PayFrequency)}
                      >
                        <option value="Weekly">Every week — 52 checks</option>
                        <option value="BiWeekly">Every two weeks — 26 checks</option>
                        <option value="SemiMonthly">Twice a month — 24 checks</option>
                        <option value="Monthly">Once a month — 12 checks</option>
                      </select>
                    </div>
                  </>
                )}
              </div>
              {payType === "Hourly" ? (
                <div className="field">
                  <label>Overtime hours (1.5×)</label>
                  <input value={overtime} onChange={(event) => setOvertime(event.target.value)} />
                </div>
              ) : (
                <div className="hint-inline" style={{ marginBottom: 8 }}>
                  {money(toCents(salary))} a year ÷ {PAY_PERIODS[payFrequency]} checks ={" "}
                  <strong>{money(salaryPerPeriod(toCents(salary), payFrequency))}</strong> of gross pay this run.
                </div>
              )}

              <div className="field-row3">
                <div className="field">
                  <label>Marital status</label>
                  <select value={marital} onChange={(event) => setMarital(event.target.value as MaritalStatus)}>
                    <option value="Single">Single — higher federal rate</option>
                    <option value="Married">Married — lower federal rate</option>
                  </select>
                </div>
                <div className="field">
                  <label>Withholding allowances</label>
                  <input value={allowances} onChange={(event) => setAllowances(event.target.value)} inputMode="numeric" />
                  <div className="hint-inline">Each allowance lowers the pay federal tax is worked out on.</div>
                </div>
                <div className="field">
                  <label>Extra withholding</label>
                  <input value={extra} onChange={(event) => setExtra(event.target.value)} inputMode="decimal" />
                  <div className="hint-inline">W-4 box 4(c), on top of the calculated federal tax.</div>
                </div>
              </div>
              <div className="field">
                <label>Other deductions</label>
                <input value={other} onChange={(event) => setOther(event.target.value)} inputMode="decimal" />
              </div>

              <div className="panel-title" style={{ marginTop: 4 }}>
                Additions
              </div>
              <p className="muted small" style={{ marginTop: 0 }}>
                Money on the check that is not wages. Nothing here is taxed, and nothing here counts as gross pay.
              </p>
              <div className="field-row">
                <div className="field">
                  <label>Reimburse mileage</label>
                  <select
                    value={payMileage ? "yes" : "no"}
                    onChange={(event) => setPayMileage(event.target.value === "yes")}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                  <div className="hint-inline">{mileageHint}</div>
                </div>
                <div className="field">
                  <label>Pay the allowance</label>
                  <select
                    value={payAllowance ? "yes" : "no"}
                    onChange={(event) => setPayAllowance(event.target.value === "yes")}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                  <input
                    value={allowance}
                    onChange={(event) => setAllowance(event.target.value)}
                    inputMode="decimal"
                    disabled={!payAllowance}
                    aria-label="Allowance amount"
                  />
                </div>
              </div>

              <div className="pay-preview">
                <div className="pay-preview-head">
                  <span>How this pay run splits</span>
                  {previewNote ? <span className="muted small">{previewNote}</span> : null}
                </div>
                {preview ? (
                  <>
                    <div className="kv">
                      <span>Gross pay</span>
                      <strong className="num">{money(preview.grossCents)}</strong>
                    </div>
                    <div className="kv">
                      <span>Federal tax</span>
                      <span className="num">{money(preview.federalCents)}</span>
                    </div>
                    <div className="kv">
                      <span>State tax</span>
                      <span className="num">{money(preview.stateCents)}</span>
                    </div>
                    <div className="kv">
                      <span>Social Security &amp; Medicare</span>
                      <span className="num">
                        {money(preview.socialSecurityCents + preview.medicareCents)}
                      </span>
                    </div>
                    {preview.otherDeductionsCents > 0 && (
                      <div className="kv">
                        <span>Other deductions</span>
                        <span className="num">{money(preview.otherDeductionsCents)}</span>
                      </div>
                    )}
                    {preview.additionsCents > 0 && (
                      <div className="kv">
                        <span>
                          Additions
                          {preview.mileageCents > 0
                            ? ` · ${qtyInput(preview.mileageHundredths)} mi`
                            : ""}
                          {preview.allowanceCents > 0 ? " · allowance" : ""}
                        </span>
                        <span className="num">{money(preview.additionsCents)}</span>
                      </div>
                    )}
                    <div className="kv">
                      <span>Net wages</span>
                      <span className="num">{money(preview.netCents)}</span>
                    </div>
                    <div className="kv total">
                      <span>Check written for</span>
                      <strong className="num">{money(preview.paidCents)}</strong>
                    </div>
                  </>
                ) : (
                  <div className="muted small">The breakdown appears as soon as there is a rate and some hours.</div>
                )}
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
