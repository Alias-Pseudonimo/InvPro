import { useEffect, useState } from "react";
import { api } from "../api";
import { payFrequencyLabel, salaryPerPeriod } from "../format";
import type { Employee, EmployeeInput, MaritalStatus, PayFrequency, PayType, Person } from "../types";
import {
  Empty,
  ErrorNote,
  Modal,
  centsInput,
  field,
  money,
  submitHandler,
  toCents,
  useLoad,
} from "../ui";

interface Props {
  revision: number;
  changed: (message?: string) => void;
  /** Open a blank form on arrival, for the pay run that sent us here. */
  startNew?: boolean;
  onStartedNew?: () => void;
  /** Hand the new person back to whoever opened the form. */
  onAdded?: (person: Employee) => void;
}

/**
 * The payroll roster. These are people you pay, not people with a login: the
 * W-2 side says who they are, the W-4 side says how to withhold, and a user
 * link is only there for someone who also logs time and mileage.
 */
export function EmployeesScreen({ revision, changed, startNew = false, onStartedNew, onAdded }: Props) {
  const { data, error } = useLoad(() => api.listEmployees(), [revision]);
  const people = useLoad<Person[]>(() => api.listPeople(), [revision]).data ?? [];
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // The pay basis decides which amount the form asks for, so it is state rather
  // than an uncontrolled field.
  const [payType, setPayType] = useState<PayType>("Hourly");
  const [payFrequency, setPayFrequency] = useState<PayFrequency>("BiWeekly");
  const [salaryDraft, setSalaryDraft] = useState("0.00");

  const employees = data ?? [];
  const active = employees.filter((person) => person.isActive).length;

  function open(record: Employee | "new") {
    setEditing(record);
    setFormError(null);
    setPayType(record === "new" ? "Hourly" : record.payType);
    setPayFrequency(record === "new" ? "BiWeekly" : record.payFrequency);
    setSalaryDraft(record === "new" ? "0.00" : centsInput(record.salaryCents));
  }

  // Arriving from a pay run should land on the form, not on a list the new hire
  // is not on yet.
  useEffect(() => {
    if (!startNew) return;
    open("new");
    onStartedNew?.();
  }, [startNew]);

  async function remove(person: Employee) {
    if (!window.confirm(`Remove ${person.name} from the payroll roster?`)) return;
    try {
      await api.deleteEmployee(person.id);
      changed(`${person.name} removed from payroll`);
    } catch (err) {
      window.alert(String(err));
    }
  }

  function save(form: FormData) {
    if (editing === null) return Promise.resolve();
    // A new employee starts on the roster; the status only exists once someone
    // is being edited, and an absent field must not read as "retired".
    const roster = form.get("active");
    const input: EmployeeInput = {
      id: editing === "new" ? null : editing.id,
      name: field(form, "name"),
      employeeNo: field(form, "employeeNo"),
      jobTitle: field(form, "jobTitle"),
      email: field(form, "email"),
      phone: field(form, "phone"),
      address: field(form, "address"),
      ssn: field(form, "ssn"),
      hireDate: field(form, "hireDate") || null,
      userId: field(form, "userId") ? Number(field(form, "userId")) : null,
      filingStatus: field(form, "filingStatus") as MaritalStatus,
      allowances: Number(field(form, "allowances") || 0),
      extraWithholdingCents: toCents(form.get("extra")),
      payType,
      payFrequency,
      // The amount the other basis uses is not on screen, so keep whatever the
      // record already said instead of wiping it.
      payRateCents: payType === "Hourly" ? toCents(form.get("rate")) : editing !== "new" ? editing.payRateCents : 0,
      salaryCents: payType === "Salary" ? toCents(form.get("salary")) : editing !== "new" ? editing.salaryCents : 0,
      allowanceCents: toCents(form.get("allowance")),
      mileageReimbursement: field(form, "mileage") === "yes",
      isActive: roster === null ? true : String(roster) === "yes",
    };
    return api.saveEmployee(input).then((person) => {
      changed(editing === "new" ? `${person.name} added to payroll` : `${person.name} saved`);
      setEditing(null);
      onAdded?.(person);
    });
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          {active === employees.length
            ? `${employees.length} ${employees.length === 1 ? "person" : "people"} on the payroll roster. None of them needs a login.`
            : `${active} active, ${employees.length - active} retired. Nobody here needs a login.`}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => open("new")}>
          + Add employee
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>W-2 identity</th>
              <th>W-4 withholding</th>
              <th className="num">Pay</th>
              <th className="num">Allowance</th>
              <th>Miles</th>
              <th>Logs time as</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Empty>
                    No employees yet. Add the people you pay — payroll works without giving them an account.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => open("new")}>
                        + Add your first employee
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              employees.map((person) => (
                <tr key={person.id}>
                  <td>
                    <div className="strong">{person.name}</div>
                    <div className="muted small">
                      {[person.employeeNo, person.jobTitle].filter(Boolean).join(" · ") || "—"}
                      {!person.isActive && <span> · retired</span>}
                    </div>
                  </td>
                  <td className="muted small">
                    {person.ssnLast4 ? `SSN ···${person.ssnLast4}` : "no SSN on file"}
                    <div>{person.hireDate ? `Hired ${person.hireDate}` : "no hire date"}</div>
                  </td>
                  <td className="muted small">
                    {person.filingStatus}
                    {person.allowances > 0
                      ? ` · ${person.allowances} allowance${person.allowances === 1 ? "" : "s"}`
                      : ""}
                    {person.extraWithholdingCents > 0
                      ? ` · +${money(person.extraWithholdingCents)} extra`
                      : ""}
                  </td>
                  <td className="num">
                    {person.payType === "Salary"
                      ? `${money(person.salaryCents)}/yr`
                      : person.payRateCents > 0
                        ? `${money(person.payRateCents)}/h`
                        : "—"}
                    <div className="muted small">{payFrequencyLabel(person.payFrequency)}</div>
                  </td>
                  <td className="num muted">{person.allowanceCents > 0 ? money(person.allowanceCents) : "—"}</td>
                  <td className="muted">{person.mileageReimbursement ? "Reimbursed" : "Not paid"}</td>
                  <td className="muted">
                    {person.userId
                      ? people.find((candidate) => candidate.id === person.userId)?.name ?? "a user"
                      : "no login"}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => open(person)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(person)}>
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
        <Modal
          title={editing === "new" ? "Add employee" : `Edit ${editing.name}`}
          onClose={() => setEditing(null)}
          wide
        >
          <form
            onSubmit={submitHandler(save, setFormError, () => undefined)}
            key={editing === "new" ? "new" : editing.id}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}

              <div className="strong" style={{ margin: "2px 0 8px" }}>
                W-4 — how to withhold
              </div>
              <p className="muted small" style={{ marginTop: 0 }}>
                Filing status and allowances come from the employee's W-4. Allowances lower the pay federal tax is
                worked out on; anything in the extra box is withheld on top of the calculated tax.
              </p>
              <div className="field-row3">
                <div className="field">
                  <label>Filing status</label>
                  <select name="filingStatus" defaultValue={editing === "new" ? "Single" : editing.filingStatus}>
                    <option value="Single">Single — higher federal rate</option>
                    <option value="Married">Married — lower federal rate</option>
                  </select>
                </div>
                <div className="field">
                  <label>Withholding allowances</label>
                  <input
                    name="allowances"
                    inputMode="numeric"
                    defaultValue={editing === "new" ? "0" : String(editing.allowances)}
                  />
                </div>
                <div className="field">
                  <label>Extra withholding each pay</label>
                  <input
                    name="extra"
                    inputMode="decimal"
                    defaultValue={editing === "new" ? "0.00" : centsInput(editing.extraWithholdingCents)}
                  />
                </div>
              </div>

              <div className="strong" style={{ margin: "10px 0 8px" }}>
                W-2 — who they are
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>Name</label>
                  <input name="name" required defaultValue={editing === "new" ? "" : editing.name} />
                </div>
                <div className="field">
                  <label>Employee number</label>
                  <input
                    name="employeeNo"
                    defaultValue={editing === "new" ? "" : editing.employeeNo}
                    placeholder="E-004"
                  />
                </div>
                <div className="field">
                  <label>Job title</label>
                  <input
                    name="jobTitle"
                    defaultValue={editing === "new" ? "" : editing.jobTitle}
                    placeholder="Foreman"
                  />
                </div>
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>Social Security number</label>
                  <input
                    name="ssn"
                    inputMode="numeric"
                    autoComplete="off"
                    defaultValue={editing === "new" ? "" : editing.ssn || editing.ssnLast4}
                    placeholder="123-45-4821"
                  />
                  <div className="hint-inline">
                    Nine digits, so the W-2 can be filled in. The list shows the last four.
                  </div>
                </div>
                <div className="field">
                  <label>Hired on</label>
                  <input type="date" name="hireDate" defaultValue={editing === "new" ? "" : editing.hireDate ?? ""} />
                </div>
                <div className="field">
                  <label>Logs time as</label>
                  <select name="userId" defaultValue={editing === "new" ? "" : String(editing.userId ?? "")}>
                    <option value="">No login — payroll only</option>
                    {people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                  <div className="hint-inline">Only needed so their mileage can be reimbursed.</div>
                </div>
              </div>
              <div className="field">
                <label>Address</label>
                <textarea
                  name="address"
                  rows={2}
                  defaultValue={editing === "new" ? "" : editing.address}
                  placeholder={"18 Mill St\nAlameda, CA 94501"}
                />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Email</label>
                  <input name="email" defaultValue={editing === "new" ? "" : editing.email} />
                </div>
                <div className="field">
                  <label>Phone</label>
                  <input name="phone" defaultValue={editing === "new" ? "" : editing.phone} />
                </div>
              </div>

              <div className="strong" style={{ margin: "10px 0 8px" }}>
                Pay and additions
              </div>
              <div className="field-row3">
                <div className="field">
                  <label>Paid by</label>
                  <select
                    name="payType"
                    value={payType}
                    onChange={(event) => setPayType(event.target.value as PayType)}
                  >
                    <option value="Hourly">Hourly — hours times a rate</option>
                    <option value="Salary">Salary — a yearly amount</option>
                  </select>
                </div>
                <div className="field">
                  {payType === "Hourly" ? (
                    <>
                      <label>Rate per hour</label>
                      <input
                        name="rate"
                        inputMode="decimal"
                        defaultValue={editing === "new" ? "0.00" : centsInput(editing.payRateCents)}
                      />
                    </>
                  ) : (
                    <>
                      <label>Annual salary</label>
                      <input
                        name="salary"
                        inputMode="decimal"
                        value={salaryDraft}
                        onChange={(event) => setSalaryDraft(event.target.value)}
                      />
                    </>
                  )}
                </div>
                <div className="field">
                  <label>Paid</label>
                  <select
                    name="frequency"
                    value={payFrequency}
                    onChange={(event) => setPayFrequency(event.target.value as PayFrequency)}
                  >
                    <option value="Weekly">Every week — 52 checks</option>
                    <option value="BiWeekly">Every two weeks — 26 checks</option>
                    <option value="SemiMonthly">Twice a month — 24 checks</option>
                    <option value="Monthly">Once a month — 12 checks</option>
                  </select>
                </div>
              </div>
              {payType === "Salary" && (
                <div className="hint-inline" style={{ marginBottom: 8 }}>
                  {money(toCents(salaryDraft))} a year is{" "}
                  {money(salaryPerPeriod(toCents(salaryDraft), payFrequency))} a check, before tax and deductions.
                </div>
              )}
              <div className="field-row">
                <div className="field">
                  <label>Allowance each pay period</label>
                  <input
                    name="allowance"
                    inputMode="decimal"
                    defaultValue={editing === "new" ? "0.00" : centsInput(editing.allowanceCents)}
                  />
                  <div className="hint-inline">Pre-fills the allowance on a pay run; not taxed.</div>
                </div>
                <div className="field">
                  <label>Pay their mileage?</label>
                  <select name="mileage" defaultValue={editing === "new" || editing.mileageReimbursement ? "yes" : "no"}>
                    <option value="yes">Yes — reimburse unreimbursed miles</option>
                    <option value="no">No — mileage is not a payroll item</option>
                  </select>
                </div>
              </div>
              {editing !== "new" && (
                <div className="field">
                  <label>On the roster</label>
                  <select name="active" defaultValue={editing.isActive ? "yes" : "no"}>
                    <option value="yes">Active — can be paid</option>
                    <option value="no">Retired — keeps their history</option>
                  </select>
                </div>
              )}
              <div className="settings-note">
                Employees do not need an account. Add a user only for someone who signs in to work in these books.
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save employee
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
