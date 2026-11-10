//! Employees — the people you pay, kept separately from the people who open the
//! file.
//!
//! A crew member needs a W-4 (how much to withhold) and a W-2 identity (who they
//! are, and what the year-end form will say). Neither requires a login: most
//! people who get a paycheck never touch the books. The `user_id` link exists
//! only so a person who *also* logs time and mileage has their sheet attributed
//! to their employee record, and it can stay empty.
//!
//! The whole Social Security number is kept, because box a of the W-2 is the
//! number itself and nobody should have to retype it in January. Lists show only
//! the last four because that is what fits a table, not as a security measure:
//! the file holds the number the same way it holds every wage it ever paid.
//!
//! Pay is either by the hour or a yearly salary split into equal periods. Both
//! the basis and the frequency live on the employee record, so a pay run can be
//! worked out from the person rather than from whatever the form was left on.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::simple::{bp_setting, line_total, required_text};
use crate::{audit, journal, CoreError, Result};

pub const FILING_SINGLE: &str = "Single";
pub const FILING_MARRIED: &str = "Married";

pub const PAY_HOURLY: &str = "Hourly";
pub const PAY_SALARY: &str = "Salary";

pub const FREQ_WEEKLY: &str = "Weekly";
pub const FREQ_BIWEEKLY: &str = "BiWeekly";
pub const FREQ_SEMIMONTHLY: &str = "SemiMonthly";
pub const FREQ_MONTHLY: &str = "Monthly";

/// How many checks a year holds. Two weeks is 26 rather than 24, and twice a
/// month is 24 rather than 26 — the difference is a whole extra check, so it has
/// to be exact.
pub fn periods_per_year(frequency: &str) -> i64 {
    match frequency {
        FREQ_WEEKLY => 52,
        FREQ_SEMIMONTHLY => 24,
        FREQ_MONTHLY => 12,
        _ => 26,
    }
}

/// "Every two weeks" is what a person reads on a stub; the code keeps BiWeekly.
pub fn frequency_label(frequency: &str) -> &'static str {
    match frequency {
        FREQ_WEEKLY => "Every week",
        FREQ_SEMIMONTHLY => "Twice a month",
        FREQ_MONTHLY => "Once a month",
        _ => "Every two weeks",
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Employee {
    pub id: i64,
    pub name: String,
    pub employee_no: String,
    pub email: String,
    pub phone: String,
    pub address: String,
    /// The whole number, so a W-2 can be produced without retyping it.
    pub ssn: String,
    /// Derived from `ssn` on save, for lists and for people who only know the
    /// last four.
    pub ssn_last4: String,
    pub hire_date: Option<String>,
    pub job_title: String,
    pub user_id: Option<i64>,
    pub filing_status: String,
    pub allowances: i64,
    pub extra_withholding_cents: i64,
    pub pay_type: String,
    pub pay_frequency: String,
    /// Hourly rate when `pay_type` is Hourly.
    pub pay_rate_cents: i64,
    /// Yearly salary when `pay_type` is Salary.
    pub salary_cents: i64,
    pub allowance_cents: i64,
    pub mileage_reimbursement: bool,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmployeeInput {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub employee_no: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address: String,
    /// Nine digits, or just the last four for a file that predates keeping the
    /// whole number. Empty clears it.
    #[serde(default)]
    pub ssn: String,
    #[serde(default)]
    pub hire_date: Option<String>,
    #[serde(default)]
    pub job_title: String,
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default = "single_filing")]
    pub filing_status: String,
    #[serde(default)]
    pub allowances: i64,
    #[serde(default)]
    pub extra_withholding_cents: i64,
    #[serde(default = "hourly")]
    pub pay_type: String,
    #[serde(default = "biweekly")]
    pub pay_frequency: String,
    #[serde(default)]
    pub pay_rate_cents: i64,
    #[serde(default)]
    pub salary_cents: i64,
    #[serde(default)]
    pub allowance_cents: i64,
    #[serde(default)]
    pub mileage_reimbursement: bool,
    #[serde(default = "active_by_default")]
    pub is_active: bool,
}

fn single_filing() -> String {
    FILING_SINGLE.to_string()
}

fn active_by_default() -> bool {
    true
}

fn hourly() -> String {
    PAY_HOURLY.to_string()
}

