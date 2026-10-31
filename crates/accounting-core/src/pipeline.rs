//! Quotes and orders — the paperwork that comes before an invoice.
//!
//! An estimate answers "what would this cost?", a sales order answers "what did
//! they actually order?", and an invoice answers "what do they owe?". Only the
//! invoice touches the ledger, so these two documents are deliberately cheap:
//! they hold lines, a customer and a status, and nothing else.
//!
//! Converting is one-way and leaves a trail. The quote records the order it
//! became, the order records the invoice it became, and the lines freeze the
//! moment that happens — a wrong quote is replaced by a new quote rather than
//! edited underneath a document that already depends on it.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::simple::{self, InvoiceInput, InvoiceLineInput};
use crate::{audit, CoreError, Result};

pub const ESTIMATE_DRAFT: &str = "Draft";
pub const ESTIMATE_SENT: &str = "Sent";
pub const ESTIMATE_ACCEPTED: &str = "Accepted";
pub const ESTIMATE_DECLINED: &str = "Declined";
pub const ESTIMATE_EXPIRED: &str = "Expired";

pub const ORDER_DRAFT: &str = "Draft";
pub const ORDER_CONFIRMED: &str = "Confirmed";
pub const ORDER_FULFILLED: &str = "Fulfilled";
pub const ORDER_CANCELLED: &str = "Cancelled";

const ESTIMATE_STATUSES: [&str; 5] = [
    ESTIMATE_DRAFT,
    ESTIMATE_SENT,
    ESTIMATE_ACCEPTED,
    ESTIMATE_DECLINED,
    ESTIMATE_EXPIRED,
];

const ORDER_STATUSES: [&str; 4] = [ORDER_DRAFT, ORDER_CONFIRMED, ORDER_FULFILLED, ORDER_CANCELLED];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineLine {
    pub id: i64,
    pub position: i64,
    pub description: String,
    pub qty_hundredths: i64,
    pub unit_price_cents: i64,
    pub amount_cents: i64,
    pub inventory_item_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateInput {
    pub id: Option<i64>,
    pub estimate_no: Option<String>,
    pub customer_id: Option<i64>,
    pub estimate_date: String,
    pub expiry_date: Option<String>,
    #[serde(default = "draft")]
    pub status: String,
    #[serde(default)]
    pub tax_bp: i64,
    #[serde(default)]
    pub notes: String,
    pub lines: Vec<InvoiceLineInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesOrderInput {
    pub id: Option<i64>,
    pub order_no: Option<String>,
    pub customer_id: Option<i64>,
    pub order_date: String,
    pub requested_date: Option<String>,
    #[serde(default = "draft")]
    pub status: String,
    #[serde(default)]
    pub tax_bp: i64,
    #[serde(default)]
    pub notes: String,
    pub lines: Vec<InvoiceLineInput>,
}

fn draft() -> String {
    ESTIMATE_DRAFT.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub id: i64,
    pub estimate_no: String,
    pub customer_id: Option<i64>,
    pub customer_name: String,
    pub estimate_date: String,
    pub expiry_date: Option<String>,
    pub status: String,
    pub tax_bp: i64,
    pub notes: String,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    pub converted_order_id: Option<i64>,
    pub converted_invoice_id: Option<i64>,
    pub converted_at: Option<String>,
    pub lines: Vec<PipelineLine>,
    /// The invoice number this quote became, so the list can say so.
    pub invoice_no: Option<String>,
    pub order_no: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesOrder {
    pub id: i64,
    pub order_no: String,
    pub customer_id: Option<i64>,
    pub customer_name: String,
    pub order_date: String,
    pub requested_date: Option<String>,
    pub status: String,
    pub tax_bp: i64,
    pub notes: String,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    pub invoice_id: Option<i64>,
    pub invoice_no: Option<String>,
    pub estimate_id: Option<i64>,
    pub estimate_no: Option<String>,
    pub converted_at: Option<String>,
    pub lines: Vec<PipelineLine>,
}

fn normalized_estimate_status(value: &str) -> Result<&'static str> {
    let trimmed = value.trim();
    let candidate = if trimmed.is_empty() { ESTIMATE_DRAFT } else { trimmed };
    ESTIMATE_STATUSES
        .iter()
        .copied()
        .find(|status| status.eq_ignore_ascii_case(candidate))
        .ok_or_else(|| {
            CoreError::validation(format!(
                "'{candidate}' is not an estimate status; use Draft, Sent, Accepted, Declined or Expired"
            ))
        })
}

fn normalized_order_status(value: &str) -> Result<&'static str> {
    let trimmed = value.trim();
    let candidate = if trimmed.is_empty() { ORDER_DRAFT } else { trimmed };
    ORDER_STATUSES
        .iter()
        .copied()
        .find(|status| status.eq_ignore_ascii_case(candidate))
        .ok_or_else(|| {
            CoreError::validation(format!(
                "'{candidate}' is not a sales order status; use Draft, Confirmed, Fulfilled or Cancelled"
            ))
        })
}

fn optional_date(value: Option<&str>, what: &str) -> Result<Option<String>> {
    match value {
        Some(text) if !text.trim().is_empty() => Ok(Some(simple::checked_date(text, what)?)),
        _ => Ok(None),
    }
}

/// The next free number in a series, looking only at that series so a quote can
/// never take a number a customer already saw on an invoice.
fn next_number(conn: &Connection, table: &str, column: &str, prefix: &str) -> Result<String> {
    let mut stmt = conn.prepare(&format!("SELECT {column} FROM {table}"))?;
    let numbers = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut highest = 1000i64;
    for number in numbers {
        let number = number?;
        if let Some(digits) = number.rsplit('-').next() {
            if let Ok(value) = digits.trim().parse::<i64>() {
                highest = highest.max(value);
            }
        }
    }
    Ok(format!("{prefix}-{}", highest + 1))
}

fn series(conn: &Connection, key: &str, fallback: &str) -> String {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| fallback.to_string())
}

