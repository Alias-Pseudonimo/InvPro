//! The people who use a company file, what each of them is allowed to do, and
//! the billable time and mileage they record.
//!
//! Access levels are a guardrail, not a lock: the company file lives on one
//! machine and anyone with the file can read it. What the levels do is keep the
//! acting person's name on every audit row and stop an accidental edit — a read
//! only bookkeeper cannot post, a time entry person cannot touch the books at
//! all, and payroll stays with the admin and the payroll person. The engine
//! enforces each capability itself, so no screen can widen it.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{audit, db, journal, CoreError, Result};

pub const ACCESS_ADMIN: &str = "Admin";
pub const ACCESS_STANDARD: &str = "Standard";
pub const ACCESS_PAYROLL: &str = "Payroll";
pub const ACCESS_TIME: &str = "TimeEntry";
pub const ACCESS_READ_ONLY: &str = "ReadOnly";

/// What a person is trying to do. Each command in the shell declares one, and
/// the engine decides whether the acting user's access level grants it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    /// Look at records and run reports.
    ViewBooks,
    /// Record, edit and void transactions.
    EditRecords,
    /// Company settings, account roles and closing the books.
    ManageSettings,
    /// Add or change people and their access levels.
    ManageUsers,
    /// Enter and review time and mileage.
    EnterTime,
    /// The employee roster, pay runs and the wage figures behind them.
    ManagePayroll,
}

impl Capability {
    pub fn refused(self) -> &'static str {
        match self {
            Capability::ViewBooks => "look at these books",
            Capability::EditRecords => "record transactions",
            Capability::ManageSettings => "change company settings",
            Capability::ManageUsers => "manage users",
            Capability::EnterTime => "enter time and mileage",
            Capability::ManagePayroll => "open payroll or the employee roster",
        }
    }
}

pub fn allows(access: &str, capability: Capability) -> bool {
    match access {
        ACCESS_ADMIN => true,
        // Standard runs the books, not the payroll: wages and Social Security
        // numbers stay with the admin and the payroll person.
        ACCESS_STANDARD => matches!(
            capability,
            Capability::ViewBooks | Capability::EditRecords | Capability::EnterTime
        ),
        // A payroll person does pay runs, the roster and the hours and miles
        // that feed them. They do not invoice, post journals or change settings.
        ACCESS_PAYROLL => matches!(
            capability,
            Capability::ManagePayroll | Capability::EnterTime
        ),
        ACCESS_TIME => matches!(capability, Capability::EnterTime),
        ACCESS_READ_ONLY => matches!(capability, Capability::ViewBooks),
        _ => false,
    }
}

