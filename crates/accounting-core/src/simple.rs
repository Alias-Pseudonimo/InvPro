//! The plain-language record layer.
//!
//! Everything in this module is aimed at a business owner, not an accountant.
//! The owner records income, an expense, a purchase, an invoice or a pay run in
//! the words they already use. Each of those records posts a balanced journal
//! entry behind the scenes, so the ledger, the trial balance and the audit trail
//! stay complete without ever asking the owner to think in debits and credits.
//!
//! Two deliberate choices keep that simplicity from becoming a cage:
//!
//! * **Categories are free text.** Typing a category that does not exist yet
//!   creates a matching account on the spot. Nothing has to be set up first, and
//!   the chart of accounts grows with the way the owner actually describes their
//!   business.
//! * **Account roles are data, not code.** Which account is "cash", which is
//!   "receivables", which collects sales tax — all live in `settings` as account
//!   ids, so the owner can point them anywhere and the postings follow.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::accounts::{self, AccountInput, AccountType};
use crate::journal::{self, EntrySource, JournalEntryInput, JournalLineInput};
use crate::{audit, money, CoreError, Result};

// ---------------------------------------------------------------------------
// Account roles. Stored in `settings` as account ids.
// ---------------------------------------------------------------------------

const ROLE_CASH: &str = "cash_account";
const ROLE_RECEIVABLE: &str = "receivable_account";
const ROLE_PAYABLE: &str = "payable_account";
const ROLE_TAX: &str = "sales_tax_account";
const ROLE_INVENTORY: &str = "inventory_account";
const ROLE_COGS: &str = "cogs_account";
const ROLE_PAYROLL_EXPENSE: &str = "payroll_expense_account";
const ROLE_PAYROLL_LIABILITY: &str = "payroll_liability_account";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn required_text(value: &str, what: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CoreError::validation(format!("{what} is required")));
    }
    Ok(trimmed.to_string())
}

fn checked_date(value: &str, what: &str) -> Result<String> {
    if !journal::is_valid_date(value) {
        return Err(CoreError::validation(format!(
            "{what} must be a real date in YYYY-MM-DD form"
        )));
    }
    Ok(value.to_string())
}

fn checked_tax_rate(tax_bp: i64) -> Result<i64> {
    if !(0..=10_000).contains(&tax_bp) {
        return Err(CoreError::validation(
            "a tax rate must be between 0 and 100 percent",
        ));
    }
    Ok(tax_bp)
}

/// Tax on an amount, in cents, rounded half-up. Rates are basis points so 8.5%
/// is 850 and nothing is ever stored as a float.
pub fn tax_of(amount_cents: i64, tax_bp: i64) -> i64 {
    if amount_cents <= 0 || tax_bp <= 0 {
        return 0;
    }
    ((amount_cents as i128 * tax_bp as i128 + 5_000) / 10_000) as i64
}

/// Line value for a quantity held in hundredths. 1.5 × $12.00 is 1800 cents.
pub fn line_total(qty_hundredths: i64, unit_cents: i64) -> i64 {
    if qty_hundredths <= 0 || unit_cents <= 0 {
        return 0;
    }
    ((qty_hundredths as i128 * unit_cents as i128 + 50) / 100) as i64
}

fn setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub value: String,
}

