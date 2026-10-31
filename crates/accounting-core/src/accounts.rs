//! Chart of accounts.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{CoreError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccountType {
    Asset,
    Liability,
    Equity,
    Income,
    Cogs,
    Expense,
    OtherIncome,
    OtherExpense,
}

impl AccountType {
    pub fn code(self) -> &'static str {
        match self {
            AccountType::Asset => "ASSET",
            AccountType::Liability => "LIABILITY",
            AccountType::Equity => "EQUITY",
            AccountType::Income => "INCOME",
            AccountType::Cogs => "COGS",
            AccountType::Expense => "EXPENSE",
            AccountType::OtherIncome => "OTHER_INCOME",
            AccountType::OtherExpense => "OTHER_EXPENSE",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "ASSET" => Ok(AccountType::Asset),
            "LIABILITY" => Ok(AccountType::Liability),
            "EQUITY" => Ok(AccountType::Equity),
            "INCOME" => Ok(AccountType::Income),
            "COGS" => Ok(AccountType::Cogs),
            "EXPENSE" => Ok(AccountType::Expense),
            "OTHER_INCOME" => Ok(AccountType::OtherIncome),
            "OTHER_EXPENSE" => Ok(AccountType::OtherExpense),
            other => Err(CoreError::validation(format!(
                "'{other}' is not a valid account type"
            ))),
        }
    }

    /// Debit-normal accounts grow with debits; credit-normal accounts grow with
    /// credits. This drives report signs and is the only place it is decided.
    pub fn is_debit_normal(self) -> bool {
        matches!(
            self,
            AccountType::Asset | AccountType::Cogs | AccountType::Expense | AccountType::OtherExpense
        )
    }

    pub fn normal_balance(self) -> &'static str {
        if self.is_debit_normal() {
            "DEBIT"
        } else {
            "CREDIT"
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            AccountType::Asset => "Asset",
            AccountType::Liability => "Liability",
            AccountType::Equity => "Equity",
            AccountType::Income => "Income",
            AccountType::Cogs => "Cost of Goods Sold",
            AccountType::Expense => "Expense",
            AccountType::OtherIncome => "Other Income",
            AccountType::OtherExpense => "Other Expense",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub number: String,
    pub name: String,
    pub account_type: AccountType,
    pub subtype: Option<String>,
    pub parent_id: Option<i64>,
    pub currency: Option<String>,
    pub description: Option<String>,
    pub is_active: bool,
    pub has_children: bool,
    pub normal_balance: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub number: String,
    pub name: String,
    pub account_type: AccountType,
    pub subtype: Option<String>,
    pub parent_id: Option<i64>,
    pub currency: Option<String>,
    pub description: Option<String>,
}

const SELECT_ACCOUNT: &str = r#"
SELECT a.id, a.number, a.name, a.type, a.subtype, a.parent_id, a.currency,
       a.description, a.is_active,
       EXISTS (SELECT 1 FROM accounts child WHERE child.parent_id = a.id)
FROM accounts a
"#;

fn map_account(row: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
    let type_code: String = row.get(3)?;
    let account_type = AccountType::parse(&type_code).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unknown account type",
            )),
        )
    })?;
    Ok(Account {
        id: row.get(0)?,
        number: row.get(1)?,
        name: row.get(2)?,
        account_type,
        subtype: row.get(4)?,
        parent_id: row.get(5)?,
        currency: row.get(6)?,
        description: row.get(7)?,
        is_active: row.get::<_, i64>(8)? != 0,
        has_children: row.get::<_, i64>(9)? != 0,
        normal_balance: account_type.normal_balance(),
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn.prepare(&format!("{SELECT_ACCOUNT} ORDER BY a.number"))?;
    let rows = stmt.query_map([], map_account)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn by_id(conn: &Connection, id: i64) -> Result<Account> {
    conn.prepare(&format!("{SELECT_ACCOUNT} WHERE a.id = ?1"))?
        .query_row([id], map_account)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("account {id} does not exist")))
}

