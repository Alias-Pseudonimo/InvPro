//! Opening, configuring and migrating a company file.

use std::fs;
use std::path::Path;

use rusqlite::Connection;

use crate::schema::{migration_2, migration_3, MIGRATION_1, SCHEMA_VERSION};
use crate::{CoreError, Result};

/// Open (or create) a company file, apply connection pragmas and migrate it to
/// the current schema version.
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Open an in-memory company, used by tests and by "new company" previews.
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    // Foreign keys are per-connection in SQLite and default to off.
    conn.execute("PRAGMA foreign_keys = ON", [])?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    // WAL keeps readers live while a write transaction is open, which matters
    // once the host service shares one company file between sessions.
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    conn.execute("PRAGMA synchronous = NORMAL", [])?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(CoreError::validation(format!(
            "this company file was created by a newer version of the application (schema {version}); \
             update the application before opening it"
        )));
    }
    if version < 1 {
        conn.execute_batch(MIGRATION_1)?;
    }
    if version < 2 {
        // v2 adds the plain-language record layer. An older file keeps its
        // journal and chart exactly as they were; the new tables are additive.
        conn.execute_batch(&migration_2())?;
    }
    if version < 3 {
        // v3 ties an income record to its invoice and adds recurring invoices.
        conn.execute_batch(&migration_3())?;
    }
    if version < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

/// Record the acting user for the audit triggers on this connection.
pub fn set_actor(conn: &Connection, actor: &str) -> Result<()> {
    let actor = actor.trim();
    if actor.is_empty() {
        return Err(CoreError::validation("the acting user is required"));
    }
    conn.execute("UPDATE app_session SET actor = ?1 WHERE id = 1", [actor])?;
    Ok(())
}

pub fn schema_version(conn: &Connection) -> Result<i32> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

pub fn actor(conn: &Connection) -> Result<String> {
    Ok(conn.query_row("SELECT actor FROM app_session WHERE id = 1", [], |row| row.get(0))?)
}

/// SQLite's own consistency check; surfaced in the UI's maintenance panel.
pub fn integrity_check(conn: &Connection) -> Result<String> {
    Ok(conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_two_file_gains_the_invoice_link_and_schedules() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_1).unwrap();
        conn.execute_batch(&migration_2()).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute("INSERT INTO customers (name) VALUES ('Old Co')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO income_records (entry_date, category, amount_cents, is_paid)
             VALUES ('2026-01-05', 'Contract Revenue', 120000, 1)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        let names: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(income_records)").unwrap();
            stmt.query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert!(names.contains(&"invoice_id".to_string()));
        assert!(names.contains(&"invoice_auto".to_string()));

        // Old records keep their money and start out unattached to an invoice.
        let (amount, invoice_id): (i64, Option<i64>) = conn
            .query_row(
                "SELECT amount_cents, invoice_id FROM income_records",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(amount, 120_000);
        assert_eq!(invoice_id, None);

        conn.execute(
            "INSERT INTO recurring_invoices (start_date, next_date) VALUES ('2026-02-01', '2026-02-01')",
            [],
        )
        .unwrap();
        assert_eq!(integrity_check(&conn).unwrap(), "ok");
    }
}
