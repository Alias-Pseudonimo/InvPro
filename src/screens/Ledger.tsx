import { useState } from "react";
import AccountsPanel from "../components/AccountsPanel";
import JournalPanel from "../components/JournalPanel";
import TrialBalancePanel from "../components/TrialBalancePanel";
import AuditPanel from "../components/AuditPanel";

type Pane = "accounts" | "journal" | "trial" | "audit";

const PANES: Array<{ id: Pane; label: string }> = [
  { id: "accounts", label: "Chart of accounts" },
  { id: "journal", label: "Journal" },
  { id: "trial", label: "Trial balance" },
  { id: "audit", label: "Audit trail" },
];

/**
 * The ledger the app keeps for you. Everything above writes into it, so this is
 * where an accountant — or a curious owner — can see the machinery, correct
 * something by hand, or check that the books still balance.
 */
export default function LedgerScreen({
  revision,
  changed,
}: {
  revision: number;
  changed: (message?: string) => void;
}) {
  const [pane, setPane] = useState<Pane>("trial");

  return (
    <>
      <div className="toolbar">
        <div className="muted small">
          The double-entry ledger behind the friendly screens. Nothing here is required day to day.
        </div>
        <div className="segment">
          {PANES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`segment-item ${pane === item.id ? "active" : ""}`}
              onClick={() => setPane(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {pane === "accounts" && <AccountsPanel revision={revision} onMutated={() => changed("Account updated")} />}
      {pane === "journal" && <JournalPanel revision={revision} onMutated={() => changed("Entry posted")} />}
      {pane === "trial" && <TrialBalancePanel revision={revision} />}
      {pane === "audit" && <AuditPanel revision={revision} />}
    </>
  );
}