fn biweekly() -> String {
    FREQ_BIWEEKLY.to_string()
}

pub(crate) fn normalized_pay_type(value: &str) -> Result<&'static str> {
    match value.trim() {
        "" | "Hourly" | "hourly" => Ok(PAY_HOURLY),
        "Salary" | "salary" | "Salaried" => Ok(PAY_SALARY),
        other => Err(CoreError::validation(format!(
            "'{other}' is not a pay basis; use Hourly or Salary"
        ))),
    }
}

pub(crate) fn normalized_frequency(value: &str) -> Result<&'static str> {
    match value.trim() {
        "" | "BiWeekly" | "biweekly" | "Bi-weekly" | "Every two weeks" => Ok(FREQ_BIWEEKLY),
        "Weekly" | "weekly" | "Every week" => Ok(FREQ_WEEKLY),
        "SemiMonthly" | "semimonthly" | "Semi-monthly" | "Twice a month" => {
            Ok(FREQ_SEMIMONTHLY)
        }
        "Monthly" | "monthly" | "Once a month" => Ok(FREQ_MONTHLY),
        other => Err(CoreError::validation(format!(
            "'{other}' is not a pay frequency; use Weekly, BiWeekly, SemiMonthly or Monthly"
        ))),
    }
}

fn normalized_filing(value: &str) -> Result<&'static str> {
    match value.trim() {
        "" | "Single" | "single" => Ok(FILING_SINGLE),
        "Married" | "married" => Ok(FILING_MARRIED),
        other => Err(CoreError::validation(format!(
            "'{other}' is not a filing status; use Single or Married"
        ))),
    }
}

const SELECT_EMPLOYEE: &str = r#"
SELECT id, name, employee_no, email, phone, address, ssn_last4, hire_date,
       job_title, user_id, filing_status, allowances, extra_withholding_cents,
       pay_rate_cents, allowance_cents, mileage_reimbursement, is_active, created_at,
       ssn, pay_type, pay_frequency, salary_cents
FROM employees
"#;

fn map_employee(row: &rusqlite::Row<'_>) -> rusqlite::Result<Employee> {
    Ok(Employee {
        id: row.get(0)?,
        name: row.get(1)?,
        employee_no: row.get(2)?,
        email: row.get(3)?,
        phone: row.get(4)?,
        address: row.get(5)?,
        ssn_last4: row.get(6)?,
        hire_date: row.get(7)?,
        job_title: row.get(8)?,
        user_id: row.get(9)?,
        filing_status: row.get(10)?,
        allowances: row.get(11)?,
        extra_withholding_cents: row.get(12)?,
        pay_rate_cents: row.get(13)?,
        allowance_cents: row.get(14)?,
        mileage_reimbursement: row.get::<_, i64>(15)? != 0,
        is_active: row.get::<_, i64>(16)? != 0,
        created_at: row.get(17)?,
        ssn: row.get(18)?,
        pay_type: row.get(19)?,
        pay_frequency: row.get(20)?,
        salary_cents: row.get(21)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Employee>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_EMPLOYEE} ORDER BY is_active DESC, lower(name)"
    ))?;
    let rows = stmt.query_map([], map_employee)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn by_id(conn: &Connection, id: i64) -> Result<Employee> {
    conn.prepare(&format!("{SELECT_EMPLOYEE} WHERE id = ?1"))?
        .query_row([id], map_employee)
        .optional()?
        .ok_or_else(|| CoreError::not_found(format!("employee {id} does not exist")))
}

/// A pay run prefers the employee record's W-4 and rate, but an old pay run may
/// name someone who was never added. That is not an error — it just means there
/// is nothing to pre-fill.
pub fn find_by_id(conn: &Connection, id: Option<i64>) -> Result<Option<Employee>> {
    match id {
        None => Ok(None),
        Some(id) => conn
            .prepare(&format!("{SELECT_EMPLOYEE} WHERE id = ?1"))?
            .query_row([id], map_employee)
            .optional()
            .map_err(Into::into),
    }
}