fn normalized_access(value: &str) -> Result<&'static str> {
    match value.trim() {
        "" | "Standard" => Ok(ACCESS_STANDARD),
        "Admin" => Ok(ACCESS_ADMIN),
        "Payroll" | "Payroll Specialist" => Ok(ACCESS_PAYROLL),
        "TimeEntry" | "Time Entry" => Ok(ACCESS_TIME),
        "ReadOnly" | "Read Only" => Ok(ACCESS_READ_ONLY),
        other => Err(CoreError::validation(format!(
            "'{other}' is not an access level; use Admin, Standard, Payroll, Time Entry or Read Only"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub access: String,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInput {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub access: String,
    #[serde(default = "active_by_default")]
    pub is_active: bool,
}

fn active_by_default() -> bool {
    true
}

const SELECT_USER: &str =
    "SELECT id, name, email, access, is_active, created_at FROM users";

fn map_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: row.get(0)?,
        name: row.get(1)?,
        email: row.get(2)?,
        access: row.get(3)?,
        is_active: row.get::<_, i64>(4)? != 0,
        created_at: row.get(5)?,
    })
}

pub fn list_users(conn: &Connection) -> Result<Vec<User>> {
    let mut stmt = conn.prepare(&format!("{SELECT_USER} ORDER BY is_active DESC, name"))?;
    let rows = stmt.query_map([], map_user)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Just enough to say who is on this file and offer them in the switcher. This
/// is read by every access level — it is the sign-in list, not personnel data.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: i64,
    pub name: String,
    pub access: String,
    pub is_active: bool,
}

pub fn list_people(conn: &Connection) -> Result<Vec<Person>> {
    let mut stmt =
        conn.prepare("SELECT id, name, access, is_active FROM users ORDER BY is_active DESC, name")?;
    let rows = stmt.query_map([], |row| {
        Ok(Person {
            id: row.get(0)?,
            name: row.get(1)?,
            access: row.get(2)?,
            is_active: row.get::<_, i64>(3)? != 0,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn user_by_id(conn: &Connection, id: i64) -> Result<Option<User>> {
    Ok(conn
        .prepare(&format!("{SELECT_USER} WHERE id = ?1"))?
        .query_row([id], map_user)
        .optional()?)
}

fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// The person the app is acting as. Someone has to be there, so a file with no
/// recorded current user falls back to an admin, then to anyone active.
pub fn current_user(conn: &Connection) -> Result<User> {
    if let Some(id) = setting(conn, "current_user_id").and_then(|value| value.parse::<i64>().ok()) {
        if let Some(user) = user_by_id(conn, id)? {
            if user.is_active {
                return Ok(user);
            }
        }
    }
    let fallback: Option<User> = conn
        .prepare(&format!(
            "{SELECT_USER} WHERE is_active = 1
             ORDER BY CASE access WHEN 'Admin' THEN 0 ELSE 1 END, id LIMIT 1"
        ))?
        .query_row([], map_user)
        .optional()?;
    fallback.ok_or_else(|| {
        CoreError::validation(
            "this company file has no active user; an admin needs to add one before the app can open it",
        )
    })
}

pub fn set_current_user(conn: &mut Connection, id: i64) -> Result<User> {
    let user = user_by_id(conn, id)?
        .ok_or_else(|| CoreError::not_found(format!("user {id} does not exist")))?;
    if !user.is_active {
        return Err(CoreError::validation(format!(
            "{} is switched off; switch them back on before working as them",
            user.name
        )));
    }
    let tx = conn.transaction()?;
    write_setting(&tx, "current_user_id", &user.id.to_string())?;
    // The audit triggers read app_session.actor, so the trail names the person.
    db::set_actor(&tx, &user.name)?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(user)
}

pub fn save_user(conn: &mut Connection, input: &UserInput) -> Result<User> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(CoreError::validation("a user needs a name"));
    }
    let access = normalized_access(&input.access)?;

    let clash: Option<i64> = conn.query_row(
        "SELECT id FROM users WHERE lower(trim(name)) = lower(?1) AND id IS NOT ?2",
        params![name, input.id],
        |row| row.get(0),
    ).optional()?;
    if clash.is_some() {
        return Err(CoreError::validation(format!(
            "there is already a user called {name}"
        )));
    }

    let tx = conn.transaction()?;
    let id = match input.id {
        Some(id) => {
            let changed = tx.execute(
                "UPDATE users SET name = ?2, email = ?3, access = ?4, is_active = ?5 WHERE id = ?1",
                params![id, name, input.email.trim(), access, input.is_active as i64],
            )?;
            if changed == 0 {
                return Err(CoreError::not_found(format!("user {id} does not exist")));
            }
            id
        }
        None => {
            tx.execute(
                "INSERT INTO users (name, email, access, is_active) VALUES (?1, ?2, ?3, ?4)",
                params![name, input.email.trim(), access, input.is_active as i64],
            )?;
            tx.last_insert_rowid()
        }
    };
    audit::seal_pending(&tx)?;
    tx.commit()?;
    user_by_id(conn, id)?.ok_or_else(|| CoreError::not_found("that user just disappeared"))
}

pub fn delete_user(conn: &mut Connection, id: i64) -> Result<()> {
    let user = user_by_id(conn, id)?
        .ok_or_else(|| CoreError::not_found(format!("user {id} does not exist")))?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM users WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    if setting(conn, "current_user_id").and_then(|value| value.parse::<i64>().ok()) == Some(id) {
        let next = current_user(conn)?;
        set_current_user(conn, next.id)?;
    }
    let _ = user;
    Ok(())
}

// ---------------------------------------------------------------------------
// Time and mileage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntry {
    pub id: i64,
    pub user_id: Option<i64>,
    pub entered_by: String,
    pub entry_date: String,
    pub kind: String,
    pub description: String,
    pub customer: String,
    pub quantity_hundredths: i64,
    pub rate_cents: i64,
    pub amount_cents: i64,
    pub is_billable: bool,
    /// The pay run that reimbursed these miles, if any. A mile is paid once.
    pub reimbursed_run_id: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntryInput {
    pub id: Option<i64>,
    pub user_id: Option<i64>,
    pub entry_date: String,
    #[serde(default = "time_kind")]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub customer: String,
    pub quantity_hundredths: i64,
    #[serde(default)]
    pub rate_cents: i64,
    #[serde(default = "billable_by_default")]
    pub is_billable: bool,
}

fn time_kind() -> String {
    "Time".to_string()
}

fn billable_by_default() -> bool {
    true
}

fn normalized_kind(value: &str) -> Result<&'static str> {
    match value.trim() {
        "" | "Time" => Ok("Time"),
        "Mileage" => Ok("Mileage"),
        other => Err(CoreError::validation(format!(
            "'{other}' is not a time entry kind; use Time or Mileage"
        ))),
    }
}

fn map_time(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimeEntry> {
    let quantity: i64 = row.get(6)?;
    let rate: i64 = row.get(7)?;
    Ok(TimeEntry {
        id: row.get(0)?,
        user_id: row.get(1)?,
        entered_by: row.get(2)?,
        entry_date: row.get(3)?,
        kind: row.get(4)?,
        description: row.get(5)?,
        customer: row.get(8)?,
        quantity_hundredths: quantity,
        rate_cents: rate,
        amount_cents: ((quantity as i128 * rate as i128 + 50) / 100) as i64,
        is_billable: row.get::<_, i64>(9)? != 0,
        reimbursed_run_id: row.get(11)?,
        created_at: row.get(10)?,
    })
}

const SELECT_TIME: &str = r#"
SELECT id, user_id, entered_by, entry_date, kind, description,
       quantity_hundredths, rate_cents, customer, is_billable, created_at,
       reimbursed_run_id
FROM time_entries
"#;

/// Time entry people see their own sheet; everyone else sees the whole company.
pub fn list_time_entries(conn: &Connection, viewer: &User) -> Result<Vec<TimeEntry>> {
    let sql = if viewer.access == ACCESS_TIME {
        format!("{SELECT_TIME} WHERE user_id = ?1 ORDER BY entry_date DESC, id DESC")
    } else {
        format!("{SELECT_TIME} ORDER BY entry_date DESC, id DESC")
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = if viewer.access == ACCESS_TIME {
        stmt.query_map([viewer.id], map_time)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map([], map_time)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

pub fn save_time_entry(
    conn: &mut Connection,
    viewer: &User,
    input: &TimeEntryInput,
) -> Result<TimeEntry> {
    let day = if journal::is_valid_date(&input.entry_date) {
        input.entry_date.clone()
    } else {
        return Err(CoreError::validation(
            "the date must be a real date in YYYY-MM-DD form",
        ));
    };
    let kind = normalized_kind(&input.kind)?;
    if input.quantity_hundredths <= 0 {
        return Err(CoreError::validation(
            if kind == "Time" { "enter the hours worked" } else { "enter the miles driven" },
        ));
    }
    if input.rate_cents < 0 {
        return Err(CoreError::validation("a rate cannot be negative"));
    }

    // A time entry person only ever writes their own sheet.
    let owner_id = if viewer.access == ACCESS_TIME {
        viewer.id
    } else {
        input.user_id.unwrap_or(viewer.id)
    };
    let owner = user_by_id(conn, owner_id)?
        .ok_or_else(|| CoreError::validation("that person is not on this company file"))?;

    if let Some(id) = input.id {
        let existing: Option<(Option<i64>, Option<i64>)> = conn
            .query_row(
                "SELECT user_id, reimbursed_run_id FROM time_entries WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match existing {
            None => return Err(CoreError::not_found(format!("time entry {id} does not exist"))),
            Some((Some(other), _)) if viewer.access == ACCESS_TIME && other != viewer.id => {
                return Err(CoreError::validation(
                    "that time entry belongs to someone else",
                ))
            }
            Some((_, Some(_))) => {
                return Err(CoreError::validation(
                    "this mileage was already reimbursed on a pay run; it stays as it was paid",
                ))
            }
            _ => {}
        }
    }

    let tx = conn.transaction()?;
    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE time_entries
                    SET user_id = ?2, entered_by = ?3, entry_date = ?4, kind = ?5,
                        description = ?6, customer = ?7, quantity_hundredths = ?8,
                        rate_cents = ?9, is_billable = ?10
                  WHERE id = ?1",
                params![
                    id,
                    owner.id,
                    owner.name,
                    day,
                    kind,
                    input.description.trim(),
                    input.customer.trim(),
                    input.quantity_hundredths,
                    input.rate_cents,
                    input.is_billable as i64
                ],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO time_entries
                    (user_id, entered_by, entry_date, kind, description, customer,
                     quantity_hundredths, rate_cents, is_billable)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    owner.id,
                    owner.name,
                    day,
                    kind,
                    input.description.trim(),
                    input.customer.trim(),
                    input.quantity_hundredths,
                    input.rate_cents,
                    input.is_billable as i64
                ],
            )?;
            tx.last_insert_rowid()
        }
    };
    audit::seal_pending(&tx)?;
    tx.commit()?;

    Ok(tx_free_entry(conn, id)?)
}

fn tx_free_entry(conn: &Connection, id: i64) -> Result<TimeEntry> {
    conn.prepare(&format!("{SELECT_TIME} WHERE id = ?1"))?
        .query_row([id], map_time)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("time entry {id} does not exist")))
}

pub fn delete_time_entry(conn: &mut Connection, viewer: &User, id: i64) -> Result<()> {
    let owner: Option<(Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT user_id, reimbursed_run_id FROM time_entries WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match owner {
        None => return Err(CoreError::not_found(format!("time entry {id} does not exist"))),
        Some((Some(other), _)) if viewer.access == ACCESS_TIME && other != viewer.id => {
            return Err(CoreError::validation(
                "that time entry belongs to someone else",
            ))
        }
        Some((_, Some(_))) => {
            return Err(CoreError::validation(
                "this mileage was reimbursed on a pay run; delete that pay run first",
            ))
        }
        _ => {}
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM time_entries WHERE id = ?1", [id])?;
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_access_level_grants_only_its_own_capabilities() {
        assert!(allows(ACCESS_ADMIN, Capability::ManageUsers));
        assert!(allows(ACCESS_ADMIN, Capability::ManageSettings));
        assert!(allows(ACCESS_ADMIN, Capability::EditRecords));

        assert!(allows(ACCESS_STANDARD, Capability::EditRecords));
        assert!(allows(ACCESS_STANDARD, Capability::ViewBooks));
        assert!(allows(ACCESS_STANDARD, Capability::EnterTime));
        assert!(!allows(ACCESS_STANDARD, Capability::ManageUsers));
        assert!(!allows(ACCESS_STANDARD, Capability::ManageSettings));

        assert!(allows(ACCESS_PAYROLL, Capability::ManagePayroll));
        assert!(allows(ACCESS_PAYROLL, Capability::EnterTime));
        assert!(!allows(ACCESS_PAYROLL, Capability::ViewBooks));
        assert!(!allows(ACCESS_PAYROLL, Capability::EditRecords));
        assert!(!allows(ACCESS_PAYROLL, Capability::ManageSettings));
        assert!(!allows(ACCESS_PAYROLL, Capability::ManageUsers));
        assert!(!allows(ACCESS_STANDARD, Capability::ManagePayroll));
        assert!(!allows(ACCESS_TIME, Capability::ManagePayroll));
        assert!(!allows(ACCESS_READ_ONLY, Capability::ManagePayroll));

        assert!(allows(ACCESS_TIME, Capability::EnterTime));
        assert!(!allows(ACCESS_TIME, Capability::ViewBooks));
        assert!(!allows(ACCESS_TIME, Capability::EditRecords));

        assert!(allows(ACCESS_READ_ONLY, Capability::ViewBooks));
        assert!(!allows(ACCESS_READ_ONLY, Capability::EditRecords));
        assert!(!allows(ACCESS_READ_ONLY, Capability::EnterTime));
        assert!(!allows(ACCESS_READ_ONLY, Capability::ManageSettings));
    }
}
