//! Journal entries: the write path for everything that touches the books.
//!
//! Rust validates the entry so the user gets a precise message, then the
//! database re-checks the same rules through triggers. The second check is not
//! redundant: it is what makes the invariant true for any future caller.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{audit, CoreError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EntrySource {
    Manual,
    Invoice,
    Bill,
    Payment,
    Payroll,
    Inventory,
    Adjustment,
    OpeningBalance,
    Import,
}

impl EntrySource {
    pub fn code(self) -> &'static str {
        match self {
            EntrySource::Manual => "MANUAL",
            EntrySource::Invoice => "INVOICE",
            EntrySource::Bill => "BILL",
            EntrySource::Payment => "PAYMENT",
            EntrySource::Payroll => "PAYROLL",
            EntrySource::Inventory => "INVENTORY",
            EntrySource::Adjustment => "ADJUSTMENT",
            EntrySource::OpeningBalance => "OPENING_BALANCE",
            EntrySource::Import => "IMPORT",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalLineInput {
    pub account_id: i64,
    pub debit_cents: i64,
    pub credit_cents: i64,
    #[serde(default)]
    pub memo: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryInput {
    pub entry_date: String,
    #[serde(default)]
    pub memo: String,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default = "default_source")]
    pub source: EntrySource,
    pub lines: Vec<JournalLineInput>,
}

fn default_source() -> EntrySource {
    EntrySource::Manual
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    pub id: i64,
    pub entry_no: i64,
    pub entry_date: String,
    pub memo: String,
    pub reference: Option<String>,
    pub source: String,
    pub status: String,
    pub total_cents: i64,
    pub line_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryLine {
    pub id: i64,
    pub line_no: i64,
    pub account_id: i64,
    pub account_number: String,
    pub account_name: String,
    pub debit_cents: i64,
    pub credit_cents: i64,
    pub memo: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetail {
    #[serde(flatten)]
    pub summary: EntrySummary,
    pub lines: Vec<EntryLine>,
}

/// Validate an entry the way a bookkeeper would read it, before touching SQL.
fn validate(conn: &Connection, input: &JournalEntryInput) -> Result<i64> {
    if !is_valid_date(&input.entry_date) {
        return Err(CoreError::validation(
            "the entry date must be a real date in YYYY-MM-DD form",
        ));
    }
    if input.lines.len() < 2 {
        return Err(CoreError::validation(
            "a journal entry needs at least two lines",
        ));
    }

    let mut debits: i64 = 0;
    let mut credits: i64 = 0;
    for (index, line) in input.lines.iter().enumerate() {
        let position = index + 1;
        if line.debit_cents < 0 || line.credit_cents < 0 {
            return Err(CoreError::validation(format!(
                "line {position}: amounts cannot be negative"
            )));
        }
        match (line.debit_cents > 0, line.credit_cents > 0) {
            (true, true) => {
                return Err(CoreError::validation(format!(
                    "line {position}: a line is either a debit or a credit, not both"
                )))
            }
            (false, false) => {
                return Err(CoreError::validation(format!(
                    "line {position}: enter a debit or a credit amount"
                )))
            }
            _ => {}
        }
        debits = debits
            .checked_add(line.debit_cents)
            .ok_or_else(|| CoreError::validation("the entry total is too large"))?;
        credits = credits
            .checked_add(line.credit_cents)
            .ok_or_else(|| CoreError::validation("the entry total is too large"))?;

        let account = conn
            .query_row(
                "SELECT a.is_active,
                        (SELECT COUNT(*) FROM accounts child WHERE child.parent_id = a.id)
                 FROM accounts a WHERE a.id = ?1",
                [line.account_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        match account {
            None => {
                return Err(CoreError::validation(format!(
                    "line {position}: the selected account does not exist"
                )))
            }
            Some((_, children)) if children > 0 => {
                return Err(CoreError::validation(format!(
                    "line {position}: this is a header account; post to one of its sub-accounts"
                )))
            }
            Some((active, _)) if active == 0 => {
                return Err(CoreError::validation(format!(
                    "line {position}: the selected account is inactive"
                )))
            }
            Some(_) => {}
        }
    }

    if debits != credits {
        return Err(CoreError::validation(format!(
            "out of balance by {}: debits {} and credits {} must be equal",
            crate::money::format(debits - credits),
            crate::money::format(debits),
            crate::money::format(credits)
        )));
    }
    if debits == 0 {
        return Err(CoreError::validation("the entry must have a non-zero value"));
    }
    Ok(debits)
}

pub fn is_valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return false;
    }
    let year: i32 = value[0..4].parse().unwrap_or(0);
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    if year < 1900 || year > 2200 || month == 0 || month > 12 || day == 0 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day <= max_day
}

/// Create a draft entry together with its lines, without posting it.
pub fn create_draft(conn: &mut Connection, input: &JournalEntryInput) -> Result<i64> {
    validate(conn, input)?;
    let tx = conn.transaction()?;
    let entry_no: i64 = tx.query_row(
        "SELECT COALESCE(MAX(entry_no), 0) + 1 FROM journal_entries",
        [],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO journal_entries (entry_no, entry_date, memo, reference, source, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'DRAFT')",
        params![
            entry_no,
            input.entry_date,
            input.memo.trim(),
            input.reference.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            input.source.code(),
        ],
    )?;
    let entry_id = tx.last_insert_rowid();
    {
        let mut stmt = tx.prepare(
            "INSERT INTO journal_lines (entry_id, line_no, account_id, debit_cents, credit_cents, memo)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (index, line) in input.lines.iter().enumerate() {
            stmt.execute(params![
                entry_id,
                (index as i64) + 1,
                line.account_id,
                line.debit_cents,
                line.credit_cents,
                line.memo.as_deref().map(str::trim).unwrap_or(""),
            ])?;
        }
    }
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(entry_id)
}

pub fn post_draft(conn: &mut Connection, entry_id: i64) -> Result<()> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM journal_entries WHERE id = ?1",
            [entry_id],
            |row| row.get(0),
        )
        .optional()?;
    match status.as_deref() {
        None => return Err(CoreError::not_found(format!("entry {entry_id} does not exist"))),
        Some("POSTED") => return Err(CoreError::validation("this entry is already posted")),
        Some("VOID") => return Err(CoreError::validation("a void entry cannot be posted")),
        Some(_) => {}
    }

    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE journal_entries
            SET status = 'POSTED', posted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1",
        [entry_id],
    )?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Post a fully-formed entry inside a transaction the caller already owns.
///
/// Nothing is sealed here: the caller seals the audit rows and commits, so a
/// friendly record (an invoice, a pay run) and the entry it produces land in the
/// file together or not at all.
pub fn post_in(conn: &Connection, input: &JournalEntryInput) -> Result<EntryDetail> {
    validate(conn, input)?;
    let entry_no: i64 = conn.query_row(
        "SELECT COALESCE(MAX(entry_no), 0) + 1 FROM journal_entries",
        [],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO journal_entries (entry_no, entry_date, memo, reference, source, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'DRAFT')",
        params![
            entry_no,
            input.entry_date,
            input.memo.trim(),
            input.reference.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            input.source.code(),
        ],
    )?;
    let entry_id = conn.last_insert_rowid();
    {
        let mut stmt = conn.prepare(
            "INSERT INTO journal_lines (entry_id, line_no, account_id, debit_cents, credit_cents, memo)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (index, line) in input.lines.iter().enumerate() {
            stmt.execute(params![
                entry_id,
                (index as i64) + 1,
                line.account_id,
                line.debit_cents,
                line.credit_cents,
                line.memo.as_deref().map(str::trim).unwrap_or(""),
            ])?;
        }
    }
    conn.execute(
        "UPDATE journal_entries
            SET status = 'POSTED', posted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1",
        [entry_id],
    )?;
    get(conn, entry_id)
}

/// Post a fully-formed entry in one transaction of its own.
pub fn post(conn: &mut Connection, input: &JournalEntryInput) -> Result<EntryDetail> {
    let tx = conn.transaction()?;
    let entry = post_in(&tx, input)?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(entry)
}

/// Voiding keeps the audit trail intact: the entry stays in the file, is
/// excluded from reports, and can never be re-posted.
pub fn void_entry(conn: &mut Connection, entry_id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    void_in(&tx, entry_id)?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Void an entry inside a transaction the caller already owns.
pub fn void_in(conn: &Connection, entry_id: i64) -> Result<()> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM journal_entries WHERE id = ?1",
            [entry_id],
            |row| row.get(0),
        )
        .optional()?;
    match status.as_deref() {
        None => return Err(CoreError::not_found(format!("entry {entry_id} does not exist"))),
        Some("VOID") => return Err(CoreError::validation("this entry is already void")),
        Some("DRAFT") => {
            conn.execute("DELETE FROM journal_entries WHERE id = ?1", [entry_id])?;
            return Ok(());
        }
        Some(_) => {}
    }