pub fn create(conn: &mut Connection, input: &AccountInput) -> Result<Account> {
    let number = input.number.trim();
    let name = input.name.trim();
    if number.is_empty() {
        return Err(CoreError::validation("an account number is required"));
    }
    if name.is_empty() {
        return Err(CoreError::validation("an account name is required"));
    }
    if let Some(currency) = input.currency.as_deref() {
        if !currency.trim().is_empty() && currency.trim().len() != 3 {
            return Err(CoreError::validation(
                "a currency code must be three letters, for example USD",
            ));
        }
    }

    let tx = conn.transaction()?;
    if let Some(parent_id) = input.parent_id {
        let parent_type: Option<String> = tx
            .query_row("SELECT type FROM accounts WHERE id = ?1", [parent_id], |row| {
                row.get(0)
            })
            .optional()?;
        match parent_type {
            None => return Err(CoreError::not_found(format!("parent account {parent_id} does not exist"))),
            Some(parent) if parent != input.account_type.code() => {
                return Err(CoreError::validation(
                    "a sub-account must have the same type as its parent",
                ))
            }
            Some(_) => {}
        }
    }

    tx.execute(
        "INSERT INTO accounts (number, name, type, subtype, parent_id, currency, description)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            number,
            name,
            input.account_type.code(),
            input.subtype.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            input.parent_id,
            input.currency.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            input.description.as_deref().map(str::trim).filter(|v| !v.is_empty()),
        ],
    )?;
    let id = tx.last_insert_rowid();
    crate::audit::seal_pending(&tx)?;
    tx.commit()?;
    by_id(conn, id)
}

/// Set or clear the active flag. Deactivating a header account deactivates its
/// subtree, which keeps the chart honest without deleting history.
pub fn set_active(conn: &mut Connection, id: i64, active: bool) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("UPDATE accounts SET is_active = ?2 WHERE id = ?1", params![id, active as i64])?;
    crate::audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

/// A conventional starter chart so a new company file is usable immediately.
pub const DEFAULT_CHART: &[(&str, &str, AccountType, &str)] = &[
    ("1000", "Checking", AccountType::Asset, "Bank"),
    ("1010", "Savings", AccountType::Asset, "Bank"),
    ("1100", "Accounts Receivable", AccountType::Asset, "Accounts Receivable"),
    ("1200", "Inventory", AccountType::Asset, "Inventory"),
    ("1300", "Prepaid Expenses", AccountType::Asset, "Current Asset"),
    ("1400", "Fixed Assets", AccountType::Asset, "Fixed Asset"),
    ("1410", "Accumulated Depreciation", AccountType::Asset, "Fixed Asset"),
    ("2000", "Accounts Payable", AccountType::Liability, "Accounts Payable"),
    ("2100", "Credit Cards", AccountType::Liability, "Credit Card"),
    ("2200", "Sales Tax Payable", AccountType::Liability, "Other Current Liability"),
    ("2300", "Payroll Liabilities", AccountType::Liability, "Other Current Liability"),
    ("2500", "Notes Payable", AccountType::Liability, "Long Term Liability"),
    ("3000", "Owner's Equity", AccountType::Equity, "Equity"),
    ("3100", "Retained Earnings", AccountType::Equity, "Equity"),
    ("3200", "Owner's Draw", AccountType::Equity, "Equity"),
    ("4000", "Sales Revenue", AccountType::Income, "Sales"),
    ("4100", "Service Revenue", AccountType::Income, "Service"),
    ("4900", "Other Income", AccountType::OtherIncome, "Other Income"),
    ("5000", "Cost of Goods Sold", AccountType::Cogs, "Cost of Goods Sold"),
    ("5100", "Freight & Delivery", AccountType::Cogs, "Cost of Goods Sold"),
    ("5200", "Inventory Adjustments", AccountType::Cogs, "Cost of Goods Sold"),
    ("6000", "Advertising", AccountType::Expense, "Marketing"),
    ("6100", "Bank Fees", AccountType::Expense, "Operating Expense"),
    ("6200", "Insurance", AccountType::Expense, "Operating Expense"),
    ("6300", "Payroll Expense", AccountType::Expense, "Payroll"),
    ("6400", "Rent", AccountType::Expense, "Operating Expense"),
    ("6500", "Supplies", AccountType::Expense, "Operating Expense"),
    ("6600", "Utilities", AccountType::Expense, "Operating Expense"),
    ("6700", "Depreciation Expense", AccountType::Expense, "Operating Expense"),
    ("6800", "Professional Fees", AccountType::Expense, "Operating Expense"),
];

pub fn seed_default_chart(conn: &Connection) -> Result<usize> {
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO accounts (number, name, type, subtype) VALUES (?1, ?2, ?3, ?4)",
    )?;
    let mut inserted = 0;
    for (number, name, account_type, subtype) in DEFAULT_CHART {
        inserted += stmt.execute(params![number, name, account_type.code(), subtype])?;
    }
    Ok(inserted)
}