pub fn save(conn: &mut Connection, input: &EmployeeInput) -> Result<Employee> {
    let name = required_text(&input.name, "an employee name")?;
    let filing_status = normalized_filing(&input.filing_status)?;
    let pay_type = normalized_pay_type(&input.pay_type)?;
    let pay_frequency = normalized_frequency(&input.pay_frequency)?;

    // Nine digits are kept whole for the W-2. Four digits are what an older file
    // stored, so they are accepted as-is rather than thrown away on an edit.
    let digits: String = input.ssn.chars().filter(char::is_ascii_digit).collect();
    let (ssn, ssn_last4) = match digits.len() {
        0 => (String::new(), String::new()),
        4 => (String::new(), digits.clone()),
        9 => {
            let last4 = digits[digits.len() - 4..].to_string();
            (digits.clone(), last4)
        }
        _ => {
            return Err(CoreError::validation(
                "enter the Social Security number as nine digits, or just the last four",
            ))
        }
    };
    if pay_type == PAY_SALARY && input.salary_cents <= 0 {
        return Err(CoreError::validation(
            "a salaried employee needs an annual salary",
        ));
    }
    let hire_date = match input.hire_date.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) if journal::is_valid_date(value) => Some(value.to_string()),
        Some(_) => {
            return Err(CoreError::validation(
                "the hire date must be a real date in YYYY-MM-DD form",
            ))
        }
    };
    for (amount, what) in [
        (input.allowances, "allowances"),
        (input.extra_withholding_cents, "extra withholding"),
        (input.pay_rate_cents, "the pay rate"),
        (input.salary_cents, "the salary"),
        (input.allowance_cents, "the allowance"),
    ] {
        if amount < 0 {
            return Err(CoreError::validation(format!("{what} cannot be negative")));
        }
    }
    if let Some(user_id) = input.user_id {
        let known: Option<i64> = conn
            .query_row("SELECT id FROM users WHERE id = ?1", [user_id], |row| {
                row.get(0)
            })
            .optional()?;
        if known.is_none() {
            return Err(CoreError::validation(
                "that user is not on this company file",
            ));
        }
    }
    let clash: Option<i64> = conn
        .query_row(
            "SELECT id FROM employees WHERE lower(name) = lower(?1) AND id IS NOT ?2",
            params![name, input.id],
            |row| row.get(0),
        )
        .optional()?;
    if clash.is_some() {
        return Err(CoreError::validation(format!(
            "there is already an employee called {name}"
        )));
    }

    let tx = conn.transaction()?;
    let id = match input.id {
        Some(id) => {
            let changed = tx.execute(
                "UPDATE employees
                    SET name = ?2, employee_no = ?3, email = ?4, phone = ?5, address = ?6,
                        ssn_last4 = ?7, hire_date = ?8, job_title = ?9, user_id = ?10,
                        filing_status = ?11, allowances = ?12, extra_withholding_cents = ?13,
                        pay_rate_cents = ?14, allowance_cents = ?15,
                        mileage_reimbursement = ?16, is_active = ?17,
                        ssn = ?18, pay_type = ?19, pay_frequency = ?20, salary_cents = ?21
                  WHERE id = ?1",
                params![
                    id,
                    name,
                    input.employee_no.trim(),
                    input.email.trim(),
                    input.phone.trim(),
                    input.address.trim(),
                    ssn_last4,
                    hire_date,
                    input.job_title.trim(),
                    input.user_id,
                    filing_status,
                    input.allowances,
                    input.extra_withholding_cents,
                    input.pay_rate_cents,
                    input.allowance_cents,
                    input.mileage_reimbursement as i64,
                    input.is_active as i64,
                    ssn,
                    pay_type,
                    pay_frequency,
                    input.salary_cents
                ],
            )?;
            if changed == 0 {
                return Err(CoreError::not_found(format!("employee {id} does not exist")));
            }
            id
        }
        None => {
            tx.execute(
                "INSERT INTO employees
                    (name, employee_no, email, phone, address, ssn_last4, hire_date,
                     job_title, user_id, filing_status, allowances,
                     extra_withholding_cents, pay_rate_cents, allowance_cents,
                     mileage_reimbursement, is_active,
                     ssn, pay_type, pay_frequency, salary_cents)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                         ?16, ?17, ?18, ?19, ?20)",
                params![
                    name,
                    input.employee_no.trim(),
                    input.email.trim(),
                    input.phone.trim(),
                    input.address.trim(),
                    ssn_last4,
                    hire_date,
                    input.job_title.trim(),
                    input.user_id,
                    filing_status,
                    input.allowances,
                    input.extra_withholding_cents,
                    input.pay_rate_cents,
                    input.allowance_cents,
                    input.mileage_reimbursement as i64,
                    input.is_active as i64,
                    ssn,
                    pay_type,
                    pay_frequency,
                    input.salary_cents
                ],
            )?;
            tx.last_insert_rowid()
        }
    };
    audit::seal_pending(&tx)?;
    tx.commit()?;
    by_id(conn, id)
}

