import { useState } from "react";
import { api } from "../api";
import { errorText, today } from "../format";
import type { TimeEntry, TimeEntryInput, TimeKind, User } from "../types";
import { Empty, ErrorNote, Modal, Pill, centsInput, field, money, qtyInput, toCents, toHundredths, useLoad } from "../ui";

interface Props {
  revision: number;
  changed: (message?: string) => void;
  me: User;
}

function quantityLabel(kind: TimeKind, hundredths: number): string {
  return kind === "Time" ? `${qtyInput(hundredths)} h` : `${qtyInput(hundredths)} mi`;
}

function rateLabel(kind: TimeKind, cents: number): string {
  return `${money(cents)} / ${kind === "Time" ? "hour" : "mile"}`;
}

/**
 * The time sheet. It lives inside Payroll because hours and miles are paid work,
 * not a separate part of the business — the same place a pay run is prepared.
 */
export function TimeSheet({ revision, changed, me }: Props) {
  const { data, error } = useLoad(() => api.listTimeEntries(), [revision]);
  const [editing, setEditing] = useState<TimeEntry | "new" | null>(null);
  const [kind, setKind] = useState<TimeKind>("Time");
  const [formError, setFormError] = useState<string | null>(null);

  const entries = data ?? [];
  const ownSheet = me.access === "TimeEntry";
  const hours = entries.filter((entry) => entry.kind === "Time").reduce((sum, entry) => sum + entry.quantityHundredths, 0);
  const miles = entries.filter((entry) => entry.kind === "Mileage").reduce((sum, entry) => sum + entry.quantityHundredths, 0);
  const billable = entries.filter((entry) => entry.isBillable).reduce((sum, entry) => sum + entry.amountCents, 0);

  function open(record: TimeEntry | "new", preset: TimeKind = "Time") {
    setEditing(record);
    setFormError(null);
    setKind(record === "new" ? preset : record.kind);
  }

  async function remove(entry: TimeEntry) {
    if (!window.confirm(`Delete ${quantityLabel(entry.kind, entry.quantityHundredths)} on ${entry.entryDate}?`)) return;
    try {
      await api.deleteTimeEntry(entry.id);
      changed("Time entry deleted");
    } catch (err) {
      window.alert(errorText(err));
    }
  }

  async function submit(form: FormData) {
    const input: TimeEntryInput = {
      id: editing === "new" || !editing ? null : editing.id,
      entryDate: field(form, "entryDate") || today(),
      kind,
      description: field(form, "description"),
      customer: field(form, "customer"),
      quantityHundredths: toHundredths(field(form, "quantity")),
      rateCents: toCents(field(form, "rate")),
      isBillable: field(form, "billable") === "yes",
    };
    if (input.quantityHundredths <= 0) {
      setFormError(kind === "Time" ? "Enter the hours worked." : "Enter the miles driven.");
      return;
    }
    try {
      await api.saveTimeEntry(input);
      changed(editing === "new" ? "Time entry logged" : "Time entry saved");
      setEditing(null);
    } catch (err) {
      setFormError(errorText(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          {ownSheet
            ? "Your own sheet — just your hours and miles. Nothing here touches the books until it is billed."
            : "Hours and miles you can bill for. Nothing here touches the books until it is billed."}
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => open("new", "Mileage")}>
            + Log mileage
          </button>
          <button type="button" className="btn btn-primary" onClick={() => open("new", "Time")}>
            + Log time
          </button>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card stat-tile">
          <div className="label">Hours logged</div>
          <div className="value">{qtyInput(hours)} h</div>
        </div>
        <div className="card stat-tile">
          <div className="label">Miles logged</div>
          <div className="value">{qtyInput(miles)} mi</div>
        </div>
        <div className="card stat-tile">
          <div className="label">Billable value</div>
          <div className="value pos">{money(billable)}</div>
        </div>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Who</th>
              <th>Kind</th>
              <th>What</th>
              <th>Customer</th>
              <th className="num">Qty</th>
              <th className="num">Rate</th>
              <th className="num">Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <Empty>
                    Nothing logged yet.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => open("new")}>
                        + Log your first hour
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const mine = entry.userId === me.id;
                return (
                  <tr key={entry.id}>
                    <td className="strong">{entry.entryDate}</td>
                    <td>{entry.enteredBy || "—"}</td>
                    <td className="muted">{entry.kind}</td>
                    <td>
                      {entry.description || "—"}
                      {!entry.isBillable && (
                        <span className="muted small"> · not billable</span>
                      )}
                      {entry.reimbursedRunId !== null && (
                        <span className="muted small"> · reimbursed on a pay run</span>
                      )}
                    </td>
                    <td className="muted">{entry.customer || "—"}</td>
                    <td className="num">{quantityLabel(entry.kind, entry.quantityHundredths)}</td>
                    <td className="num muted">{rateLabel(entry.kind, entry.rateCents)}</td>
                    <td className="num">{money(entry.amountCents)}</td>
                    <td>
                      <div className="row-actions">
                        {(mine || !ownSheet) && entry.reimbursedRunId === null && (
                          <>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => open(entry)}>
                              Edit
                            </button>
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(entry)}>
                              Delete
                            </button>
                          </>
                        )}
                        {entry.reimbursedRunId !== null && <Pill tone="paid">Reimbursed</Pill>}
                        {!mine && ownSheet && <Pill tone="draft">Not yours</Pill>}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal
          title={editing === "new" ? (kind === "Time" ? "Log time" : "Log mileage") : "Edit time entry"}
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(new FormData(event.currentTarget));
            }}
          >
            <div className="modal-body">
              {formError && <ErrorNote text={formError} />}
              <div className="field-row3">
                <div className="field">
                  <label>Date</label>
                  <input
                    type="date"
                    name="entryDate"
                    defaultValue={editing === "new" ? today() : editing.entryDate}
                  />
                </div>
                <div className="field">
                  <label>What are you logging?</label>
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as TimeKind)}
                  >
                    <option value="Time">Hours worked</option>
                    <option value="Mileage">Miles driven</option>
                  </select>
                </div>
                <div className="field">
                  <label>{kind === "Time" ? "Hours" : "Miles"}</label>
                  <input
                    name="quantity"
                    defaultValue={
                      editing === "new" ? "" : qtyInput(editing.quantityHundredths)
                    }
                    placeholder={kind === "Time" ? "2.5" : "18"}
                  />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>{kind === "Time" ? "Rate per hour" : "Rate per mile"}</label>
                  <input
                    name="rate"
                    defaultValue={editing === "new" ? "" : centsInput(editing.rateCents)}
                    placeholder={kind === "Time" ? "85.00" : "0.67"}
                  />
                </div>
                <div className="field">
                  <label>Customer or job</label>
                  <input
                    name="customer"
                    defaultValue={editing === "new" ? "" : editing.customer}
                    placeholder="Alameda Property Group"
                  />
                </div>
              </div>
              <div className="field">
                <label>What was done</label>
                <input
                  name="description"
                  defaultValue={editing === "new" ? "" : editing.description}
                  placeholder="Fence install — back yard"
                />
              </div>
              <div className="field">
                <label>Billable</label>
                <select
                  name="billable"
                  defaultValue={editing === "new" || editing.isBillable ? "yes" : "no"}
                >
                  <option value="yes">Yes — bill this to the customer</option>
                  <option value="no">No — internal time</option>
                </select>
              </div>
              <div className="settings-note">
                Logged as {me.name}. Nothing is posted to the ledger; a billable entry is simply ready to be billed.
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