/// A number the owner typed must not clash inside its own series.
fn chosen_number(
    conn: &Connection,
    table: &str,
    column: &str,
    requested: Option<&str>,
    id: Option<i64>,
    fallback_prefix: &str,
) -> Result<String> {
    match requested {
        Some(value) if !value.trim().is_empty() => {
            let value = value.trim().to_string();
            let clash: Option<i64> = conn
                .query_row(
                    &format!(
                        "SELECT id FROM {table} WHERE lower(trim({column})) = lower(trim(?1)) AND id IS NOT ?2"
                    ),
                    params![value, id],
                    |row| row.get(0),
                )
                .optional()?;
            if clash.is_some() {
                return Err(CoreError::validation(format!(
                    "number {value} is already in use; pick another one"
                )));
            }
            Ok(value)
        }
        _ => next_number(conn, table, column, fallback_prefix),
    }
}

fn lines_of(conn: &Connection, table: &str, owner: &str, owner_id: i64) -> Result<Vec<PipelineLine>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id, position, description, qty_hundredths, unit_price_cents, inventory_item_id
           FROM {table} WHERE {owner} = ?1 ORDER BY position"
    ))?;
    let rows = stmt.query_map([owner_id], |row| {
        let qty: i64 = row.get(3)?;
        let price: i64 = row.get(4)?;
        Ok(PipelineLine {
            id: row.get(0)?,
            position: row.get(1)?,
            description: row.get(2)?,
            qty_hundredths: qty,
            unit_price_cents: price,
            amount_cents: simple::line_total(qty, price),
            inventory_item_id: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn write_lines(
    conn: &Connection,
    table: &str,
    owner: &str,
    owner_id: i64,
    lines: &[InvoiceLineInput],
) -> Result<()> {
    let mut stmt = conn.prepare(&format!(
        "INSERT INTO {table} ({owner}, position, description, qty_hundredths, unit_price_cents, inventory_item_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ))?;
    for (index, line) in lines.iter().enumerate() {
        stmt.execute(params![
            owner_id,
            (index as i64) + 1,
            line.description.trim(),
            line.qty_hundredths,
            line.unit_price_cents,
            line.inventory_item_id
        ])?;
    }
    Ok(())
}

fn totals(lines: &[InvoiceLineInput], tax_bp: i64) -> i64 {
    let subtotal: i64 = lines
        .iter()
        .map(|line| simple::line_total(line.qty_hundredths, line.unit_price_cents))
        .sum();
    subtotal + simple::tax_of(subtotal, tax_bp)
}

/// Today in the company file's own time zone, used when a conversion does not
/// name a date.
fn today(conn: &Connection) -> Result<String> {
    Ok(conn.query_row(
        "SELECT strftime('%Y-%m-%d', 'now', 'localtime')",
        [],
        |row| row.get(0),
    )?)
}

fn require_total(total: i64, what: &str) -> Result<()> {
    if total <= 0 {
        return Err(CoreError::validation(format!(
            "a {what} must be worth more than zero"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

const SELECT_ESTIMATE: &str = r#"
SELECT e.id, e.estimate_no, e.customer_id, COALESCE(c.name, ''), e.estimate_date,
       e.expiry_date, e.status, e.tax_bp, e.notes, e.converted_order_id,
       e.converted_invoice_id, e.converted_at,
       COALESCE((SELECT SUM((l.qty_hundredths * l.unit_price_cents + 50) / 100)
                   FROM estimate_lines l WHERE l.estimate_id = e.id), 0),
       (SELECT i.invoice_no FROM invoices i WHERE i.id = e.converted_invoice_id),
       (SELECT o.order_no FROM sales_orders o WHERE o.id = e.converted_order_id)
  FROM estimates e
  LEFT JOIN customers c ON c.id = e.customer_id
"#;

fn map_estimate(row: &rusqlite::Row<'_>) -> rusqlite::Result<Estimate> {
    let tax_bp: i64 = row.get(7)?;
    let subtotal: i64 = row.get(12)?;
    let tax = simple::tax_of(subtotal, tax_bp);
    Ok(Estimate {
        id: row.get(0)?,
        estimate_no: row.get(1)?,
        customer_id: row.get(2)?,
        customer_name: row.get(3)?,
        estimate_date: row.get(4)?,
        expiry_date: row.get(5)?,
        status: row.get(6)?,
        tax_bp,
        notes: row.get(8)?,
        converted_order_id: row.get(9)?,
        converted_invoice_id: row.get(10)?,
        converted_at: row.get(11)?,
        subtotal_cents: subtotal,
        tax_cents: tax,
        total_cents: subtotal + tax,
        invoice_no: row.get(13)?,
        order_no: row.get(14)?,
        lines: Vec::new(),
    })
}

pub fn list_estimates(conn: &Connection) -> Result<Vec<Estimate>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_ESTIMATE} ORDER BY e.estimate_date DESC, e.id DESC"
    ))?;
    let rows = stmt.query_map([], map_estimate)?;
    let mut records = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for record in &mut records {
        record.lines = lines_of(conn, "estimate_lines", "estimate_id", record.id)?;
    }
    Ok(records)
}

pub fn estimate_by_id(conn: &Connection, id: i64) -> Result<Estimate> {
    let mut record = conn
        .prepare(&format!("{SELECT_ESTIMATE} WHERE e.id = ?1"))?
        .query_row([id], map_estimate)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("estimate {id} does not exist")))?;
    record.lines = lines_of(conn, "estimate_lines", "estimate_id", id)?;
    Ok(record)
}

pub fn save_estimate(conn: &mut Connection, input: &EstimateInput) -> Result<Estimate> {
    let day = simple::checked_date(&input.estimate_date, "the estimate date")?;
    let expiry = optional_date(input.expiry_date.as_deref(), "the expiry date")?;
    let status = normalized_estimate_status(&input.status)?;
    let tax_bp = simple::checked_tax_rate(input.tax_bp)?;
    let lines = simple::checked_lines(&input.lines)?;
    require_total(totals(&lines, tax_bp), "estimate")?;
    let prefix = series(conn, "estimate_series", "EST");

    let tx = conn.transaction()?;
    if let Some(id) = input.id {
        let converted: Option<String> = tx
            .query_row("SELECT converted_at FROM estimates WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or_else(|| CoreError::not_found(format!("estimate {id} does not exist")))?;
        if converted.is_some() {
            return Err(CoreError::validation(
                "this estimate has already become an order or an invoice, so its contents are fixed; start a new estimate if the quote changed",
            ));
        }
    }

    let number = chosen_number(
        &tx,
        "estimates",
        "estimate_no",
        input.estimate_no.as_deref(),
        input.id,
        &prefix,
    )?;

    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE estimates
                    SET estimate_no = ?2, customer_id = ?3, estimate_date = ?4, expiry_date = ?5,
                        status = ?6, tax_bp = ?7, notes = ?8
                  WHERE id = ?1",
                params![
                    id,
                    number,
                    input.customer_id,
                    day,
                    expiry,
                    status,
                    tax_bp,
                    input.notes.trim()
                ],
            )?;
            tx.execute("DELETE FROM estimate_lines WHERE estimate_id = ?1", [id])?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO estimates (estimate_no, customer_id, estimate_date, expiry_date, status, tax_bp, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    number,
                    input.customer_id,
                    day,
                    expiry,
                    status,
                    tax_bp,
                    input.notes.trim()
                ],
            )?;
            tx.last_insert_rowid()
        }
    };
    write_lines(&tx, "estimate_lines", "estimate_id", id, &lines)?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    estimate_by_id(conn, id)
}

pub fn delete_estimate(conn: &mut Connection, id: i64) -> Result<()> {
    let converted: Option<String> = conn
        .query_row("SELECT converted_at FROM estimates WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("estimate {id} does not exist")))?;
    if converted.is_some() {
        return Err(CoreError::validation(
            "this estimate already became an order or an invoice, so it stays on file",
        ));
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM estimate_lines WHERE estimate_id = ?1", [id])?;
    tx.execute("DELETE FROM estimates WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

const SELECT_ORDER: &str = r#"
SELECT o.id, o.order_no, o.customer_id, COALESCE(c.name, ''), o.order_date,
       o.requested_date, o.status, o.tax_bp, o.notes, o.invoice_id,
       (SELECT i.invoice_no FROM invoices i WHERE i.id = o.invoice_id),
       (SELECT e.id FROM estimates e WHERE e.converted_order_id = o.id),
       (SELECT e.estimate_no FROM estimates e WHERE e.converted_order_id = o.id),
       o.converted_at,
       COALESCE((SELECT SUM((l.qty_hundredths * l.unit_price_cents + 50) / 100)
                   FROM sales_order_lines l WHERE l.order_id = o.id), 0)
  FROM sales_orders o
  LEFT JOIN customers c ON c.id = o.customer_id
"#;

fn map_order(row: &rusqlite::Row<'_>) -> rusqlite::Result<SalesOrder> {
    let tax_bp: i64 = row.get(7)?;
    let subtotal: i64 = row.get(14)?;
    let tax = simple::tax_of(subtotal, tax_bp);
    Ok(SalesOrder {
        id: row.get(0)?,
        order_no: row.get(1)?,
        customer_id: row.get(2)?,
        customer_name: row.get(3)?,
        order_date: row.get(4)?,
        requested_date: row.get(5)?,
        status: row.get(6)?,
        tax_bp,
        notes: row.get(8)?,
        invoice_id: row.get(9)?,
        invoice_no: row.get(10)?,
        estimate_id: row.get(11)?,
        estimate_no: row.get(12)?,
        converted_at: row.get(13)?,
        subtotal_cents: subtotal,
        tax_cents: tax,
        total_cents: subtotal + tax,
        lines: Vec::new(),
    })
}

pub fn list_sales_orders(conn: &Connection) -> Result<Vec<SalesOrder>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_ORDER} ORDER BY o.order_date DESC, o.id DESC"
    ))?;
    let rows = stmt.query_map([], map_order)?;
    let mut records = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for record in &mut records {
        record.lines = lines_of(conn, "sales_order_lines", "order_id", record.id)?;
    }
    Ok(records)
}

pub fn sales_order_by_id(conn: &Connection, id: i64) -> Result<SalesOrder> {
    let mut record = conn
        .prepare(&format!("{SELECT_ORDER} WHERE o.id = ?1"))?
        .query_row([id], map_order)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("sales order {id} does not exist")))?;
    record.lines = lines_of(conn, "sales_order_lines", "order_id", id)?;
    Ok(record)
}