/// Retire an employee. Someone with pay runs on file cannot be deleted — the
/// trigger refuses it — because the W-2 history has to say who was paid.
pub fn delete(conn: &mut Connection, id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let changed = tx
        .execute("DELETE FROM employees WHERE id = ?1", [id])
        .map_err(|err| {
            if err.to_string().contains("pay runs on file") {
                CoreError::validation(
                    "this employee has pay runs on file, so keep them and mark them inactive instead",
                )
            } else {
                err.into()
            }
        })?;
    if changed == 0 {
        return Err(CoreError::not_found(format!("employee {id} does not exist")));
    }
    audit::seal_pending(&tx)?;
    tx.commit()?;
    Ok(())
}

/// The miles a pay run could reimburse, and what they are worth at the mileage
/// rate in Settings. A mile is only offered once: the pay run that paid it is
/// recorded on the time entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MileageDue {
    pub miles_hundredths: i64,
    pub rate_cents: i64,
    pub amount_cents: i64,
    /// False when the employee is not linked to a user and no user shares their
    /// name, which means there is no sheet to draw miles from.
    pub linked: bool,
}

pub fn mileage_due(
    conn: &Connection,
    employee: Option<&Employee>,
    including_run: Option<i64>,
) -> Result<MileageDue> {
    let rate_cents = bp_setting(conn, "payroll_mileage_rate_cents", 67).max(0);
    let Some(employee) = employee else {
        return Ok(MileageDue {
            miles_hundredths: 0,
            rate_cents,
            amount_cents: 0,
            linked: false,
        });
    };
    // Miles this same pay run already claimed are still available to it, so
    // previewing an edit shows the same figure the saved run will pay.
    let run = including_run.unwrap_or(-1);
    let miles_hundredths: i64 = if let Some(user_id) = employee.user_id {
        conn.query_row(
            "SELECT COALESCE(SUM(quantity_hundredths), 0) FROM time_entries
              WHERE kind = 'Mileage'
                AND (reimbursed_run_id IS NULL OR reimbursed_run_id = ?2)
                AND user_id = ?1",
            params![user_id, run],
            |row| row.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COALESCE(SUM(quantity_hundredths), 0) FROM time_entries
              WHERE kind = 'Mileage'
                AND (reimbursed_run_id IS NULL OR reimbursed_run_id = ?2)
                AND user_id IN (SELECT id FROM users WHERE lower(name) = lower(?1))",
            params![employee.name.as_str(), run],
            |row| row.get(0),
        )?
    };
    Ok(MileageDue {
        miles_hundredths,
        rate_cents,
        amount_cents: line_total(miles_hundredths, rate_cents),
        linked: employee.user_id.is_some() || miles_hundredths > 0,
    })
}

/// Mark the miles this run paid, inside the caller's transaction, so the same
/// mile is never reimbursed twice.
pub(crate) fn claim_mileage(
    tx: &Connection,
    employee: Option<&Employee>,
    run_id: i64,
) -> Result<()> {
    let Some(employee) = employee else {
        return Ok(());
    };
    if let Some(user_id) = employee.user_id {
        tx.execute(
            "UPDATE time_entries SET reimbursed_run_id = ?1
              WHERE kind = 'Mileage' AND reimbursed_run_id IS NULL AND user_id = ?2",
            params![run_id, user_id],
        )?;
    } else {
        tx.execute(
            "UPDATE time_entries SET reimbursed_run_id = ?1
              WHERE kind = 'Mileage' AND reimbursed_run_id IS NULL
                AND user_id IN (SELECT id FROM users WHERE lower(name) = lower(?2))",
            params![run_id, employee.name],
        )?;
    }
    Ok(())
}
