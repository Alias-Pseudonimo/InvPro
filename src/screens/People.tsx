import { useState } from "react";
import { api } from "../api";
import type { Customer, Vendor } from "../types";
import { Empty, ErrorNote, Modal, field, money, submitHandler, useLoad } from "../ui";

interface Props {
  kind: "customers" | "vendors";
  revision: number;
  changed: (message?: string) => void;
}

type Party = Customer | Vendor;

export default function PeopleScreen({ kind, revision, changed }: Props) {
  const isCustomer = kind === "customers";
  const { data, error } = useLoad<Party[]>(
    () => (isCustomer ? api.listCustomers() : api.listVendors()),
    [revision, kind],
  );
  const [editing, setEditing] = useState<Party | "new" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function remove(party: Party) {
    if (!window.confirm(`Delete ${party.name}?`)) return;
    try {
      if (isCustomer) await api.deleteCustomer(party.id);
      else await api.deleteVendor(party.id);
      changed(`${isCustomer ? "Customer" : "Vendor"} deleted`);
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          {isCustomer ? "Who you bill, and what they still owe." : "Who you pay, and what you still owe."}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          + Add {isCustomer ? "customer" : "vendor"}
        </button>
      </div>

      {error && <ErrorNote text={error} />}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Address</th>
              <th className="num">{isCustomer ? "Billed" : "Spent"}</th>
              <th className="num">Outstanding</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <Empty>
                    No {isCustomer ? "customers" : "vendors"} yet.
                    <div className="cta">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
                        + Add your first {isCustomer ? "customer" : "vendor"}
                      </button>
                    </div>
                  </Empty>
                </td>
              </tr>
            ) : (
              (data ?? []).map((party) => {
                const total = "billedCents" in party ? party.billedCents : party.spentCents;
                return (
                  <tr key={party.id}>
                    <td className="strong">{party.name}</td>
                    <td className="muted">{party.email || "—"}</td>
                    <td className="muted">{party.phone || "—"}</td>
                    <td className="muted">{party.address || "—"}</td>
                    <td className="num">{money(total)}</td>
                    <td className={`num ${party.outstandingCents > 0 ? "money-neg" : "muted"}`}>
                      {money(party.outstandingCents)}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(party)}>
                          Edit
                        </button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(party)}>
                          Delete
                        </button>
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
          title={editing === "new" ? `Add ${isCustomer ? "customer" : "vendor"}` : `Edit ${editing.name}`}
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={submitHandler(
              async (form) => {
                const input = {
                  id: editing === "new" ? null : editing.id,
                  name: field(form, "name"),
                  email: field(form, "email"),
                  phone: field(form, "phone"),
                  address: field(form, "address"),
                  notes: field(form, "notes"),
                };
                if (isCustomer) await api.saveCustomer(input);
                else await api.saveVendor(input);
                changed(`${isCustomer ? "Customer" : "Vendor"} saved`);
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
              <div className="field-row">
                <div className="field">
                  <label>Email</label>
                  <input name="email" type="email" defaultValue={editing === "new" ? "" : editing.email} />
                </div>
                <div className="field">
                  <label>Phone</label>
                  <input name="phone" defaultValue={editing === "new" ? "" : editing.phone} />
                </div>
              </div>
              <div className="field">
                <label>Address</label>
                <input name="address" defaultValue={editing === "new" ? "" : editing.address} />
              </div>
              <div className="field">
                <label>Notes</label>
                <input name="notes" defaultValue={editing === "new" ? "" : editing.notes} />
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