pub fn save_sales_order(conn: &mut Connection, input: &SalesOrderInput) -> Result<SalesOrder> {
    let day = simple::checked_date(&input.order_date, "the order date")?;
    let requested = optional_date(input.requested_date.as_deref(), "the requested date")?;
    let status = normalized_order_status(&input.status)?;
    let tax_bp = simple::checked_tax_rate(input.tax_bp)?;
    let lines = simple::checked_lines(&input.lines)?;
    require_total(totals(&lines, tax_bp), "sales order")?;
    let prefix = series(conn, "sales_order_series", "SO");

    let tx = conn.transaction()?;
    if let Some(id) = input.id {
        let invoiced: Option<i64> = tx
            .query_row("SELECT invoice_id FROM sales_orders WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or_else(|| CoreError::not_found(format!("sales order {id} does not exist")))?;
        if invoiced.is_some() {
            return Err(CoreError::validation(
                "this order has already been invoiced, so its contents are fixed; start a new order if it changed",
            ));
        }
    }

    let number = chosen_number(
        &tx,
        "sales_orders",
        "order_no",
        input.order_no.as_deref(),
        input.id,
        &prefix,
    )?;

    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE sales_orders
                    SET order_no = ?2, customer_id = ?3, order_date = ?4, requested_date = ?5,
                        status = ?6, tax_bp = ?7, notes = ?8
                  WHERE id = ?1",
                params![
                    id,
                    number,
                    input.customer_id,
                    day,
                    requested,
                    status,
                    tax_bp,
                    input.notes.trim()
                ],
            )?;
            tx.execute("DELETE FROM sales_order_lines WHERE order_id = ?1", [id])?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO sales_orders (order_no, customer_id, order_date, requested_date, status, tax_bp, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    number,
                    input.customer_id,
                    day,
                    requested,
                    status,
                    tax_bp,
                    input.notes.trim()
                ],
            )?;
            tx.last_insert_rowid()
        }
    };
    write_lines(&tx, "sales_order_lines", "order_id", id, &lines)?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    sales_order_by_id(conn, id)
}

