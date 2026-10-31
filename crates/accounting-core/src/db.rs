//! Opening, configuring and migrating a company file.

use std::fs;
use std::path::Path;

use rusqlite::Connection;

use crate::schema::{
    migration_2, migration_3, migration_4, migration_5, migration_6, migration_7, migration_8,
    MIGRATION_1, SCHEMA_VERSION,
};
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
    if version < 4 {
        // v4 adds credit memos, the people who use the file, and time entries.
        conn.execute_batch(&migration_4())?;
    }
    if version < 5 {
        // v5 adds estimates and sales orders, plus the payroll facts that move
        // withholding: marital status and withholding allowances.
        conn.execute_batch(&migration_5())?;
    }
    if version < 6 {
        // v6 adds employees (who need not be users) and the additions a pay run
        // can carry: mileage reimbursement and a per-period allowance.
        conn.execute_batch(&migration_6())?;
    }
    if version < 7 {
        // v7 adds the pay basis (hourly or salary, and how often) and keeps the
        // whole Social Security number, which the year-end W-2 needs.
        conn.execute_batch(&migration_7())?;
    }
    if version < 8 {
        // v8 makes payroll an access level of its own, so the roster and the pay
        // runs are not open to every person who can raise an invoice.
        conn.execute_batch(&migration_8())?;
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

    #[test]
    fn a_version_five_file_gains_employees_and_additions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_1).unwrap();
        for upgrade in [
            migration_2(),
            migration_3(),
            migration_4(),
            migration_5(),
        ] {
            conn.execute_batch(&upgrade).unwrap();
        }
        conn.pragma_update(None, "user_version", 5).unwrap();
        conn.execute(
            "INSERT INTO payroll_runs (employee, pay_date, gross_cents, net_cents)
             VALUES ('Old Timer', '2026-01-09', 100000, 80000)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        let additions: i64 = conn
            .query_row("SELECT additions_cents FROM payroll_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(additions, 0, "an old run keeps its money and gains nothing");

        // A crew member can exist on the roster with no login at all.
        conn.execute("INSERT INTO employees (name) VALUES ('Crew Member')", [])
            .unwrap();
        let rates: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key LIKE 'payroll_%' AND key LIKE '%_bp'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(rates >= 5, "every withholding rate is a setting: {rates}");
        assert_eq!(integrity_check(&conn).unwrap(), "ok");
    }

    #[test]
    fn a_version_six_file_gains_the_pay_basis_and_the_whole_ssn() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_1).unwrap();
        for upgrade in [
            migration_2(),
            migration_3(),
            migration_4(),
            migration_5(),
            migration_6(),
        ] {
            conn.execute_batch(&upgrade).unwrap();
        }
        conn.pragma_update(None, "user_version", 6).unwrap();
        conn.execute(
            "INSERT INTO employees (name, ssn_last4) VALUES ('Old Timer', '4821')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payroll_runs (employee, pay_date, gross_cents, net_cents)
             VALUES ('Old Timer', '2026-01-09', 100000, 80000)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);

        // An employee keeps the four digits it had; nobody invents a salary.
        let (ssn, pay_type, frequency, salary): (String, String, String, i64) = conn
            .query_row(
                "SELECT ssn, pay_type, pay_frequency, salary_cents FROM employees",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(ssn, "");
        assert_eq!(pay_type, "Hourly");
        assert_eq!(frequency, "BiWeekly");
        assert_eq!(salary, 0);

        // An old pay run is hourly at the biweekly default, and keeps its money.
        let (run_type, run_salary, gross): (String, i64, i64) = conn
            .query_row(
                "SELECT pay_type, salary_cents, gross_cents FROM payroll_runs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(run_type, "Hourly");
        assert_eq!(run_salary, 0);
        assert_eq!(gross, 100_000);

        // The audit images were rebuilt to name the new columns.
        let image: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = 'trg_audit_employees_ins'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(image.contains("pay_frequency"));
        assert_eq!(integrity_check(&conn).unwrap(), "ok");
    }

    #[test]
    fn a_version_seven_file_gains_the_payroll_level() {
        let conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        conn.execute_batch(MIGRATION_1).unwrap();
        for upgrade in [
            migration_2(),
            migration_3(),
            migration_4(),
            migration_5(),
            migration_6(),
            migration_7(),
        ] {
            conn.execute_batch(&upgrade).unwrap();
        }
        conn.pragma_update(None, "user_version", 7).unwrap();

        conn.execute(
            "INSERT INTO users (name, email, access) VALUES ('Sam Okafor', 'sam@example.com', 'Standard')",
            [],
        )
        .unwrap();
        let sam: i64 = conn
            .query_row("SELECT id FROM users WHERE name = 'Sam Okafor'", [], |row| row.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO time_entries (user_id, entry_date, quantity_hundredths, rate_cents)
             VALUES (?1, '2026-01-02', 800, 4500)",
            [sam],
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);

        // The rebuilt table kept every row: same id, same level, and the hours
        // still belong to the person who entered them.
        let (id, access, email): (i64, String, String) = conn
            .query_row(
                "SELECT id, access, email FROM users WHERE name = 'Sam Okafor'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(id, sam);
        assert_eq!(access, "Standard");
        assert_eq!(email, "sam@example.com");

        let owner: Option<i64> = conn
            .query_row("SELECT user_id FROM time_entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(owner, Some(sam), "dropping the old table must not blank an owner");

        // The guard that lives on the table was rebuilt with it.
        let demote_last_admin = conn.execute(
            "UPDATE users SET access = 'Standard' WHERE name = 'Owner'",
            [],
        );
        assert!(demote_last_admin.is_err(), "there must always be an admin");

        // And the new level is now legal, with the old ones still refused when
        // they are not real levels.
        conn.execute(
            "INSERT INTO users (name, access) VALUES ('Priya Raman', 'Payroll')",
            [],
        )
        .unwrap();
        assert!(conn
            .execute(
                "INSERT INTO users (name, access) VALUES ('Nobody', 'Payroll Clerk')",
                [],
            )
            .is_err());

        assert_eq!(integrity_check(&conn).unwrap(), "ok");
    }
}