pub fn settings(conn: &Connection) -> Result<Vec<Setting>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = stmt.query_map([], |row| {
        Ok(Setting {
            key: row.get(0)?,
            value: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn put_setting(conn: &mut Connection, key: &str, value: &str) -> Result<()> {
    let key = required_text(key, "a setting name")?;
    let tx = conn.transaction()?;
    write_setting(&tx, &key, value.trim())?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts: resolved by role, created on demand
// ---------------------------------------------------------------------------

fn ensure_account(
    conn: &mut Connection,
    number: &str,
    name: &str,
    account_type: AccountType,
    subtype: &str,
) -> Result<i64> {
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM accounts WHERE number = ?1",
            [number],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM accounts WHERE lower(name) = lower(?1) AND type = ?2 AND is_active = 1",
            params![name, account_type.code()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let number = free_number(conn, number, 100)?;
    let created = accounts::create(
        conn,
        &AccountInput {
            number,
            name: name.to_string(),
            account_type,
            subtype: Some(subtype.to_string()),
            parent_id: None,
            currency: None,
            description: None,
        },
    )?;
    Ok(created.id)
}

/// The first free number at or above `start`, stepping by 10.
fn free_number(conn: &Connection, start: &str, step: i64) -> Result<String> {
    let base: i64 = start.parse().unwrap_or(9000);
    let mut candidate = base;
    for _ in 0..500 {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM accounts WHERE number = ?1",
                [candidate.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Ok(candidate.to_string());
        }
        candidate += step;
    }
    Err(CoreError::validation(
        "there is no free account number left in this range",
    ))
}

fn role_account(
    conn: &mut Connection,
    role: &str,
    number: &str,
    name: &str,
    account_type: AccountType,
    subtype: &str,
) -> Result<i64> {
    if let Some(raw) = setting(conn, role)? {
        if let Ok(id) = raw.parse::<i64>() {
            let active: Option<i64> = conn
                .query_row(
                    "SELECT id FROM accounts WHERE id = ?1 AND is_active = 1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            if active.is_some() {
                return Ok(id);
            }
        }
    }
    let id = ensure_account(conn, number, name, account_type, subtype)?;
    write_setting(conn, role, &id.to_string())?;
    Ok(id)
}

fn cash_account(conn: &mut Connection) -> Result<i64> {
    role_account(conn, ROLE_CASH, "1000", "Checking", AccountType::Asset, "Bank")
}

fn receivable_account(conn: &mut Connection) -> Result<i64> {
    role_account(
        conn,
        ROLE_RECEIVABLE,
        "1100",
        "Accounts Receivable",
        AccountType::Asset,
        "Accounts Receivable",
    )
}

fn payable_account(conn: &mut Connection) -> Result<i64> {
    role_account(
        conn,
        ROLE_PAYABLE,
        "2000",
        "Accounts Payable",
        AccountType::Liability,
        "Accounts Payable",
    )
}

fn tax_account(conn: &mut Connection) -> Result<i64> {
    role_account(
        conn,
        ROLE_TAX,
        "2200",
        "Sales Tax Payable",
        AccountType::Liability,
        "Other Current Liability",
    )
}

fn inventory_account(conn: &mut Connection) -> Result<i64> {
    role_account(
        conn,
        ROLE_INVENTORY,
        "1200",
        "Inventory",
        AccountType::Asset,
        "Inventory",
    )
}

fn cogs_account(conn: &mut Connection) -> Result<i64> {
    role_account(
        conn,
        ROLE_COGS,
        "5000",
        "Cost of Goods Sold",
        AccountType::Cogs,
        "Cost of Goods Sold",
    )
}

/// Find (or create) the account behind a category the owner typed.
fn category_account(
    conn: &mut Connection,
    category: &str,
    account_type: AccountType,
) -> Result<(i64, String)> {
    let name = if category.trim().is_empty() {
        "Uncategorized".to_string()
    } else {
        category.trim().to_string()
    };

    let existing: Option<(i64, String)> = match account_type {
        AccountType::Income => conn
            .query_row(
                "SELECT id, name FROM accounts
                  WHERE lower(name) = lower(?1) AND is_active = 1
                    AND type IN ('INCOME', 'OTHER_INCOME')",
                [&name],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
        AccountType::Expense => conn
            .query_row(
                "SELECT id, name FROM accounts
                  WHERE lower(name) = lower(?1) AND is_active = 1
                    AND type IN ('EXPENSE', 'COGS', 'OTHER_EXPENSE')",
                [&name],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
        other => conn
            .query_row(
                "SELECT id, name FROM accounts
                  WHERE lower(name) = lower(?1) AND is_active = 1 AND type = ?2",
                params![name, other.code()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
    };
    if let Some((id, stored_name)) = existing {
        return Ok((id, stored_name));
    }

    // A new category becomes a real account, numbered after its siblings.
    let (floor, ceiling) = match account_type {
        AccountType::Income => ("4100", "4890"),
        AccountType::Expense => ("6100", "6890"),
        _ => ("9000", "9890"),
    };
    let max: i64 = conn.query_row(
        "SELECT COALESCE(MAX(CAST(number AS INTEGER)), 0) FROM accounts
          WHERE CAST(number AS INTEGER) BETWEEN ?1 AND ?2",
        params![floor.parse::<i64>().unwrap_or(9000), ceiling.parse::<i64>().unwrap_or(9890)],
        |row| row.get(0),
    )?;
    let next = free_number(conn, &(max.max(floor.parse::<i64>().unwrap_or(9000) - 10) + 10).to_string(), 10)?;
    let created = accounts::create(
        conn,
        &AccountInput {
            number: next,
            name: name.clone(),
            account_type,
            subtype: Some("Custom".to_string()),
            parent_id: None,
            currency: None,
            description: Some("Created automatically from a category you typed".to_string()),
        },
    )?;
    Ok((created.id, name))
}

// ---------------------------------------------------------------------------
// Posting helper
// ---------------------------------------------------------------------------

fn line(account_id: i64, debit_cents: i64, credit_cents: i64) -> JournalLineInput {
    JournalLineInput {
        account_id,
        debit_cents,
        credit_cents,
        memo: None,
    }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub address: String,
    pub notes: String,
    pub is_active: bool,
    pub billed_cents: i64,
    pub outstanding_cents: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyInput {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub notes: String,
}

const SELECT_CUSTOMER: &str = r#"
SELECT c.id, c.name, c.email, c.phone, c.address, c.notes, c.is_active,
       COALESCE((SELECT SUM(i.amount_cents + (i.amount_cents * i.tax_bp + 5000) / 10000)
                   FROM income_records i WHERE i.customer_id = c.id), 0),
       COALESCE((SELECT SUM(i.amount_cents + (i.amount_cents * i.tax_bp + 5000) / 10000)
                   FROM income_records i
                  WHERE i.customer_id = c.id AND i.is_paid = 0), 0)
FROM customers c
"#;

fn map_customer(row: &rusqlite::Row<'_>) -> rusqlite::Result<Customer> {
    Ok(Customer {
        id: row.get(0)?,
        name: row.get(1)?,
        email: row.get(2)?,
        phone: row.get(3)?,
        address: row.get(4)?,
        notes: row.get(5)?,
        is_active: row.get::<_, i64>(6)? != 0,
        billed_cents: row.get(7)?,
        outstanding_cents: row.get(8)?,
    })
}

pub fn list_customers(conn: &Connection) -> Result<Vec<Customer>> {
    let mut stmt = conn.prepare(&format!("{SELECT_CUSTOMER} ORDER BY lower(c.name)"))?;
    let rows = stmt.query_map([], map_customer)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn customer_by_id(conn: &Connection, id: i64) -> Result<Customer> {
    conn.prepare(&format!("{SELECT_CUSTOMER} WHERE c.id = ?1"))?
        .query_row([id], map_customer)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("customer {id} does not exist")))
}

pub fn save_customer(conn: &mut Connection, input: &PartyInput) -> Result<Customer> {
    let name = required_text(&input.name, "a customer name")?;
    let tx = conn.transaction()?;
    let id = match input.id {
        Some(id) => {
            let changed = tx.execute(
                "UPDATE customers SET name = ?2, email = ?3, phone = ?4, address = ?5, notes = ?6
                  WHERE id = ?1",
                params![id, name, input.email.trim(), input.phone.trim(), input.address.trim(), input.notes.trim()],
            )?;
            if changed == 0 {
                return Err(CoreError::not_found(format!("customer {id} does not exist")));
            }
            id
        }
        None => {
            tx.execute(
                "INSERT INTO customers (name, email, phone, address, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![name, input.email.trim(), input.phone.trim(), input.address.trim(), input.notes.trim()],
            )?;
            tx.last_insert_rowid()
        }
    };
    audit::seal_pending(&tx)?;
    tx.commit()?;
    customer_by_id(conn, id)
}

pub fn delete_customer(conn: &mut Connection, id: i64) -> Result<()> {
    let used: i64 = conn.query_row(
        "SELECT COUNT(*) FROM income_records WHERE customer_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    if used > 0 {
        return Err(CoreError::validation(
            "this customer already has income recorded against them; deactivate them instead so the history stays intact",
        ));
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM customers WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vendor {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub address: String,
    pub notes: String,
    pub is_active: bool,
    pub spent_cents: i64,
    pub outstanding_cents: i64,
}

const SELECT_VENDOR: &str = r#"
SELECT v.id, v.name, v.email, v.phone, v.address, v.notes, v.is_active,
       COALESCE((SELECT SUM(e.amount_cents + (e.amount_cents * e.tax_bp + 5000) / 10000)
                   FROM expense_records e WHERE e.vendor_id = v.id), 0),
       COALESCE((SELECT SUM(e.amount_cents + (e.amount_cents * e.tax_bp + 5000) / 10000)
                   FROM expense_records e
                  WHERE e.vendor_id = v.id AND e.is_paid = 0), 0)
FROM vendors v
"#;

fn map_vendor(row: &rusqlite::Row<'_>) -> rusqlite::Result<Vendor> {
    Ok(Vendor {
        id: row.get(0)?,
        name: row.get(1)?,
        email: row.get(2)?,
        phone: row.get(3)?,
        address: row.get(4)?,
        notes: row.get(5)?,
        is_active: row.get::<_, i64>(6)? != 0,
        spent_cents: row.get(7)?,
        outstanding_cents: row.get(8)?,
    })
}

pub fn list_vendors(conn: &Connection) -> Result<Vec<Vendor>> {
    let mut stmt = conn.prepare(&format!("{SELECT_VENDOR} ORDER BY lower(v.name)"))?;
    let rows = stmt.query_map([], map_vendor)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn vendor_by_id(conn: &Connection, id: i64) -> Result<Vendor> {
    conn.prepare(&format!("{SELECT_VENDOR} WHERE v.id = ?1"))?
        .query_row([id], map_vendor)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("vendor {id} does not exist")))
}

pub fn save_vendor(conn: &mut Connection, input: &PartyInput) -> Result<Vendor> {
    let name = required_text(&input.name, "a vendor name")?;
    let tx = conn.transaction()?;
    let id = match input.id {
        Some(id) => {
            let changed = tx.execute(
                "UPDATE vendors SET name = ?2, email = ?3, phone = ?4, address = ?5, notes = ?6
                  WHERE id = ?1",
                params![id, name, input.email.trim(), input.phone.trim(), input.address.trim(), input.notes.trim()],
            )?;
            if changed == 0 {
                return Err(CoreError::not_found(format!("vendor {id} does not exist")));
            }
            id
        }
        None => {
            tx.execute(
                "INSERT INTO vendors (name, email, phone, address, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![name, input.email.trim(), input.phone.trim(), input.address.trim(), input.notes.trim()],
            )?;
            tx.last_insert_rowid()
        }
    };
    audit::seal_pending(&tx)?;
    tx.commit()?;
    vendor_by_id(conn, id)
}

pub fn delete_vendor(conn: &mut Connection, id: i64) -> Result<()> {
    let used: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM expense_records WHERE vendor_id = ?1)
              + (SELECT COUNT(*) FROM purchases WHERE vendor_id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if used > 0 {
        return Err(CoreError::validation(
            "this vendor already has spending recorded against them; deactivate them instead so the history stays intact",
        ));
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM vendors WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    pub id: i64,
    pub name: String,
    pub sku: String,
    pub barcode: String,
    pub category: String,
    pub kind: String,
    pub qty_hundredths: i64,
    pub unit_cost_cents: i64,
    pub sale_price_cents: i64,
    pub is_active: bool,
    pub stock_value_cents: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryInput {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub sku: String,
    #[serde(default)]
    pub barcode: String,
    #[serde(default)]
    pub category: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub qty_hundredths: i64,
    #[serde(default)]
    pub unit_cost_cents: i64,
    #[serde(default)]
    pub sale_price_cents: i64,
}

fn default_kind() -> String {
    "Product".to_string()
}

fn map_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<InventoryItem> {
    let qty: i64 = row.get(6)?;
    let cost: i64 = row.get(7)?;
    Ok(InventoryItem {
        id: row.get(0)?,
        name: row.get(1)?,
        sku: row.get(2)?,
        barcode: row.get(3)?,
        category: row.get(4)?,
        kind: row.get(5)?,
        qty_hundredths: qty,
        unit_cost_cents: cost,
        sale_price_cents: row.get(8)?,
        is_active: row.get::<_, i64>(9)? != 0,
        stock_value_cents: line_total(qty, cost),
    })
}

const SELECT_ITEM: &str = r#"
SELECT id, name, sku, barcode, category, kind, qty_hundredths, unit_cost_cents,
       sale_price_cents, is_active
FROM inventory_items
"#;

pub fn list_inventory(conn: &Connection) -> Result<Vec<InventoryItem>> {
    let mut stmt = conn.prepare(&format!("{SELECT_ITEM} ORDER BY lower(name)"))?;
    let rows = stmt.query_map([], map_item)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn save_inventory_item(conn: &mut Connection, input: &InventoryInput) -> Result<InventoryItem> {
    let name = required_text(&input.name, "an item name")?;
    let kind = match input.kind.trim() {
        "" => "Product".to_string(),
        other => other.to_string(),
    };
    if !matches!(kind.as_str(), "Product" | "Consumable" | "Service") {
        return Err(CoreError::validation(
            "an item is a Product, a Consumable or a Service",
        ));
    }
    if input.qty_hundredths < 0 || input.unit_cost_cents < 0 || input.sale_price_cents < 0 {
        return Err(CoreError::validation("quantities and prices cannot be negative"));
    }
    let tx = conn.transaction()?;
    let id = match input.id {
        Some(id) => {
            let changed = tx.execute(
                "UPDATE inventory_items
                    SET name = ?2, sku = ?3, barcode = ?4, category = ?5, kind = ?6,
                        qty_hundredths = ?7, unit_cost_cents = ?8, sale_price_cents = ?9
                  WHERE id = ?1",
                params![
                    id,
                    name,
                    input.sku.trim(),
                    input.barcode.trim(),
                    input.category.trim(),
                    kind,
                    input.qty_hundredths,
                    input.unit_cost_cents,
                    input.sale_price_cents
                ],
            )?;
            if changed == 0 {
                return Err(CoreError::not_found(format!("item {id} does not exist")));
            }
            id
        }
        None => {
            tx.execute(
                "INSERT INTO inventory_items
                    (name, sku, barcode, category, kind, qty_hundredths, unit_cost_cents, sale_price_cents)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    name,
                    input.sku.trim(),
                    input.barcode.trim(),
                    input.category.trim(),
                    kind,
                    input.qty_hundredths,
                    input.unit_cost_cents,
                    input.sale_price_cents
                ],
            )?;
            tx.last_insert_rowid()
        }
    };
    audit::seal_pending(&tx)?;
    tx.commit()?;
    item_by_id(conn, id)
}

pub fn item_by_id(conn: &Connection, id: i64) -> Result<InventoryItem> {
    conn.prepare(&format!("{SELECT_ITEM} WHERE id = ?1"))?
        .query_row([id], map_item)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("item {id} does not exist")))
}

pub fn delete_inventory_item(conn: &mut Connection, id: i64) -> Result<()> {
    let used: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM invoice_lines WHERE inventory_item_id = ?1)
              + (SELECT COUNT(*) FROM purchase_lines WHERE inventory_item_id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if used > 0 {
        return Err(CoreError::validation(
            "this item appears on invoices or purchases; set its quantity to zero instead of deleting it",
        ));
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM inventory_items WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Move stock in at a weighted-average cost.
fn stock_in(conn: &Connection, item_id: i64, qty: i64, cost_cents: i64, sale_price_cents: i64) -> Result<()> {
    let (existing_qty, existing_cost): (i64, i64) = conn.query_row(
        "SELECT qty_hundredths, unit_cost_cents FROM inventory_items WHERE id = ?1",
        [item_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let total = existing_qty + qty;
    let new_cost = if total > 0 {
        ((existing_qty as i128 * existing_cost as i128 + qty as i128 * cost_cents as i128) / total as i128) as i64
    } else {
        cost_cents
    };
    conn.execute(
        "UPDATE inventory_items
            SET qty_hundredths = ?2,
                unit_cost_cents = ?3,
                sale_price_cents = CASE WHEN ?4 > 0 THEN ?4 ELSE sale_price_cents END
          WHERE id = ?1",
        params![item_id, total, new_cost, sale_price_cents],
    )?;
    Ok(())
}

/// Undo a stock-in when a purchase is edited or deleted. Weighted average cannot
/// be un-mixed perfectly once later movements exist; this is the best honest
/// approximation and it is documented in the UI.
fn stock_in_reverse(conn: &Connection, item_id: i64, qty: i64, cost_cents: i64) -> Result<()> {
    let (existing_qty, existing_cost): (i64, i64) = conn.query_row(
        "SELECT qty_hundredths, unit_cost_cents FROM inventory_items WHERE id = ?1",
        [item_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let remaining = (existing_qty - qty).max(0);
    let new_cost = if remaining > 0 && existing_qty > 0 {
        (((existing_qty as i128 * existing_cost as i128) - (qty as i128 * cost_cents as i128)) / remaining as i128)
            .max(0) as i64
    } else {
        existing_cost
    };
    conn.execute(
        "UPDATE inventory_items SET qty_hundredths = ?2, unit_cost_cents = ?3 WHERE id = ?1",
        params![item_id, remaining, new_cost],
    )?;
    Ok(())
}

fn adjust_stock(conn: &Connection, item_id: i64, delta: i64) -> Result<()> {
    conn.execute(
        "UPDATE inventory_items
            SET qty_hundredths = MAX(0, qty_hundredths + ?2)
          WHERE id = ?1",
        params![item_id, delta],
    )?;
    Ok(())
}

fn item_cost(conn: &Connection, item_id: i64) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT unit_cost_cents FROM inventory_items WHERE id = ?1",
            [item_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0))
}

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeInput {
    pub id: Option<i64>,
    pub entry_date: String,
    pub customer_id: Option<i64>,
    pub category: String,
    #[serde(default)]
    pub description: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub tax_bp: i64,
    #[serde(default)]
    pub is_paid: bool,
    #[serde(default)]
    pub invoice_no: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeRecord {
    pub id: i64,
    pub entry_date: String,
    pub customer_id: Option<i64>,
    pub customer_name: String,
    pub category: String,
    pub description: String,
    pub amount_cents: i64,
    pub tax_bp: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    pub is_paid: bool,
    pub invoice_no: String,
    pub journal_entry_id: Option<i64>,
}

const SELECT_INCOME: &str = r#"
SELECT i.id, i.entry_date, i.customer_id, COALESCE(c.name, ''),
       i.category, i.description, i.amount_cents, i.tax_bp,
       (i.amount_cents * i.tax_bp + 5000) / 10000,
       i.is_paid, i.invoice_no, i.journal_entry_id
FROM income_records i
LEFT JOIN customers c ON c.id = i.customer_id
"#;

fn map_income(row: &rusqlite::Row<'_>) -> rusqlite::Result<IncomeRecord> {
    let amount: i64 = row.get(6)?;
    let tax: i64 = row.get(8)?;
    Ok(IncomeRecord {
        id: row.get(0)?,
        entry_date: row.get(1)?,
        customer_id: row.get(2)?,
        customer_name: row.get(3)?,
        category: row.get(4)?,
        description: row.get(5)?,
        amount_cents: amount,
        tax_bp: row.get(7)?,
        tax_cents: tax,
        total_cents: amount + tax,
        is_paid: row.get::<_, i64>(9)? != 0,
        invoice_no: row.get(10)?,
        journal_entry_id: row.get(11)?,
    })
}

pub fn list_income(conn: &Connection) -> Result<Vec<IncomeRecord>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_INCOME} ORDER BY i.entry_date DESC, i.id DESC"
    ))?;
    let rows = stmt.query_map([], map_income)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn income_by_id(conn: &Connection, id: i64) -> Result<IncomeRecord> {
    conn.prepare(&format!("{SELECT_INCOME} WHERE i.id = ?1"))?
        .query_row([id], map_income)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("income record {id} does not exist")))
}

pub fn save_income(conn: &mut Connection, input: &IncomeInput) -> Result<IncomeRecord> {
    let day = checked_date(&input.entry_date, "the date")?;
    if input.amount_cents <= 0 {
        return Err(CoreError::validation("enter an amount greater than zero"));
    }
    let tax_bp = checked_tax_rate(input.tax_bp)?;
    let category = required_text(&input.category, "a category")?;

    let (category_id, _) = category_account(conn, &category, AccountType::Income)?;
    let cash = cash_account(conn)?;
    let receivable = receivable_account(conn)?;
    let tax_account_id = tax_account(conn)?;
    let tax = tax_of(input.amount_cents, tax_bp);
    let total = input.amount_cents + tax;

    let mut lines = vec![line(
        if input.is_paid { cash } else { receivable },
        total,
        0,
    )];
    lines.push(line(category_id, 0, input.amount_cents));
    if tax > 0 {
        lines.push(line(tax_account_id, 0, tax));
    }

    let memo = match input.description.trim() {
        "" => category.clone(),
        text => format!("{category} — {text}"),
    };
    let entry = JournalEntryInput {
        entry_date: day.clone(),
        memo,
        reference: Some(input.invoice_no.trim().to_string()).filter(|value| !value.is_empty()),
        source: EntrySource::Payment,
        lines,
    };

    let tx = conn.transaction()?;
    if let Some(id) = input.id {
        let previous: Option<Option<i64>> = tx
            .query_row(
                "SELECT journal_entry_id FROM income_records WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match previous {
            None => return Err(CoreError::not_found(format!("income record {id} does not exist"))),
            Some(entry_id) => {
                if let Some(entry_id) = entry_id {
                    journal::void_in(&tx, entry_id)?;
                }
            }
        }
    }

    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE income_records
                    SET entry_date = ?2, customer_id = ?3, category = ?4, account_id = ?5,
                        description = ?6, amount_cents = ?7, tax_bp = ?8, is_paid = ?9,
                        invoice_no = ?10, journal_entry_id = NULL
                  WHERE id = ?1",
                params![
                    id,
                    day,
                    input.customer_id,
                    category,
                    category_id,
                    input.description.trim(),
                    input.amount_cents,
                    tax_bp,
                    input.is_paid as i64,
                    input.invoice_no.trim()
                ],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO income_records
                    (entry_date, customer_id, category, account_id, description,
                     amount_cents, tax_bp, is_paid, invoice_no)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    day,
                    input.customer_id,
                    category,
                    category_id,
                    input.description.trim(),
                    input.amount_cents,
                    tax_bp,
                    input.is_paid as i64,
                    input.invoice_no.trim()
                ],
            )?;
            tx.last_insert_rowid()
        }
    };

    let posted = journal::post_in(&tx, &entry)?;
    tx.execute(
        "UPDATE income_records SET journal_entry_id = ?2 WHERE id = ?1",
        params![id, posted.summary.id],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    income_by_id(conn, id)
}

pub fn delete_income(conn: &mut Connection, id: i64) -> Result<()> {
    let entry_id: Option<i64> = conn
        .query_row(
            "SELECT journal_entry_id FROM income_records WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("income record {id} does not exist")))?;
    let tx = conn.transaction()?;
    if let Some(entry_id) = entry_id {
        journal::void_in(&tx, entry_id)?;
    }
    tx.execute("DELETE FROM income_records WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseInput {
    pub id: Option<i64>,
    pub entry_date: String,
    pub vendor_id: Option<i64>,
    pub category: String,
    #[serde(default)]
    pub description: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub tax_bp: i64,
    #[serde(default)]
    pub is_paid: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseRecord {
    pub id: i64,
    pub entry_date: String,
    pub vendor_id: Option<i64>,
    pub vendor_name: String,
    pub category: String,
    pub description: String,
    pub amount_cents: i64,
    pub tax_bp: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    pub is_paid: bool,
    pub journal_entry_id: Option<i64>,
}

const SELECT_EXPENSE: &str = r#"
SELECT e.id, e.entry_date, e.vendor_id, COALESCE(v.name, ''),
       e.category, e.description, e.amount_cents, e.tax_bp,
       (e.amount_cents * e.tax_bp + 5000) / 10000,
       e.is_paid, e.journal_entry_id
FROM expense_records e
LEFT JOIN vendors v ON v.id = e.vendor_id
"#;

fn map_expense(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExpenseRecord> {
    let amount: i64 = row.get(6)?;
    let tax: i64 = row.get(8)?;
    Ok(ExpenseRecord {
        id: row.get(0)?,
        entry_date: row.get(1)?,
        vendor_id: row.get(2)?,
        vendor_name: row.get(3)?,
        category: row.get(4)?,
        description: row.get(5)?,
        amount_cents: amount,
        tax_bp: row.get(7)?,
        tax_cents: tax,
        total_cents: amount + tax,
        is_paid: row.get::<_, i64>(9)? != 0,
        journal_entry_id: row.get(10)?,
    })
}

pub fn list_expenses(conn: &Connection) -> Result<Vec<ExpenseRecord>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_EXPENSE} ORDER BY e.entry_date DESC, e.id DESC"
    ))?;
    let rows = stmt.query_map([], map_expense)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn expense_by_id(conn: &Connection, id: i64) -> Result<ExpenseRecord> {
    conn.prepare(&format!("{SELECT_EXPENSE} WHERE e.id = ?1"))?
        .query_row([id], map_expense)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("expense record {id} does not exist")))
}

pub fn save_expense(conn: &mut Connection, input: &ExpenseInput) -> Result<ExpenseRecord> {
    let day = checked_date(&input.entry_date, "the date")?;
    if input.amount_cents <= 0 {
        return Err(CoreError::validation("enter an amount greater than zero"));
    }
    let tax_bp = checked_tax_rate(input.tax_bp)?;
    let category = required_text(&input.category, "a category")?;

    let (category_id, stored_category) = category_account(conn, &category, AccountType::Expense)?;
    let cash = cash_account(conn)?;
    let payable = payable_account(conn)?;
    let tax = tax_of(input.amount_cents, tax_bp);
    let total = input.amount_cents + tax;

    let lines = vec![
        line(category_id, total, 0),
        line(if input.is_paid { cash } else { payable }, 0, total),
    ];

    let memo = match input.description.trim() {
        "" => stored_category.clone(),
        text => format!("{stored_category} — {text}"),
    };
    let entry = JournalEntryInput {
        entry_date: day.clone(),
        memo,
        reference: None,
        source: EntrySource::Payment,
        lines,
    };

    let tx = conn.transaction()?;
    if let Some(id) = input.id {
        let previous: Option<Option<i64>> = tx
            .query_row(
                "SELECT journal_entry_id FROM expense_records WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match previous {
            None => return Err(CoreError::not_found(format!("expense record {id} does not exist"))),
            Some(entry_id) => {
                if let Some(entry_id) = entry_id {
                    journal::void_in(&tx, entry_id)?;
                }
            }
        }
    }

    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE expense_records
                    SET entry_date = ?2, vendor_id = ?3, category = ?4, account_id = ?5,
                        description = ?6, amount_cents = ?7, tax_bp = ?8, is_paid = ?9,
                        journal_entry_id = NULL
                  WHERE id = ?1",
                params![
                    id,
                    day,
                    input.vendor_id,
                    stored_category,
                    category_id,
                    input.description.trim(),
                    input.amount_cents,
                    tax_bp,
                    input.is_paid as i64
                ],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO expense_records
                    (entry_date, vendor_id, category, account_id, description,
                     amount_cents, tax_bp, is_paid)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    day,
                    input.vendor_id,
                    stored_category,
                    category_id,
                    input.description.trim(),
                    input.amount_cents,
                    tax_bp,
                    input.is_paid as i64
                ],
            )?;
            tx.last_insert_rowid()
        }
    };

    let posted = journal::post_in(&tx, &entry)?;
    tx.execute(
        "UPDATE expense_records SET journal_entry_id = ?2 WHERE id = ?1",
        params![id, posted.summary.id],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    expense_by_id(conn, id)
}

pub fn delete_expense(conn: &mut Connection, id: i64) -> Result<()> {
    let entry_id: Option<i64> = conn
        .query_row(
            "SELECT journal_entry_id FROM expense_records WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("expense record {id} does not exist")))?;
    let tx = conn.transaction()?;
    if let Some(entry_id) = entry_id {
        journal::void_in(&tx, entry_id)?;
    }
    tx.execute("DELETE FROM expense_records WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLineInput {
    #[serde(default)]
    pub description: String,
    #[serde(default = "one_unit")]
    pub qty_hundredths: i64,
    #[serde(default)]
    pub unit_price_cents: i64,
    pub inventory_item_id: Option<i64>,
}

fn one_unit() -> i64 {
    100
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceInput {
    pub id: Option<i64>,
    pub invoice_no: Option<String>,
    pub customer_id: Option<i64>,
    pub invoice_date: String,
    pub due_date: Option<String>,
    #[serde(default = "draft_status")]
    pub status: String,
    #[serde(default)]
    pub tax_bp: i64,
    pub lines: Vec<InvoiceLineInput>,
}

fn draft_status() -> String {
    "Draft".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLine {
    pub id: i64,
    pub position: i64,
    pub description: String,
    pub qty_hundredths: i64,
    pub unit_price_cents: i64,
    pub amount_cents: i64,
    pub inventory_item_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoice {
    pub id: i64,
    pub invoice_no: String,
    pub customer_id: Option<i64>,
    pub customer_name: String,
    pub invoice_date: String,
    pub due_date: Option<String>,
    pub status: String,
    pub tax_bp: i64,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    pub stock_deducted: bool,
    pub lines: Vec<InvoiceLine>,
}

fn normalized_status(status: &str) -> Result<&'static str> {
    match status.trim() {
        "" | "Draft" => Ok("Draft"),
        "Sent" => Ok("Sent"),
        "Paid" => Ok("Paid"),
        other => Err(CoreError::validation(format!(
            "'{other}' is not an invoice status; use Draft, Sent or Paid"
        ))),
    }
}

fn next_invoice_number(conn: &Connection) -> Result<String> {
    let mut stmt = conn.prepare("SELECT invoice_no FROM invoices")?;
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
    Ok(format!("INV-{}", highest + 1))
}

fn invoice_lines_of(conn: &Connection, invoice_id: i64) -> Result<Vec<InvoiceLine>> {
    let mut stmt = conn.prepare(
        "SELECT id, position, description, qty_hundredths, unit_price_cents, inventory_item_id
           FROM invoice_lines WHERE invoice_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map([invoice_id], |row| {
        let qty: i64 = row.get(3)?;
        let price: i64 = row.get(4)?;
        Ok(InvoiceLine {
            id: row.get(0)?,
            position: row.get(1)?,
            description: row.get(2)?,
            qty_hundredths: qty,
            unit_price_cents: price,
            amount_cents: line_total(qty, price),
            inventory_item_id: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn invoice_by_id(conn: &Connection, id: i64) -> Result<Invoice> {
    let (mut invoice, subtotal): (Invoice, i64) = conn
        .prepare(
            "SELECT i.id, i.invoice_no, i.customer_id, COALESCE(c.name, ''), i.invoice_date,
                    i.due_date, i.status, i.tax_bp, i.stock_deducted,
                    COALESCE((SELECT SUM((l.qty_hundredths * l.unit_price_cents + 50) / 100)
                                FROM invoice_lines l WHERE l.invoice_id = i.id), 0)
               FROM invoices i
               LEFT JOIN customers c ON c.id = i.customer_id
              WHERE i.id = ?1",
        )?
        .query_row([id], |row| {
            let tax_bp: i64 = row.get(7)?;
            let subtotal: i64 = row.get(9)?;
            let tax = tax_of(subtotal, tax_bp);
            Ok((
                Invoice {
                    id: row.get(0)?,
                    invoice_no: row.get(1)?,
                    customer_id: row.get(2)?,
                    customer_name: row.get(3)?,
                    invoice_date: row.get(4)?,
                    due_date: row.get(5)?,
                    status: row.get(6)?,
                    tax_bp,
                    subtotal_cents: subtotal,
                    tax_cents: tax,
                    total_cents: subtotal + tax,
                    stock_deducted: row.get::<_, i64>(8)? != 0,
                    lines: Vec::new(),
                },
                subtotal,
            ))
        })
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("invoice {id} does not exist")))?;
    let _ = subtotal;
    invoice.lines = invoice_lines_of(conn, id)?;
    Ok(invoice)
}

pub fn list_invoices(conn: &Connection) -> Result<Vec<Invoice>> {
    let mut ids = Vec::new();
    {
        let mut stmt =
            conn.prepare("SELECT id FROM invoices ORDER BY invoice_date DESC, id DESC")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for id in rows {
            ids.push(id?);
        }
    }
    ids.into_iter().map(|id| invoice_by_id(conn, id)).collect()
}

pub fn get_invoice(conn: &Connection, id: i64) -> Result<Invoice> {
    invoice_by_id(conn, id)
}

pub fn save_invoice(conn: &mut Connection, input: &InvoiceInput) -> Result<Invoice> {
    let day = checked_date(&input.invoice_date, "the invoice date")?;
    let due = match input.due_date.as_deref() {
        Some(value) if !value.trim().is_empty() => Some(checked_date(value, "the due date")?),
        _ => None,
    };
    let status = normalized_status(&input.status)?;
    let tax_bp = checked_tax_rate(input.tax_bp)?;

    let mut lines: Vec<InvoiceLineInput> = Vec::new();
    for (index, line) in input.lines.iter().enumerate() {
        let position = index + 1;
        let is_blank = line.description.trim().is_empty()
            && line.unit_price_cents == 0
            && line.qty_hundredths == 100
            && line.inventory_item_id.is_none();
        if is_blank {
            continue;
        }
        if line.qty_hundredths <= 0 {
            return Err(CoreError::validation(format!(
                "line {position}: the quantity must be greater than zero"
            )));
        }
        if line.unit_price_cents < 0 {
            return Err(CoreError::validation(format!(
                "line {position}: the price cannot be negative"
            )));
        }
        lines.push(line.clone());
    }
    if lines.is_empty() {
        return Err(CoreError::validation("add at least one line to the invoice"));
    }

    let subtotal: i64 = lines
        .iter()
        .map(|line| line_total(line.qty_hundredths, line.unit_price_cents))
        .sum();
    let tax = tax_of(subtotal, tax_bp);
    let total = subtotal + tax;
    if total <= 0 {
        return Err(CoreError::validation("an invoice must be worth more than zero"));
    }

    let cash = cash_account(conn)?;
    let receivable = receivable_account(conn)?;
    let tax_account_id = tax_account(conn)?;
    let inventory = inventory_account(conn)?;
    let cogs = cogs_account(conn)?;
    let income_name = setting(conn, "invoice_income_account")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Sales Revenue".to_string());
    let (income_id, _) = category_account(conn, &income_name, AccountType::Income)?;

    let invoice_no = match input.invoice_no.as_deref() {
        Some(value) if !value.trim().is_empty() => {
            let value = value.trim().to_string();
            let clash: Option<i64> = conn
                .query_row(
                    "SELECT id FROM invoices WHERE invoice_no = ?1 AND id IS NOT ?2",
                    params![value, input.id],
                    |row| row.get(0),
                )
                .optional()?;
            if clash.is_some() {
                return Err(CoreError::validation(format!(
                    "invoice number {value} is already in use"
                )));
            }
            value
        }
        _ => next_invoice_number(conn)?,
    };

    // Previous state, so an edit reverses exactly what it had applied.
    let previous = match input.id {
        Some(id) => {
            let row = conn
                .query_row(
                    "SELECT stock_deducted, ar_entry_id, cash_entry_id, cogs_entry_id
                       FROM invoices WHERE id = ?1",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)? != 0,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| CoreError::not_found(format!("invoice {id} does not exist")))?;
            Some(row)
        }
        None => None,
    };
    let previous_lines = match input.id {
        Some(id) => invoice_lines_of(conn, id)?,
        None => Vec::new(),
    };

    let tx = conn.transaction()?;
    if let Some((stock_deducted, ar, cash_entry, cogs_entry)) = &previous {
        if *stock_deducted {
            for line in &previous_lines {
                if let Some(item_id) = line.inventory_item_id {
                    adjust_stock(&tx, item_id, line.qty_hundredths)?;
                }
            }
        }
        for entry in [*ar, *cash_entry, *cogs_entry].into_iter().flatten() {
            journal::void_in(&tx, entry)?;
        }
    }

    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE invoices
                    SET invoice_no = ?2, customer_id = ?3, invoice_date = ?4, due_date = ?5,
                        status = ?6, tax_bp = ?7, stock_deducted = 0,
                        ar_entry_id = NULL, cash_entry_id = NULL, cogs_entry_id = NULL
                  WHERE id = ?1",
                params![id, invoice_no, input.customer_id, day, due, status, tax_bp],
            )?;
            tx.execute("DELETE FROM invoice_lines WHERE invoice_id = ?1", [id])?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO invoices (invoice_no, customer_id, invoice_date, due_date, status, tax_bp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![invoice_no, input.customer_id, day, due, status, tax_bp],
            )?;
            tx.last_insert_rowid()
        }
    };

    {
        let mut stmt = tx.prepare(
            "INSERT INTO invoice_lines
                (invoice_id, position, description, qty_hundredths, unit_price_cents, inventory_item_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (index, line) in lines.iter().enumerate() {
            stmt.execute(params![
                id,
                (index as i64) + 1,
                line.description.trim(),
                line.qty_hundredths,
                line.unit_price_cents,
                line.inventory_item_id
            ])?;
        }
    }

    let mut ar_entry_id: Option<i64> = None;
    let mut cash_entry_id: Option<i64> = None;
    let mut cogs_entry_id: Option<i64> = None;
    let mut stock_deducted = false;

    if status != "Draft" {
        let mut entry_lines = vec![line(receivable, total, 0)];
        if subtotal > 0 {
            entry_lines.push(line(income_id, 0, subtotal));
        }
        if tax > 0 {
            entry_lines.push(line(tax_account_id, 0, tax));
        }
        let entry = JournalEntryInput {
            entry_date: day.clone(),
            memo: format!("Invoice {invoice_no}"),
            reference: Some(invoice_no.clone()),
            source: EntrySource::Invoice,
            lines: entry_lines,
        };
        ar_entry_id = Some(journal::post_in(&tx, &entry)?.summary.id);

        let mut cogs_total = 0i64;
        for line in &lines {
            if let Some(item_id) = line.inventory_item_id {
                adjust_stock(&tx, item_id, -line.qty_hundredths)?;
                stock_deducted = true;
                cogs_total += line_total(line.qty_hundredths, item_cost(&tx, item_id)?);
            }
        }
        if cogs_total > 0 {
            let entry = JournalEntryInput {
                entry_date: day.clone(),
                memo: format!("Cost of goods sold — invoice {invoice_no}"),
                reference: Some(invoice_no.clone()),
                source: EntrySource::Inventory,
                lines: vec![line(cogs, cogs_total, 0), line(inventory, 0, cogs_total)],
            };
            cogs_entry_id = Some(journal::post_in(&tx, &entry)?.summary.id);
        }
    }

    if status == "Paid" {
        let entry = JournalEntryInput {
            entry_date: day.clone(),
            memo: format!("Payment received — invoice {invoice_no}"),
            reference: Some(invoice_no.clone()),
            source: EntrySource::Payment,
            lines: vec![line(cash, total, 0), line(receivable, 0, total)],
        };
        cash_entry_id = Some(journal::post_in(&tx, &entry)?.summary.id);
    }

    tx.execute(
        "UPDATE invoices
            SET stock_deducted = ?2, ar_entry_id = ?3, cash_entry_id = ?4, cogs_entry_id = ?5
          WHERE id = ?1",
        params![
            id,
            stock_deducted as i64,
            ar_entry_id,
            cash_entry_id,
            cogs_entry_id
        ],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    invoice_by_id(conn, id)
}

pub fn delete_invoice(conn: &mut Connection, id: i64) -> Result<()> {
    let row = conn
        .query_row(
            "SELECT stock_deducted, ar_entry_id, cash_entry_id, cogs_entry_id
               FROM invoices WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? != 0,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("invoice {id} does not exist")))?;
    let lines = invoice_lines_of(conn, id)?;

    let tx = conn.transaction()?;
    if row.0 {
        for line in &lines {
            if let Some(item_id) = line.inventory_item_id {
                adjust_stock(&tx, item_id, line.qty_hundredths)?;
            }
        }
    }
    for entry in [row.1, row.2, row.3].into_iter().flatten() {
        journal::void_in(&tx, entry)?;
    }
    tx.execute("DELETE FROM invoice_lines WHERE invoice_id = ?1", [id])?;
    tx.execute("DELETE FROM invoices WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLineInput {
    #[serde(default)]
    pub description: String,
    #[serde(default = "one_unit")]
    pub qty_hundredths: i64,
    #[serde(default)]
    pub unit_cost_cents: i64,
    #[serde(default)]
    pub sale_price_cents: i64,
    pub inventory_item_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseInput {
    pub id: Option<i64>,
    pub purchase_date: String,
    pub vendor_id: Option<i64>,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub is_paid: bool,
    pub lines: Vec<PurchaseLineInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLine {
    pub id: i64,
    pub position: i64,
    pub description: String,
    pub qty_hundredths: i64,
    pub unit_cost_cents: i64,
    pub sale_price_cents: i64,
    pub amount_cents: i64,
    pub inventory_item_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Purchase {
    pub id: i64,
    pub purchase_date: String,
    pub vendor_id: Option<i64>,
    pub vendor_name: String,
    pub category: String,
    pub note: String,
    pub is_paid: bool,
    pub total_cents: i64,
    pub lines: Vec<PurchaseLine>,
}

fn purchase_lines_of(conn: &Connection, purchase_id: i64) -> Result<Vec<PurchaseLine>> {
    let mut stmt = conn.prepare(
        "SELECT id, position, description, qty_hundredths, unit_cost_cents, sale_price_cents,
                inventory_item_id
           FROM purchase_lines WHERE purchase_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map([purchase_id], |row| {
        let qty: i64 = row.get(3)?;
        let cost: i64 = row.get(4)?;
        Ok(PurchaseLine {
            id: row.get(0)?,
            position: row.get(1)?,
            description: row.get(2)?,
            qty_hundredths: qty,
            unit_cost_cents: cost,
            sale_price_cents: row.get(5)?,
            amount_cents: line_total(qty, cost),
            inventory_item_id: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn purchase_by_id(conn: &Connection, id: i64) -> Result<Purchase> {
    let mut purchase = conn
        .prepare(
            "SELECT p.id, p.purchase_date, p.vendor_id, COALESCE(v.name, ''), p.category, p.note,
                    p.is_paid,
                    COALESCE((SELECT SUM((l.qty_hundredths * l.unit_cost_cents + 50) / 100)
                                FROM purchase_lines l WHERE l.purchase_id = p.id), 0)
               FROM purchases p
               LEFT JOIN vendors v ON v.id = p.vendor_id
              WHERE p.id = ?1",
        )?
        .query_row([id], |row| {
            Ok(Purchase {
                id: row.get(0)?,
                purchase_date: row.get(1)?,
                vendor_id: row.get(2)?,
                vendor_name: row.get(3)?,
                category: row.get(4)?,
                note: row.get(5)?,
                is_paid: row.get::<_, i64>(6)? != 0,
                total_cents: row.get(7)?,
                lines: Vec::new(),
            })
        })
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("purchase {id} does not exist")))?;
    purchase.lines = purchase_lines_of(conn, id)?;
    Ok(purchase)
}

pub fn list_purchases(conn: &Connection) -> Result<Vec<Purchase>> {
    let mut ids = Vec::new();
    {
        let mut stmt =
            conn.prepare("SELECT id FROM purchases ORDER BY purchase_date DESC, id DESC")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for id in rows {
            ids.push(id?);
        }
    }
    ids.into_iter().map(|id| purchase_by_id(conn, id)).collect()
}

pub fn save_purchase(conn: &mut Connection, input: &PurchaseInput) -> Result<Purchase> {
    let day = checked_date(&input.purchase_date, "the date")?;
    let category = if input.category.trim().is_empty() {
        "Materials".to_string()
    } else {
        input.category.trim().to_string()
    };

    let mut lines: Vec<PurchaseLineInput> = Vec::new();
    for (index, line) in input.lines.iter().enumerate() {
        let position = index + 1;
        let blank = line.description.trim().is_empty()
            && line.unit_cost_cents == 0
            && line.qty_hundredths == 100
            && line.inventory_item_id.is_none();
        if blank {
            continue;
        }
        if line.qty_hundredths <= 0 {
            return Err(CoreError::validation(format!(
                "line {position}: the quantity must be greater than zero"
            )));
        }
        if line.unit_cost_cents < 0 || line.sale_price_cents < 0 {
            return Err(CoreError::validation(format!(
                "line {position}: costs and prices cannot be negative"
            )));
        }
        lines.push(line.clone());
    }
    if lines.is_empty() {
        return Err(CoreError::validation("add at least one line to the purchase"));
    }
    let total: i64 = lines
        .iter()
        .map(|line| line_total(line.qty_hundredths, line.unit_cost_cents))
        .sum();
    if total <= 0 {
        return Err(CoreError::validation("a purchase must be worth more than zero"));
    }

    let (expense_account, stored_category) = category_account(conn, &category, AccountType::Expense)?;
    let cash = cash_account(conn)?;
    let payable = payable_account(conn)?;

    let previous = match input.id {
        Some(id) => {
            let row = conn
                .query_row(
                    "SELECT journal_entry_id FROM purchases WHERE id = ?1",
                    [id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()?
                .ok_or_else(|| CoreError::not_found(format!("purchase {id} does not exist")))?;
            Some(row)
        }
        None => None,
    };
    let previous_lines = match input.id {
        Some(id) => purchase_lines_of(conn, id)?,
        None => Vec::new(),
    };

    let memo = format!("{stored_category} purchase");
    let entry = JournalEntryInput {
        entry_date: day.clone(),
        memo,
        reference: None,
        source: EntrySource::Bill,
        lines: vec![
            line(expense_account, total, 0),
            line(if input.is_paid { cash } else { payable }, 0, total),
        ],
    };

    let tx = conn.transaction()?;
    if let Some(entry_id) = &previous {
        for line in &previous_lines {
            if let Some(item_id) = line.inventory_item_id {
                stock_in_reverse(&tx, item_id, line.qty_hundredths, line.unit_cost_cents)?;
            }
        }
        if let Some(entry_id) = entry_id {
            journal::void_in(&tx, *entry_id)?;
        }
    }

    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE purchases
                    SET purchase_date = ?2, vendor_id = ?3, category = ?4, account_id = ?5,
                        note = ?6, is_paid = ?7, journal_entry_id = NULL
                  WHERE id = ?1",
                params![
                    id,
                    day,
                    input.vendor_id,
                    stored_category,
                    expense_account,
                    input.note.trim(),
                    input.is_paid as i64
                ],
            )?;
            tx.execute("DELETE FROM purchase_lines WHERE purchase_id = ?1", [id])?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO purchases (purchase_date, vendor_id, category, account_id, note, is_paid)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    day,
                    input.vendor_id,
                    stored_category,
                    expense_account,
                    input.note.trim(),
                    input.is_paid as i64
                ],
            )?;
            tx.last_insert_rowid()
        }
    };

    {
        let mut stmt = tx.prepare(
            "INSERT INTO purchase_lines
                (purchase_id, position, description, qty_hundredths, unit_cost_cents,
                 sale_price_cents, inventory_item_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for (index, line) in lines.iter().enumerate() {
            stmt.execute(params![
                id,
                (index as i64) + 1,
                line.description.trim(),
                line.qty_hundredths,
                line.unit_cost_cents,
                line.sale_price_cents,
                line.inventory_item_id
            ])?;
        }
    }

    // Buying stock: an existing item moves in at weighted-average cost; a new
    // name creates the item so stock tracking never blocks the bookkeeping.
    for (index, line) in lines.iter().enumerate() {
        let position = (index as i64) + 1;
        let item_id = match line.inventory_item_id {
            Some(item_id) => Some(item_id),
            None if !line.description.trim().is_empty() => {
                let existing: Option<i64> = tx
                    .query_row(
                        "SELECT id FROM inventory_items WHERE lower(name) = lower(?1)",
                        [line.description.trim()],
                        |row| row.get(0),
                    )
                    .optional()?;
                let id = match existing {
                    Some(id) => id,
                    None => {
                        tx.execute(
                            "INSERT INTO inventory_items
                                (name, kind, qty_hundredths, unit_cost_cents, sale_price_cents)
                             VALUES (?1, 'Product', 0, ?2, ?3)",
                            params![
                                line.description.trim(),
                                line.unit_cost_cents,
                                line.sale_price_cents
                            ],
                        )?;
                        tx.last_insert_rowid()
                    }
                };
                tx.execute(
                    "UPDATE purchase_lines SET inventory_item_id = ?3
                      WHERE purchase_id = ?1 AND position = ?2",
                    params![id, position, id],
                )?;
                Some(id)
            }
            None => None,
        };
        if let Some(item_id) = item_id {
            stock_in(
                &tx,
                item_id,
                line.qty_hundredths,
                line.unit_cost_cents,
                line.sale_price_cents,
            )?;
        }
    }

    let posted = journal::post_in(&tx, &entry)?;
    tx.execute(
        "UPDATE purchases SET journal_entry_id = ?2 WHERE id = ?1",
        params![id, posted.summary.id],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    purchase_by_id(conn, id)
}

pub fn delete_purchase(conn: &mut Connection, id: i64) -> Result<()> {
    let entry_id: Option<i64> = conn
        .query_row(
            "SELECT journal_entry_id FROM purchases WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("purchase {id} does not exist")))?;
    let lines = purchase_lines_of(conn, id)?;

    let tx = conn.transaction()?;
    for line in &lines {
        if let Some(item_id) = line.inventory_item_id {
            stock_in_reverse(&tx, item_id, line.qty_hundredths, line.unit_cost_cents)?;
        }
    }
    if let Some(entry_id) = entry_id {
        journal::void_in(&tx, entry_id)?;
    }
    tx.execute("DELETE FROM purchase_lines WHERE purchase_id = ?1", [id])?;
    tx.execute("DELETE FROM purchases WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayrollInput {
    pub id: Option<i64>,
    pub employee: String,
    pub pay_date: String,
    #[serde(default)]
    pub check_number: String,
    pub pay_rate_cents: i64,
    #[serde(default)]
    pub regular_hours_hundredths: i64,
    #[serde(default)]
    pub overtime_hours_hundredths: i64,
    #[serde(default)]
    pub federal_cents: i64,
    #[serde(default)]
    pub state_cents: i64,
    #[serde(default)]
    pub social_security_cents: i64,
    #[serde(default)]
    pub medicare_cents: i64,
    #[serde(default)]
    pub other_deductions_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayrollRun {
    pub id: i64,
    pub employee: String,
    pub pay_date: String,
    pub check_number: String,
    pub pay_rate_cents: i64,
    pub regular_hours_hundredths: i64,
    pub overtime_hours_hundredths: i64,
    pub gross_cents: i64,
    pub federal_cents: i64,
    pub state_cents: i64,
    pub social_security_cents: i64,
    pub medicare_cents: i64,
    pub other_deductions_cents: i64,
    pub total_deductions_cents: i64,
    pub net_cents: i64,
    pub journal_entry_id: Option<i64>,
}

const SELECT_PAYROLL: &str = r#"
SELECT id, employee, pay_date, check_number, pay_rate_cents, regular_hours_hundredths,
       overtime_hours_hundredths, gross_cents, federal_cents, state_cents,
       social_security_cents, medicare_cents, other_deductions_cents, net_cents,
       journal_entry_id
FROM payroll_runs
"#;

fn map_payroll(row: &rusqlite::Row<'_>) -> rusqlite::Result<PayrollRun> {
    let federal: i64 = row.get(8)?;
    let state: i64 = row.get(9)?;
    let ss: i64 = row.get(10)?;
    let medicare: i64 = row.get(11)?;
    let other: i64 = row.get(12)?;
    Ok(PayrollRun {
        id: row.get(0)?,
        employee: row.get(1)?,
        pay_date: row.get(2)?,
        check_number: row.get(3)?,
        pay_rate_cents: row.get(4)?,
        regular_hours_hundredths: row.get(5)?,
        overtime_hours_hundredths: row.get(6)?,
        gross_cents: row.get(7)?,
        federal_cents: federal,
        state_cents: state,
        social_security_cents: ss,
        medicare_cents: medicare,
        other_deductions_cents: other,
        total_deductions_cents: federal + state + ss + medicare + other,
        net_cents: row.get(13)?,
        journal_entry_id: row.get(14)?,
    })
}

pub fn list_payroll(conn: &Connection) -> Result<Vec<PayrollRun>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_PAYROLL} ORDER BY pay_date DESC, id DESC"
    ))?;
    let rows = stmt.query_map([], map_payroll)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn payroll_by_id(conn: &Connection, id: i64) -> Result<PayrollRun> {
    conn.prepare(&format!("{SELECT_PAYROLL} WHERE id = ?1"))?
        .query_row([id], map_payroll)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("pay run {id} does not exist")))
}

pub fn save_payroll(conn: &mut Connection, input: &PayrollInput) -> Result<PayrollRun> {
    let employee = required_text(&input.employee, "an employee name")?;
    let day = checked_date(&input.pay_date, "the pay date")?;
    if input.pay_rate_cents < 0 {
        return Err(CoreError::validation("the pay rate cannot be negative"));
    }
    if input.regular_hours_hundredths < 0 || input.overtime_hours_hundredths < 0 {
        return Err(CoreError::validation("hours cannot be negative"));
    }
    let overtime_rate = input.pay_rate_cents * 3 / 2;
    let gross = line_total(input.regular_hours_hundredths, input.pay_rate_cents)
        + line_total(input.overtime_hours_hundredths, overtime_rate);
    let deductions = input.federal_cents
        + input.state_cents
        + input.social_security_cents
        + input.medicare_cents
        + input.other_deductions_cents;
    if gross <= 0 {
        return Err(CoreError::validation(
            "enter hours and a pay rate so the pay run is worth something",
        ));
    }
    if deductions < 0 || deductions > gross {
        return Err(CoreError::validation(
            "deductions cannot exceed gross pay",
        ));
    }
    let net = gross - deductions;

    let cash = cash_account(conn)?;
    let payroll_expense = role_account(
        conn,
        ROLE_PAYROLL_EXPENSE,
        "6300",
        "Payroll Expense",
        AccountType::Expense,
        "Payroll",
    )?;
    let payroll_liability = role_account(
        conn,
        ROLE_PAYROLL_LIABILITY,
        "2300",
        "Payroll Liabilities",
        AccountType::Liability,
        "Other Current Liability",
    )?;

    let mut lines = vec![line(payroll_expense, gross, 0), line(cash, 0, net)];
    if deductions > 0 {
        lines.push(line(payroll_liability, 0, deductions));
    }
    let entry = JournalEntryInput {
        entry_date: day.clone(),
        memo: format!("Pay run — {employee}"),
        reference: Some(input.check_number.trim().to_string())
            .filter(|value| !value.is_empty()),
        source: EntrySource::Payroll,
        lines,
    };

    let tx = conn.transaction()?;
    if let Some(id) = input.id {
        let previous: Option<Option<i64>> = tx
            .query_row(
                "SELECT journal_entry_id FROM payroll_runs WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match previous {
            None => return Err(CoreError::not_found(format!("pay run {id} does not exist"))),
            Some(entry_id) => {
                if let Some(entry_id) = entry_id {
                    journal::void_in(&tx, entry_id)?;
                }
            }
        }
    }

    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE payroll_runs
                    SET employee = ?2, pay_date = ?3, check_number = ?4, pay_rate_cents = ?5,
                        regular_hours_hundredths = ?6, overtime_hours_hundredths = ?7,
                        gross_cents = ?8, federal_cents = ?9, state_cents = ?10,
                        social_security_cents = ?11, medicare_cents = ?12,
                        other_deductions_cents = ?13, net_cents = ?14, journal_entry_id = NULL
                  WHERE id = ?1",
                params![
                    id,
                    employee,
                    day,
                    input.check_number.trim(),
                    input.pay_rate_cents,
                    input.regular_hours_hundredths,
                    input.overtime_hours_hundredths,
                    gross,
                    input.federal_cents,
                    input.state_cents,
                    input.social_security_cents,
                    input.medicare_cents,
                    input.other_deductions_cents,
                    net
                ],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO payroll_runs
                    (employee, pay_date, check_number, pay_rate_cents,
                     regular_hours_hundredths, overtime_hours_hundredths, gross_cents,
                     federal_cents, state_cents, social_security_cents, medicare_cents,
                     other_deductions_cents, net_cents)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    employee,
                    day,
                    input.check_number.trim(),
                    input.pay_rate_cents,
                    input.regular_hours_hundredths,
                    input.overtime_hours_hundredths,
                    gross,
                    input.federal_cents,
                    input.state_cents,
                    input.social_security_cents,
                    input.medicare_cents,
                    input.other_deductions_cents,
                    net
                ],
            )?;
            tx.last_insert_rowid()
        }
    };

    let posted = journal::post_in(&tx, &entry)?;
    tx.execute(
        "UPDATE payroll_runs SET journal_entry_id = ?2 WHERE id = ?1",
        params![id, posted.summary.id],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    payroll_by_id(conn, id)
}

pub fn delete_payroll(conn: &mut Connection, id: i64) -> Result<()> {
    let entry_id: Option<i64> = conn
        .query_row(
            "SELECT journal_entry_id FROM payroll_runs WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("pay run {id} does not exist")))?;
    let tx = conn.transaction()?;
    if let Some(entry_id) = entry_id {
        journal::void_in(&tx, entry_id)?;
    }
    tx.execute("DELETE FROM payroll_runs WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Reports, derived from the posted journal so they can never drift from it
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub account_id: i64,
    pub number: String,
    pub name: String,
    pub amount_cents: i64,
}

fn balances(
    conn: &Connection,
    types_sql: &str,
    from: Option<&str>,
    to: Option<&str>,
    credit_normal: bool,
) -> Result<Vec<AccountBalance>> {
    let mut sql = format!(
        "SELECT a.id, a.number, a.name,
                COALESCE(SUM(l.debit_cents), 0), COALESCE(SUM(l.credit_cents), 0)
           FROM accounts a
           JOIN journal_lines l ON l.account_id = a.id
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.status = 'POSTED' AND a.type IN ({types_sql})"
    );
    let mut values: Vec<&dyn rusqlite::ToSql> = Vec::new();
    if let Some(value) = from.as_ref() {
        sql.push_str(" AND e.entry_date >= ?");
        values.push(value);
    }
    if let Some(value) = to.as_ref() {
        sql.push_str(" AND e.entry_date <= ?");
        values.push(value);
    }
    sql.push_str(" GROUP BY a.id ORDER BY a.number");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(values.as_slice(), |row| {
        let debit: i64 = row.get(3)?;
        let credit: i64 = row.get(4)?;
        Ok(AccountBalance {
            account_id: row.get(0)?,
            number: row.get(1)?,
            name: row.get(2)?,
            amount_cents: if credit_normal {
                credit - debit
            } else {
                debit - credit
            },
        })
    })?;
    let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    // A zero balance is noise on a report a non-accountant is reading.
    Ok(rows
        .into_iter()
        .filter(|row| row.amount_cents != 0)
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitAndLoss {
    pub from: Option<String>,
    pub to: Option<String>,
    pub income: Vec<AccountBalance>,
    pub expenses: Vec<AccountBalance>,
    pub total_income_cents: i64,
    pub total_expense_cents: i64,
    pub net_cents: i64,
}

pub fn profit_and_loss(
    conn: &Connection,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<ProfitAndLoss> {
    let income = balances(conn, "'INCOME','OTHER_INCOME'", from, to, true)?;
    let expenses = balances(conn, "'COGS','EXPENSE','OTHER_EXPENSE'", from, to, false)?;
    let total_income_cents = income.iter().map(|row| row.amount_cents).sum();
    let total_expense_cents = expenses.iter().map(|row| row.amount_cents).sum();
    Ok(ProfitAndLoss {
        from: from.map(str::to_string),
        to: to.map(str::to_string),
        income,
        expenses,
        total_income_cents,
        total_expense_cents,
        net_cents: total_income_cents - total_expense_cents,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceSheet {
    pub as_of: Option<String>,
    pub assets: Vec<AccountBalance>,
    pub liabilities: Vec<AccountBalance>,
    pub equity: Vec<AccountBalance>,
    pub net_income_cents: i64,
    pub total_assets_cents: i64,
    pub total_liabilities_cents: i64,
    pub total_equity_cents: i64,
    pub balanced: bool,
}

pub fn balance_sheet(conn: &Connection, as_of: Option<&str>) -> Result<BalanceSheet> {
    let assets = balances(conn, "'ASSET'", None, as_of, false)?;
    let liabilities = balances(conn, "'LIABILITY'", None, as_of, true)?;
    let equity = balances(conn, "'EQUITY'", None, as_of, true)?;
    let pnl = profit_and_loss(conn, None, as_of)?;

    let total_assets_cents: i64 = assets.iter().map(|row| row.amount_cents).sum();
    let total_liabilities_cents: i64 = liabilities.iter().map(|row| row.amount_cents).sum();
    let equity_accounts: i64 = equity.iter().map(|row| row.amount_cents).sum();
    let total_equity_cents = equity_accounts + pnl.net_cents;

    Ok(BalanceSheet {
        as_of: as_of.map(str::to_string),
        assets,
        liabilities,
        equity,
        net_income_cents: pnl.net_cents,
        total_assets_cents,
        total_liabilities_cents,
        total_equity_cents,
        balanced: total_assets_cents == total_liabilities_cents + total_equity_cents,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxSummary {
    pub from: Option<String>,
    pub to: Option<String>,
    pub taxable_sales_cents: i64,
    pub untaxed_sales_cents: i64,
    pub sales_tax_collected_cents: i64,
    pub purchase_tax_cents: i64,
}

pub fn tax_summary(conn: &Connection, from: Option<&str>, to: Option<&str>) -> Result<TaxSummary> {
    let mut sql = String::from(
        "SELECT COALESCE(SUM(CASE WHEN tax_bp > 0 THEN amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN tax_bp = 0 THEN amount_cents ELSE 0 END), 0),
                COALESCE(SUM((amount_cents * tax_bp + 5000) / 10000), 0)
           FROM income_records WHERE 1 = 1",
    );
    let mut values: Vec<&dyn rusqlite::ToSql> = Vec::new();
    if let Some(value) = from.as_ref() {
        sql.push_str(" AND entry_date >= ?");
        values.push(value);
    }
    if let Some(value) = to.as_ref() {
        sql.push_str(" AND entry_date <= ?");
        values.push(value);
    }
    let (taxable, untaxed, collected): (i64, i64, i64) = conn.query_row(
        &sql,
        values.as_slice(),
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    let mut purchase_sql = String::from(
        "SELECT COALESCE(SUM((amount_cents * tax_bp + 5000) / 10000), 0)
           FROM expense_records WHERE 1 = 1",
    );
    let mut purchase_values: Vec<&dyn rusqlite::ToSql> = Vec::new();
    if let Some(value) = from.as_ref() {
        purchase_sql.push_str(" AND entry_date >= ?");
        purchase_values.push(value);
    }
    if let Some(value) = to.as_ref() {
        purchase_sql.push_str(" AND entry_date <= ?");
        purchase_values.push(value);
    }
    let purchase_tax: i64 =
        conn.query_row(&purchase_sql, purchase_values.as_slice(), |row| row.get(0))?;

    Ok(TaxSummary {
        from: from.map(str::to_string),
        to: to.map(str::to_string),
        taxable_sales_cents: taxable,
        untaxed_sales_cents: untaxed,
        sales_tax_collected_cents: collected,
        purchase_tax_cents: purchase_tax,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub kind: String,
    pub date: String,
    pub description: String,
    pub party: String,
    pub amount_cents: i64,
    pub is_paid: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub income_cents: i64,
    pub expense_cents: i64,
    pub net_cents: i64,
    pub cash_cents: i64,
    pub unpaid_income_cents: i64,
    pub unpaid_expense_cents: i64,
    pub invoice_outstanding_cents: i64,
    pub sales_tax_due_cents: i64,
    pub inventory_value_cents: i64,
    pub categories: Vec<AccountBalance>,
    pub recent: Vec<Activity>,
}

pub fn dashboard(conn: &Connection) -> Result<Dashboard> {
    let pnl = profit_and_loss(conn, None, None)?;

    let unpaid_income: i64 = conn.query_row(
        "SELECT COALESCE(SUM(amount_cents + (amount_cents * tax_bp + 5000) / 10000), 0)
           FROM income_records WHERE is_paid = 0",
        [],
        |row| row.get(0),
    )?;
    let unpaid_expense: i64 = conn.query_row(
        "SELECT COALESCE(SUM(amount_cents + (amount_cents * tax_bp + 5000) / 10000), 0)
           FROM expense_records WHERE is_paid = 0",
        [],
        |row| row.get(0),
    )?;
    let invoice_outstanding: i64 = conn.query_row(
        "SELECT COALESCE(SUM(
                    (SELECT SUM((l.qty_hundredths * l.unit_price_cents + 50) / 100)
                       FROM invoice_lines l WHERE l.invoice_id = i.id)
                    * (10000 + i.tax_bp) / 10000), 0)
           FROM invoices i WHERE i.status = 'Sent'",
        [],
        |row| row.get(0),
    )?;

    let cash_cents = setting(conn, ROLE_CASH)?
        .and_then(|value| value.parse::<i64>().ok())
        .map(|account_id| {
            conn.query_row(
                "SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)
                   FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                  WHERE l.account_id = ?1 AND e.status = 'POSTED'",
                [account_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .transpose()?
        .unwrap_or(0);

    let sales_tax_due_cents = setting(conn, ROLE_TAX)?
        .and_then(|value| value.parse::<i64>().ok())
        .map(|account_id| {
            conn.query_row(
                "SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0)
                   FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                  WHERE l.account_id = ?1 AND e.status = 'POSTED'",
                [account_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .transpose()?
        .unwrap_or(0);

    let inventory_value_cents: i64 = conn.query_row(
        "SELECT COALESCE(SUM((qty_hundredths * unit_cost_cents + 50) / 100), 0)
           FROM inventory_items",
        [],
        |row| row.get(0),
    )?;

    let recent: Vec<Activity> = {
        let mut stmt = conn.prepare(
            "SELECT kind, entry_date, description, party, amount_cents, is_paid FROM (
                SELECT 'income' AS kind, i.entry_date, i.description, COALESCE(c.name, '') AS party,
                       i.amount_cents + (i.amount_cents * i.tax_bp + 5000) / 10000 AS amount_cents,
                       i.is_paid
                  FROM income_records i LEFT JOIN customers c ON c.id = i.customer_id
                UNION ALL
                SELECT 'expense', e.entry_date, e.description, COALESCE(v.name, ''),
                       -(e.amount_cents + (e.amount_cents * e.tax_bp + 5000) / 10000),
                       e.is_paid
                  FROM expense_records e LEFT JOIN vendors v ON v.id = e.vendor_id
             ) ORDER BY entry_date DESC LIMIT 8",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Activity {
                kind: row.get(0)?,
                date: row.get(1)?,
                description: row.get(2)?,
                party: row.get(3)?,
                amount_cents: row.get(4)?,
                is_paid: row.get::<_, i64>(5)? != 0,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    Ok(Dashboard {
        income_cents: pnl.total_income_cents,
        expense_cents: pnl.total_expense_cents,
        net_cents: pnl.net_cents,
        cash_cents,
        unpaid_income_cents: unpaid_income,
        unpaid_expense_cents: unpaid_expense,
        invoice_outstanding_cents: invoice_outstanding,
        sales_tax_due_cents,
        inventory_value_cents,
        categories: pnl.expenses,
        recent,
    })
}

/// Human-readable money, used in error messages the owner will actually read.
pub fn cents(value: i64) -> String {
    money::format(value)
}
