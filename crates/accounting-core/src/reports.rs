//! Reports. Only `POSTED` entries count; drafts and voids never reach the books.

use rusqlite::Connection;
use serde::Serialize;

use crate::accounts::AccountType;
use crate::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialBalanceRow {
    pub account_id: i64,
    pub number: String,
    pub name: String,
    pub account_type: AccountType,
    pub normal_balance: &'static str,
    pub debit_cents: i64,
    pub credit_cents: i64,
    /// Signed by the account's normal balance: a positive number means the
    /// account is behaving normally.
    pub balance_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialBalanceReport {
    pub rows: Vec<TrialBalanceRow>,
    pub total_debit_cents: i64,
    pub total_credit_cents: i64,
    pub is_balanced: bool,
    pub as_of: Option<String>,
}

pub fn trial_balance(conn: &Connection) -> Result<TrialBalanceReport> {
    let mut stmt = conn.prepare(
        r#"
        SELECT a.id, a.number, a.name, a.type,
               COALESCE(SUM(l.debit_cents), 0),
               COALESCE(SUM(l.credit_cents), 0)
          FROM accounts a
          LEFT JOIN journal_lines l
                 ON l.account_id = a.id
                AND l.entry_id IN (SELECT id FROM journal_entries WHERE status = 'POSTED')
         GROUP BY a.id, a.number, a.name, a.type
        HAVING COALESCE(SUM(l.debit_cents), 0) <> 0
            OR COALESCE(SUM(l.credit_cents), 0) <> 0
         ORDER BY a.number
        "#,
    )?;

    let rows = stmt
        .query_map([], |row| {
            let type_code: String = row.get(3)?;
            let account_type = AccountType::parse(&type_code).unwrap_or(AccountType::Asset);
            let debit_cents: i64 = row.get(4)?;
            let credit_cents: i64 = row.get(5)?;
            let balance_cents = if account_type.is_debit_normal() {
                debit_cents - credit_cents
            } else {
                credit_cents - debit_cents
            };
            Ok(TrialBalanceRow {
                account_id: row.get(0)?,
                number: row.get(1)?,
                name: row.get(2)?,
                account_type,
                normal_balance: account_type.normal_balance(),
                debit_cents,
                credit_cents,
                balance_cents,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let total_debit_cents = rows.iter().map(|row| row.debit_cents).sum();
    let total_credit_cents = rows.iter().map(|row| row.credit_cents).sum();

    Ok(TrialBalanceReport {
        rows,
        total_debit_cents,
        total_credit_cents,
        is_balanced: total_debit_cents == total_credit_cents,
        as_of: None,
    })
}

/// Company-wide check: the sum of every posted debit equals the sum of every
/// posted credit. Used by the health panel.
pub fn ledger_is_balanced(conn: &Connection) -> Result<bool> {
    let (debits, credits): (i64, i64) = conn.query_row(
        r#"
        SELECT COALESCE(SUM(l.debit_cents), 0), COALESCE(SUM(l.credit_cents), 0)
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
         WHERE e.status = 'POSTED'
        "#,
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(debits == credits)
}