pub fn delete_sales_order(conn: &mut Connection, id: i64) -> Result<()> {
    let invoiced: Option<i64> = conn
        .query_row("SELECT invoice_id FROM sales_orders WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("sales order {id} does not exist")))?;
    if invoiced.is_some() {
        return Err(CoreError::validation(
            "this order has already been invoiced, so it stays on file",
        ));
    }
    let tx = conn.transaction()?;
    // A quote that pointed at this order keeps its own history but loses the link.
    tx.execute(
        "UPDATE estimates SET converted_order_id = NULL WHERE converted_order_id = ?1",
        [id],
    )?;
    tx.execute("DELETE FROM sales_order_lines WHERE order_id = ?1", [id])?;
    tx.execute("DELETE FROM sales_orders WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Turning one document into the next
// ---------------------------------------------------------------------------

fn invoice_input(
    customer_id: Option<i64>,
    date: &str,
    tax_bp: i64,
    lines: &[PipelineLine],
    memo: &str,
) -> InvoiceInput {
    InvoiceInput {
        id: None,
        invoice_no: None,
        customer_id,
        invoice_date: date.to_string(),
        due_date: None,
        status: "Draft".to_string(),
        tax_bp,
        lines: lines
            .iter()
            .map(|line| InvoiceLineInput {
                description: if line.description.trim().is_empty() {
                    memo.to_string()
                } else {
                    line.description.clone()
                },
                qty_hundredths: line.qty_hundredths,
                unit_price_cents: line.unit_price_cents,
                inventory_item_id: line.inventory_item_id,
            })
            .collect(),
    }
}

/// An estimate becomes a sales order. The quote keeps its number and status
/// history; the order is the confirmation that came back from the customer.
pub fn convert_estimate_to_order(
    conn: &mut Connection,
    estimate_id: i64,
    order_date: Option<&str>,
) -> Result<SalesOrder> {
    let estimate = estimate_by_id(conn, estimate_id)?;
    if estimate.converted_at.is_some() {
        return Err(CoreError::validation(format!(
            "{} has already become {}, so it cannot be converted again",
            estimate.estimate_no,
            estimate
                .invoice_no
                .or(estimate.order_no)
                .unwrap_or_else(|| "another document".to_string())
        )));
    }
    if estimate.status == ESTIMATE_DECLINED || estimate.status == ESTIMATE_EXPIRED {
        return Err(CoreError::validation(format!(
            "{} is {}, so it cannot become an order",
            estimate.estimate_no, estimate.status
        )));
    }
    let day = match order_date {
        Some(value) if !value.trim().is_empty() => simple::checked_date(value, "the order date")?,
        _ => today(conn)?,
    };
    let input = SalesOrderInput {
        id: None,
        order_no: None,
        customer_id: estimate.customer_id,
        order_date: day,
        requested_date: estimate.expiry_date.clone(),
        status: ORDER_CONFIRMED.to_string(),
        tax_bp: estimate.tax_bp,
        notes: estimate.notes.clone(),
        lines: estimate
            .lines
            .iter()
            .map(|line| InvoiceLineInput {
                description: line.description.clone(),
                qty_hundredths: line.qty_hundredths,
                unit_price_cents: line.unit_price_cents,
                inventory_item_id: line.inventory_item_id,
            })
            .collect(),
    };

    let tx = conn.transaction()?;
    let order_id = write_order(&tx, &input)?;
    tx.execute(
        "UPDATE estimates
            SET converted_order_id = ?2,
                converted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                status = ?3
          WHERE id = ?1",
        params![estimate_id, order_id, ESTIMATE_ACCEPTED],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    sales_order_by_id(conn, order_id)
}

/// An estimate can go straight to an invoice when the customer simply says yes.
pub fn convert_estimate_to_invoice(
    conn: &mut Connection,
    estimate_id: i64,
    invoice_date: Option<&str>,
) -> Result<simple::Invoice> {
    let estimate = estimate_by_id(conn, estimate_id)?;
    if estimate.converted_invoice_id.is_some() {
        return Err(CoreError::validation(format!(
            "{} has already been invoiced as {}",
            estimate.estimate_no,
            estimate.invoice_no.unwrap_or_default()
        )));
    }
    if estimate.status == ESTIMATE_DECLINED || estimate.status == ESTIMATE_EXPIRED {
        return Err(CoreError::validation(format!(
            "{} is {}, so it cannot be invoiced",
            estimate.estimate_no, estimate.status
        )));
    }
    let day = match invoice_date {
        Some(value) if !value.trim().is_empty() => simple::checked_date(value, "the invoice date")?,
        _ => today(conn)?,
    };
    let input = invoice_input(
        estimate.customer_id,
        &day,
        estimate.tax_bp,
        &estimate.lines,
        &estimate.estimate_no,
    );

    let accounts = simple::invoice_accounts(conn)?;
    let tx = conn.transaction()?;
    let invoice_id = simple::save_invoice_tx(&tx, &accounts, &input)?;
    tx.execute(
        "UPDATE estimates
            SET converted_invoice_id = ?2,
                converted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                status = ?3
          WHERE id = ?1",
        params![estimate_id, invoice_id, ESTIMATE_ACCEPTED],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    simple::get_invoice(conn, invoice_id)
}

/// A confirmed order becomes the bill for what was ordered.
pub fn convert_order_to_invoice(
    conn: &mut Connection,
    order_id: i64,
    invoice_date: Option<&str>,
) -> Result<simple::Invoice> {
    let order = sales_order_by_id(conn, order_id)?;
    if order.invoice_id.is_some() {
        return Err(CoreError::validation(format!(
            "{} has already been invoiced as {}",
            order.order_no,
            order.invoice_no.unwrap_or_default()
        )));
    }
    if order.status == ORDER_CANCELLED {
        return Err(CoreError::validation(format!(
            "{} is cancelled, so it cannot be invoiced",
            order.order_no
        )));
    }
    let day = match invoice_date {
        Some(value) if !value.trim().is_empty() => simple::checked_date(value, "the invoice date")?,
        _ => today(conn)?,
    };
    let input = invoice_input(
        order.customer_id,
        &day,
        order.tax_bp,
        &order.lines,
        &order.order_no,
    );

    let accounts = simple::invoice_accounts(conn)?;
    let tx = conn.transaction()?;
    let invoice_id = simple::save_invoice_tx(&tx, &accounts, &input)?;
    tx.execute(
        "UPDATE sales_orders
            SET invoice_id = ?2,
                converted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                status = CASE WHEN status = ?3 THEN status ELSE ?4 END
          WHERE id = ?1",
        params![order_id, invoice_id, ORDER_CANCELLED, ORDER_FULFILLED],
    )?;
    // The quote that started this chain shows the invoice number too.
    tx.execute(
        "UPDATE estimates SET converted_invoice_id = ?1 WHERE converted_order_id = ?2",
        params![invoice_id, order_id],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    simple::get_invoice(conn, invoice_id)
}

/// Insert a sales order inside a transaction the caller already owns.
fn write_order(conn: &Connection, input: &SalesOrderInput) -> Result<i64> {
    let day = simple::checked_date(&input.order_date, "the order date")?;
    let requested = optional_date(input.requested_date.as_deref(), "the requested date")?;
    let status = normalized_order_status(&input.status)?;
    let prefix = series(conn, "sales_order_series", "SO");
    let number = chosen_number(conn, "sales_orders", "order_no", None, None, &prefix)?;
    conn.execute(
        "INSERT INTO sales_orders (order_no, customer_id, order_date, requested_date, status, tax_bp, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            number,
            input.customer_id,
            day,
            requested,
            status,
            simple::checked_tax_rate(input.tax_bp)?,
            input.notes.trim()
        ],
    )?;
    let id = conn.last_insert_rowid();
    write_lines(conn, "sales_order_lines", "order_id", id, &input.lines)?;
    Ok(id)
}