    conn.execute("UPDATE journal_entries SET status = 'VOID' WHERE id = ?1", [entry_id])?;
    Ok(())
}

const SELECT_ENTRY: &str = r#"
SELECT e.id, e.entry_no, e.entry_date, e.memo, e.reference, e.source, e.status,
       COALESCE((SELECT SUM(debit_cents) FROM journal_lines WHERE entry_id = e.id), 0),
       (SELECT COUNT(*) FROM journal_lines WHERE entry_id = e.id),
       e.created_at
FROM journal_entries e
"#;

fn map_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<EntrySummary> {
    Ok(EntrySummary {
        id: row.get(0)?,
        entry_no: row.get(1)?,
        entry_date: row.get(2)?,
        memo: row.get(3)?,
        reference: row.get(4)?,
        source: row.get(5)?,
        status: row.get(6)?,
        total_cents: row.get(7)?,
        line_count: row.get(8)?,
        created_at: row.get(9)?,
    })
}

pub fn list(conn: &Connection, limit: i64) -> Result<Vec<EntrySummary>> {
    let limit = limit.clamp(1, 1_000);
    let mut stmt = conn.prepare(&format!(
        "{SELECT_ENTRY} ORDER BY e.entry_date DESC, e.entry_no DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map([limit], map_summary)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, entry_id: i64) -> Result<EntryDetail> {
    let summary = conn
        .prepare(&format!("{SELECT_ENTRY} WHERE e.id = ?1"))?
        .query_row([entry_id], map_summary)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("entry {entry_id} does not exist")))?;

    let mut stmt = conn.prepare(
        "SELECT l.id, l.line_no, l.account_id, a.number, a.name,
                l.debit_cents, l.credit_cents, l.memo
           FROM journal_lines l
           JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = ?1
          ORDER BY l.line_no",
    )?;
    let lines = stmt
        .query_map([entry_id], |row| {
            Ok(EntryLine {
                id: row.get(0)?,
                line_no: row.get(1)?,
                account_id: row.get(2)?,
                account_number: row.get(3)?,
                account_name: row.get(4)?,
                debit_cents: row.get(5)?,
                credit_cents: row.get(6)?,
                memo: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(EntryDetail { summary, lines })
}

#[cfg(test)]
mod tests {
    use super::is_valid_date;

    #[test]
    fn validates_real_dates() {
        assert!(is_valid_date("2026-10-30"));
        assert!(is_valid_date("2024-02-29"));
        assert!(!is_valid_date("2023-02-29"));
        assert!(!is_valid_date("2026-13-01"));
        assert!(!is_valid_date("2026-00-10"));
        assert!(!is_valid_date("2026-4-1"));
        assert!(!is_valid_date("30-10-2026"));
    }
}
