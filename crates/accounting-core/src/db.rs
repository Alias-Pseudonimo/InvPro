//! Opening, configuring and migrating a company file.

use std::fs;
use std::path::Path;

use rusqlite::Connection;

use crate::schema::{migration_2, MIGRATION_1, SCHEMA_VERSION};
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
