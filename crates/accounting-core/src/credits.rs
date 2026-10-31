//! Credit memos: giving a customer money back without pretending the invoice
//! never happened.
//!
//! A credit memo is always written against an issued invoice. It has three
//! possible endings, and they are genuinely different events, so they post
//! different entries:
//!
//! * **Apply** — the credit simply reduces what the customer owes. The issue
//!   entry (debit revenue, credit receivables) is the whole story.
//! * **Refund** — money leaves the bank. After the issue entry the receivable is
//!   put back and cash is credited.
//! * **Credit** — the customer keeps the value for a future invoice, so the
//!   receivable is cleared into a `Customer Credits` liability instead.
//!
//! Once a memo is posted its money is frozen in the database (see the triggers
//! in [`crate::schema`]). Corrections are a void plus a new memo, so the paper
//! trail and the books always tell the same story.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::journal::{self, EntrySource, JournalEntryInput};
use crate::simple::{self, line, InvoiceAccounts};
use crate::{audit, CoreError, Result};

// ---------------------------------------------------------------------------
// Inputs and records
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditMemoLineInput {
    /// The invoice line being credited, when the credit is for a specific item.
    pub invoice_line_id: Option<i64>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub qty_hundredths: i64,
    #[serde(default)]
    pub unit_price_cents: i64,
    pub inventory_item_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditMemoInput {
    pub id: Option<i64>,
    pub invoice_id: i64,
    pub memo_no: Option<String>,
    pub memo_date: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default = "draft_status")]
    pub status: String,
    #[serde(default = "apply_outcome")]
    pub outcome: String,
    #[serde(default)]
    pub tax_bp: i64,
    pub lines: Vec<CreditMemoLineInput>,
}

fn draft_status() -> String {
    "Draft".to_string()
}

