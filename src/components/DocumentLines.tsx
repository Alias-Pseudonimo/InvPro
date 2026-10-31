import type { ReactNode } from "react";
import { centsInput, money, qtyInput } from "../ui";
import type { InventoryItem } from "../types";

/**
 * The line grid shared by every customer document: an invoice, a quote, a
 * sales order, and a recurring schedule. One row shape, one behaviour, so the
 * paperwork feels like the same family of paper rather than four screens that
 * happen to look alike.
 */

export interface DraftLine {
  key: number;
  description: string;
  qty: string;
  price: string;
  itemId: string;
}

let lineKey = 0;

export function blankLine(price = ""): DraftLine {
  lineKey += 1;
  return { key: lineKey, description: "", qty: "1", price, itemId: "" };
}

export function linesFrom(
  lines: Array<{
    description: string;
    qtyHundredths: number;
    unitPriceCents: number;
    inventoryItemId: number | null;
  }>,
): DraftLine[] {
  return lines.map((line) => {
    lineKey += 1;
    return {
      key: lineKey,
      description: line.description,
      qty: qtyInput(line.qtyHundredths),
      price: centsInput(line.unitPriceCents),
      itemId: line.inventoryItemId ? String(line.inventoryItemId) : "",
    };
  });
}

export function lineAmount(line: DraftLine): number {
  const qty = Number(line.qty) || 0;
  const price = Number(line.price) || 0;
  return Math.round(qty * price * 100);
}

export function LineEditor({
  lines,
  setLines,
  items,
  totals,
  placeholder = "What are you billing for?",
}: {
  lines: DraftLine[];
  setLines: React.Dispatch<React.SetStateAction<DraftLine[]>>;
  items: InventoryItem[];
  totals?: ReactNode;
  placeholder?: string;
}) {
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

  return (
    <>
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
            placeholder={placeholder}
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
            onClick={() =>
              setLines((current) =>
                current.length === 1 ? [blankLine()] : current.filter((row) => row.key !== line.key),
              )
            }
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
        {totals}
      </div>
    </>
  );
}

/** Subtotal, tax and total, in the same place on every document. */
export function DocumentTotals({
  subtotal,
  taxPct,
  setTaxPct,
  tax,
  total,
}: {
  subtotal: number;
  taxPct: string;
  setTaxPct: (value: string) => void;
  tax: number;
  total: number;
}) {
  return (
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
        <strong className="num">{money(total)}</strong>
      </div>
    </div>
  );
}

/** The lines a form sends to the engine. */
export function payloadLines(lines: DraftLine[]) {
  return lines
    .filter((line) => line.description.trim() || Number(line.price) > 0)
    .map((line) => ({
      description: line.description,
      qtyHundredths: Math.round((Number(line.qty) || 0) * 100),
      unitPriceCents: Math.round((Number(line.price) || 0) * 100),
      inventoryItemId: Number(line.itemId) || null,
    }));
}