fn apply_outcome() -> String {
    "Apply".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditMemoLine {
    pub id: i64,
    pub position: i64,
    pub invoice_line_id: Option<i64>,
    pub description: String,
    pub qty_hundredths: i64,
    pub unit_price_cents: i64,
    pub amount_cents: i64,
    pub inventory_item_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditMemo {
    pub id: i64,
    pub memo_no: String,
    pub invoice_id: i64,
    pub invoice_no: String,
    pub customer_id: Option<i64>,
    pub customer_name: String,
    pub memo_date: String,
    pub reason: String,
    pub status: String,
    pub outcome: String,
    pub tax_bp: i64,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    pub stock_returned: bool,
    pub created_at: String,
    pub posted_at: Option<String>,
    pub voided_at: Option<String>,
    pub lines: Vec<CreditMemoLine>,
}

fn normalized_status(value: &str) -> Result<&'static str> {
    match value.trim() {
        "" | "Draft" => Ok("Draft"),
        "Posted" => Ok("Posted"),
        "Void" => Err(CoreError::validation(
            "a credit memo is voided, not saved as void; use Void",
        )),
        other => Err(CoreError::validation(format!(
            "'{other}' is not a credit memo status; use Draft or Posted"
        ))),
    }
}

fn normalized_outcome(value: &str) -> Result<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "apply" => Ok("Apply"),
        "refund" => Ok("Refund"),
        "credit" => Ok("Credit"),
        other => Err(CoreError::validation(format!(
            "'{other}' is not a way to settle a credit; use Apply, Refund or Credit"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SELECT_MEMO: &str = r#"
SELECT m.id, m.memo_no, m.invoice_id, i.invoice_no, m.customer_id, COALESCE(c.name, ''),
       m.memo_date, m.reason, m.status, m.outcome, m.tax_bp,
       m.subtotal_cents, m.tax_cents, m.total_cents, m.stock_returned,
       m.created_at, m.posted_at, m.voided_at
FROM credit_memos m
JOIN invoices i ON i.id = m.invoice_id
LEFT JOIN customers c ON c.id = m.customer_id
"#;

fn lines_of(conn: &Connection, memo_id: i64) -> Result<Vec<CreditMemoLine>> {
    let mut stmt = conn.prepare(
        "SELECT id, position, invoice_line_id, description, qty_hundredths,
                unit_price_cents, inventory_item_id
           FROM credit_memo_lines WHERE memo_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map([memo_id], |row| {
        let qty: i64 = row.get(4)?;
        let price: i64 = row.get(5)?;
        Ok(CreditMemoLine {
            id: row.get(0)?,
            position: row.get(1)?,
            invoice_line_id: row.get(2)?,
            description: row.get(3)?,
            qty_hundredths: qty,
            unit_price_cents: price,
            amount_cents: simple::line_total(qty, price),
            inventory_item_id: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn map_memo(row: &rusqlite::Row<'_>) -> rusqlite::Result<CreditMemo> {
    Ok(CreditMemo {
        id: row.get(0)?,
        memo_no: row.get(1)?,
        invoice_id: row.get(2)?,
        invoice_no: row.get(3)?,
        customer_id: row.get(4)?,
        customer_name: row.get(5)?,
        memo_date: row.get(6)?,
        reason: row.get(7)?,
        status: row.get(8)?,
        outcome: row.get(9)?,
        tax_bp: row.get(10)?,
        subtotal_cents: row.get(11)?,
        tax_cents: row.get(12)?,
        total_cents: row.get(13)?,
        stock_returned: row.get::<_, i64>(14)? != 0,
        created_at: row.get(15)?,
        posted_at: row.get(16)?,
        voided_at: row.get(17)?,
        lines: Vec::new(),
    })
}

pub fn memo_by_id(conn: &Connection, id: i64) -> Result<CreditMemo> {
    let mut memo = conn
        .prepare(&format!("{SELECT_MEMO} WHERE m.id = ?1"))?
        .query_row([id], map_memo)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("credit memo {id} does not exist")))?;
    memo.lines = lines_of(conn, id)?;
    Ok(memo)
}

pub fn list_credit_memos(conn: &Connection) -> Result<Vec<CreditMemo>> {
    let mut ids = Vec::new();
    {
        let mut stmt =
            conn.prepare("SELECT id FROM credit_memos ORDER BY memo_date DESC, id DESC")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for id in rows {
            ids.push(id?);
        }
    }
    ids.into_iter().map(|id| memo_by_id(conn, id)).collect()
}

/// How much of an invoice has already been credited by memos that still count.
fn credited_total(conn: &Connection, invoice_id: i64, excluding: Option<i64>) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(total_cents), 0) FROM credit_memos
          WHERE invoice_id = ?1 AND status <> 'Void' AND id IS NOT ?2",
        params![invoice_id, excluding],
        |row| row.get(0),
    )?)
}

fn next_memo_number(conn: &Connection) -> Result<String> {
    let mut stmt = conn.prepare("SELECT memo_no FROM credit_memos")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut highest = 1000i64;
    for number in rows {
        if let Some(digits) = number?.rsplit('-').next() {
            if let Ok(value) = digits.trim().parse::<i64>() {
                highest = highest.max(value);
            }
        }
    }
    Ok(format!("CM-{}", highest + 1))
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

pub fn save_credit_memo(conn: &mut Connection, input: &CreditMemoInput) -> Result<CreditMemo> {
    let accounts = simple::invoice_accounts(conn)?;
    let credit_account = simple::customer_credit_account(conn)?;
    let tx = conn.transaction()?;
    let id = save_tx(&tx, &accounts, credit_account, input)?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    memo_by_id(conn, id)
}

fn save_tx(
    conn: &Connection,
    accounts: &InvoiceAccounts,
    credit_account: i64,
    input: &CreditMemoInput,
) -> Result<i64> {
    let day = simple::checked_date(&input.memo_date, "the credit date")?;
    let tax_bp = simple::checked_tax_rate(input.tax_bp)?;
    let reason = simple::required_text(&input.reason, "a reason for the credit")?;
    let status = normalized_status(&input.status)?;
    let outcome = normalized_outcome(&input.outcome)?;

    // The invoice this credit is written against, and how much it is worth.
    let (invoice_no, customer_id, invoice_status, invoice_tax_bp, invoice_subtotal) = conn
        .query_row(
            "SELECT i.invoice_no, i.customer_id, i.status, i.tax_bp,
                    COALESCE((SELECT SUM((l.qty_hundredths * l.unit_price_cents + 50) / 100)
                                FROM invoice_lines l WHERE l.invoice_id = i.id), 0)
               FROM invoices i WHERE i.id = ?1",
            [input.invoice_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::validation(
                "a credit memo must be based on an invoice; that invoice does not exist",
            )
        })?;
    let invoice_total = invoice_subtotal + simple::tax_of(invoice_subtotal, invoice_tax_bp);

    if invoice_status == "Draft" {
        return Err(CoreError::validation(format!(
            "invoice {invoice_no} is still a draft — send it before crediting it, because a draft has not touched the books yet"
        )));
    }

    // Only a draft may be edited. Posted money is frozen.
    if let Some(id) = input.id {
        let existing: Option<String> = conn
            .query_row("SELECT status FROM credit_memos WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        match existing.as_deref() {
            None => {
                return Err(CoreError::not_found(format!(
                    "credit memo {id} does not exist"
                )))
            }
            Some("Draft") => {}
            Some(_) => {
                return Err(CoreError::validation(
                    "this credit memo is already posted; void it and issue a new one instead of editing it",
                ))
            }
        }
    }

    // Work out the lines. A line tied to an invoice line keeps that line's
    // description and price — a credit is a refund of the original charge, not
    // a chance to invent a new one.
    let mut prepared = Vec::new();
    for input_line in &input.lines {
        if input_line.qty_hundredths <= 0 {
            continue;
        }
        match input_line.invoice_line_id {
            Some(invoice_line_id) => {
                let original: Option<(String, i64, i64, Option<i64>)> = conn
                    .query_row(
                        "SELECT description, qty_hundredths, unit_price_cents, inventory_item_id
                           FROM invoice_lines WHERE id = ?1 AND invoice_id = ?2",
                        params![invoice_line_id, input.invoice_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let (description, original_qty, unit_price, item_id) = original.ok_or_else(|| {
                    CoreError::validation("that line does not belong to the invoice being credited")
                })?;

                let already: i64 = conn.query_row(
                    "SELECT COALESCE(SUM(cl.qty_hundredths), 0)
                       FROM credit_memo_lines cl
                       JOIN credit_memos m ON m.id = cl.memo_id
                      WHERE cl.invoice_line_id = ?1 AND m.status <> 'Void' AND m.id IS NOT ?2",
                    params![invoice_line_id, input.id],
                    |row| row.get(0),
                )?;
                if input_line.qty_hundredths + already > original_qty {
                    let left = (original_qty - already).max(0);
                    return Err(CoreError::validation(format!(
                        "invoice {invoice_no} only has {:.2} of \"{description}\" left to credit",
                        left as f64 / 100.0
                    )));
                }

                prepared.push(CreditMemoLineInput {
                    invoice_line_id: Some(invoice_line_id),
                    description,
                    qty_hundredths: input_line.qty_hundredths,
                    unit_price_cents: unit_price,
                    inventory_item_id: item_id,
                });
            }
            None => {
                let description = simple::required_text(&input_line.description, "a credit line")?;
                if input_line.unit_price_cents <= 0 {
                    return Err(CoreError::validation(
                        "a credit line needs a price above zero",
                    ));
                }
                prepared.push(CreditMemoLineInput {
                    invoice_line_id: None,
                    description,
                    qty_hundredths: input_line.qty_hundredths,
                    unit_price_cents: input_line.unit_price_cents,
                    inventory_item_id: input_line.inventory_item_id,
                });
            }
        }
    }

    if prepared.is_empty() {
        return Err(CoreError::validation(
            "choose at least one thing to credit — a credit memo with nothing on it would post an empty entry",
        ));
    }

    let subtotal: i64 = prepared
        .iter()
        .map(|line| simple::line_total(line.qty_hundredths, line.unit_price_cents))
        .sum();
    let tax = simple::tax_of(subtotal, tax_bp);
    let total = subtotal + tax;
    if total <= 0 {
        return Err(CoreError::validation(
            "a credit memo must be worth more than zero",
        ));
    }

    let already = credited_total(conn, input.invoice_id, input.id)?;
    if already + total > invoice_total {
        return Err(CoreError::validation(format!(
            "that would credit {:.2} against an invoice worth {:.2}; only {:.2} is left",
            (already + total) as f64 / 100.0,
            invoice_total as f64 / 100.0,
            (invoice_total - already).max(0) as f64 / 100.0
        )));
    }

    let memo_no = match input.memo_no.as_deref() {
        Some(value) if !value.trim().is_empty() => {
            let value = value.trim().to_string();
            let clash: Option<i64> = conn
                .query_row(
                    "SELECT id FROM credit_memos WHERE lower(trim(memo_no)) = lower(?1) AND id IS NOT ?2",
                    params![value, input.id],
                    |row| row.get(0),
                )
                .optional()?;
            if clash.is_some() {
                return Err(CoreError::validation(format!(
                    "credit memo number {value} is already in use"
                )));
            }
            value
        }
        _ => next_memo_number(conn)?,
    };

    let customer_id = customer_id.or_else(|| {
        conn.query_row(
            "SELECT customer_id FROM invoices WHERE id = ?1",
            [input.invoice_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    });

    // The header is written as a draft first: every memo line, and every future
    // edit, is only allowed while it is one.
    let id = match input.id {
        Some(id) => {
            conn.execute(
                "UPDATE credit_memos
                    SET memo_no = ?2, invoice_id = ?3, customer_id = ?4, memo_date = ?5,
                        reason = ?6, outcome = ?7, tax_bp = ?8, subtotal_cents = ?9,
                        tax_cents = ?10, total_cents = ?11, status = 'Draft',
                        posted_at = NULL, stock_returned = 0,
                        issue_entry_id = NULL, settlement_entry_id = NULL, cogs_entry_id = NULL
                  WHERE id = ?1",
                params![
                    id,
                    memo_no,
                    input.invoice_id,
                    customer_id,
                    day,
                    reason,
                    outcome,
                    tax_bp,
                    subtotal,
                    tax,
                    total
                ],
            )?;
            conn.execute("DELETE FROM credit_memo_lines WHERE memo_id = ?1", [id])?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO credit_memos
                    (memo_no, invoice_id, customer_id, memo_date, reason, status, outcome, tax_bp,
                     subtotal_cents, tax_cents, total_cents, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'Draft', ?6, ?7, ?8, ?9, ?10,
                         (SELECT actor FROM app_session WHERE id = 1))",
                params![
                    memo_no,
                    input.invoice_id,
                    customer_id,
                    day,
                    reason,
                    outcome,
                    tax_bp,
                    subtotal,
                    tax,
                    total
                ],
            )?;
            conn.last_insert_rowid()
        }
    };

    {
        let mut stmt = conn.prepare(
            "INSERT INTO credit_memo_lines
                (memo_id, invoice_line_id, position, description, qty_hundredths,
                 unit_price_cents, inventory_item_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for (index, line) in prepared.iter().enumerate() {
            stmt.execute(params![
                id,
                line.invoice_line_id,
                (index as i64) + 1,
                line.description.trim(),
                line.qty_hundredths,
                line.unit_price_cents,
                line.inventory_item_id
            ])?;
        }
    }

    if status == "Posted" {
        post_tx(conn, accounts, credit_account, id, &memo_no, &day, outcome, prepared.as_slice(), subtotal, tax, total)?;
    }

    Ok(id)
}

/// Book a memo. The receivable is always relieved; what happens next depends on
/// where the value actually goes.
#[allow(clippy::too_many_arguments)]
fn post_tx(
    conn: &Connection,
    accounts: &InvoiceAccounts,
    credit_account: i64,
    id: i64,
    memo_no: &str,
    day: &str,
    outcome: &str,
    lines: &[CreditMemoLineInput],
    subtotal: i64,
    tax: i64,
    total: i64,
) -> Result<()> {
    let mut entry_lines = Vec::new();
    if subtotal > 0 {
        entry_lines.push(line(accounts.income, subtotal, 0));
    }
    if tax > 0 {
        entry_lines.push(line(accounts.tax, tax, 0));
    }
    entry_lines.push(line(accounts.receivable, 0, total));
    let issue = JournalEntryInput {
        entry_date: day.to_string(),
        memo: format!("Credit memo {memo_no}"),
        reference: Some(memo_no.to_string()),
        source: EntrySource::Invoice,
        lines: entry_lines,
    };
    let issue_entry_id = journal::post_in(conn, &issue)?.summary.id;

    // Stock that comes back is stock again, at the cost it left at.
    let mut stock_returned = false;
    let mut cogs_total = 0i64;
    for line in lines {
        if let Some(item_id) = line.inventory_item_id {
            simple::adjust_stock(conn, item_id, line.qty_hundredths)?;
            stock_returned = true;
            cogs_total += simple::line_total(line.qty_hundredths, simple::item_cost(conn, item_id)?);
        }
    }
    let mut cogs_entry_id = None;
    if cogs_total > 0 {
        let entry = JournalEntryInput {
            entry_date: day.to_string(),
            memo: format!("Stock returned — credit memo {memo_no}"),
            reference: Some(memo_no.to_string()),
            source: EntrySource::Inventory,
            lines: vec![
                line(accounts.inventory, cogs_total, 0),
                line(accounts.cogs, 0, cogs_total),
            ],
        };
        cogs_entry_id = Some(journal::post_in(conn, &entry)?.summary.id);
    }

    // Apply leaves the receivable reduced. The other two move the value on.
    let mut settlement_entry_id = None;
    match outcome {
        "Refund" => {
            let entry = JournalEntryInput {
                entry_date: day.to_string(),
                memo: format!("Refund paid — credit memo {memo_no}"),
                reference: Some(memo_no.to_string()),
                source: EntrySource::Payment,
                lines: vec![
                    line(accounts.receivable, total, 0),
                    line(accounts.cash, 0, total),
                ],
            };
            settlement_entry_id = Some(journal::post_in(conn, &entry)?.summary.id);
        }
        "Credit" => {
            let entry = JournalEntryInput {
                entry_date: day.to_string(),
                memo: format!("Customer credit held — {memo_no}"),
                reference: Some(memo_no.to_string()),
                source: EntrySource::Adjustment,
                lines: vec![
                    line(accounts.receivable, total, 0),
                    line(credit_account, 0, total),
                ],
            };
            settlement_entry_id = Some(journal::post_in(conn, &entry)?.summary.id);
        }
        _ => {}
    }

    conn.execute(
        "UPDATE credit_memos
            SET status = 'Posted', posted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                stock_returned = ?2, issue_entry_id = ?3, settlement_entry_id = ?4,
                cogs_entry_id = ?5
          WHERE id = ?1",
        params![
            id,
            stock_returned as i64,
            issue_entry_id,
            settlement_entry_id,
            cogs_entry_id
        ],
    )?;
    Ok(())
}

/// Undo a posted memo. The entries are voided rather than deleted, so the
/// reversal is visible in the ledger exactly like any other correction.
pub fn void_credit_memo(conn: &mut Connection, id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let row: Option<(String, i64, Option<i64>, Option<i64>, Option<i64>)> = tx
        .query_row(
            "SELECT status, stock_returned, issue_entry_id, settlement_entry_id, cogs_entry_id
               FROM credit_memos WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let (status, stock_returned, issue, settlement, cogs) =
        row.ok_or_else(|| CoreError::not_found(format!("credit memo {id} does not exist")))?;
    if status != "Posted" {
        return Err(CoreError::validation(
            "only a posted credit memo can be voided; a draft can simply be deleted",
        ));
    }

    if stock_returned != 0 {
        for line in lines_of(&tx, id)? {
            if let Some(item_id) = line.inventory_item_id {
                simple::adjust_stock(&tx, item_id, -line.qty_hundredths)?;
            }
        }
    }
    for entry in [issue, settlement, cogs].into_iter().flatten() {
        journal::void_in(&tx, entry)?;
    }
    tx.execute(
        "UPDATE credit_memos
            SET status = 'Void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                stock_returned = 0
          WHERE id = ?1",
        [id],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn delete_credit_memo(conn: &mut Connection, id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let status: Option<String> = tx
        .query_row("SELECT status FROM credit_memos WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    match status.as_deref() {
        None => return Err(CoreError::not_found(format!("credit memo {id} does not exist"))),
        Some("Draft") => {}
        Some(_) => {
            return Err(CoreError::validation(
                "a posted or voided credit memo stays on the books; void it instead of deleting it",
            ))
        }
    }
    tx.execute("DELETE FROM credit_memo_lines WHERE memo_id = ?1", [id])?;
    tx.execute("DELETE FROM credit_memos WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}
