//! Payroll: rates that move, additions that are not wages, and employees who
//! are not users.

use accounting_core::db;
use accounting_core::employees::{self, EmployeeInput};
use accounting_core::simple::{self, PayrollInput};
use accounting_core::users::{self, TimeEntryInput};
use accounting_core::{accounts, reports};

fn company() -> rusqlite::Connection {
    let conn = db::open_in_memory().expect("company");
    accounts::seed_default_chart(&conn).expect("chart");
    conn
}

fn employee(name: &str, owner: &users::User) -> EmployeeInput {
    EmployeeInput {
        id: None,
        name: name.into(),
        employee_no: "E-001".into(),
        email: String::new(),
        phone: String::new(),
        address: "18 Mill St".into(),
        ssn: "4821".into(),
        hire_date: Some("2025-04-01".into()),
        job_title: "Foreman".into(),
        user_id: Some(owner.id),
        filing_status: "Married".into(),
        allowances: 1,
        extra_withholding_cents: 0,
        pay_type: "Hourly".into(),
        pay_frequency: "BiWeekly".into(),
        pay_rate_cents: 3_000,
        salary_cents: 0,
        allowance_cents: 5_000,
        mileage_reimbursement: true,
        is_active: true,
    }
}

/// 80 hours at $12.50 = $1,000.00 gross. Single, no allowances, so the standard
/// rates take 12% federal, 4% state, 6.2% Social Security and 1.45% Medicare.
fn run(employee_id: Option<i64>, name: &str) -> PayrollInput {
    PayrollInput {
        id: None,
        employee_id,
        employee: name.into(),
        pay_date: "2026-08-15".into(),
        check_number: "2001".into(),
        pay_rate_cents: 1_250,
        pay_type: "Hourly".into(),
        pay_frequency: "BiWeekly".into(),
        salary_cents: 0,
        regular_hours_hundredths: 8_000,
        overtime_hours_hundredths: 0,
        marital_status: "Single".into(),
        allowances: 0,
        extra_withholding_cents: 0,
        other_deductions_cents: 0,
        pay_mileage: false,
        pay_allowance: false,
        allowance_cents: 0,
    }
}

fn log_miles(conn: &mut rusqlite::Connection, owner: &users::User, miles_hundredths: i64) {
    users::save_time_entry(
        conn,
        owner,
        &TimeEntryInput {
            id: None,
            user_id: Some(owner.id),
            entry_date: "2026-08-01".into(),
            kind: "Mileage".into(),
            description: "Site visits".into(),
            customer: String::new(),
            quantity_hundredths: miles_hundredths,
            rate_cents: 0,
            is_billable: false,
        },
    )
    .expect("miles logged");
}

#[test]
fn social_security_and_medicare_are_settings_not_constants() {
    let mut conn = company();
    let first = simple::save_payroll(&mut conn, &run(None, "J. Alvarez")).unwrap();
    assert_eq!(first.gross_cents, 100_000);
    assert_eq!(first.social_security_cents, 6_200, "6.2% of gross");
    assert_eq!(first.medicare_cents, 1_450, "1.45% of gross");

    // Rates change by law, so an admin owns them.
    simple::put_setting(&mut conn, "payroll_social_security_bp", "605").unwrap();
    simple::put_setting(&mut conn, "payroll_medicare_bp", "160").unwrap();

    let second = simple::save_payroll(&mut conn, &run(None, "J. Alvarez")).unwrap();
    assert_eq!(second.social_security_cents, 6_050);
    assert_eq!(second.medicare_cents, 1_600);

    // The run that used the old rates keeps the figures it was paid under.
    let stored = simple::list_payroll(&conn)
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.id == first.id)
        .unwrap();
    assert_eq!(stored.social_security_cents, 6_200);
    assert_eq!(stored.medicare_cents, 1_450);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn extra_withholding_is_added_on_top_of_the_federal_rate() {
    let mut conn = company();
    let mut input = run(None, "J. Alvarez");
    input.extra_withholding_cents = 2_500;
    let taxed = simple::save_payroll(&mut conn, &input).unwrap();

    assert_eq!(taxed.federal_cents, 12_000 + 2_500, "12% plus the W-4 extra");
    assert_eq!(taxed.net_cents, 100_000 - (14_500 + 4_000 + 6_200 + 1_450));
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn mileage_and_an_allowance_are_paid_without_being_taxed() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let person = employees::save(&mut conn, &employee("Dana Reed", &owner)).unwrap();
    log_miles(&mut conn, &owner, 12_000); // 120.00 miles at the $0.67 rate

    let mut input = run(Some(person.id), "");
    input.pay_mileage = true;
    input.pay_allowance = true;
    input.allowance_cents = 5_000;
    let paid = simple::save_payroll(&mut conn, &input).unwrap();

    assert_eq!(paid.employee, "Dana Reed", "the name comes from the employee record");
    assert_eq!(paid.mileage_hundredths, 12_000);
    assert_eq!(paid.mileage_cents, 8_040, "120 miles at 0.67");
    assert_eq!(paid.allowance_cents, 5_000);
    assert_eq!(paid.additions_cents, 13_040);
    assert_eq!(paid.gross_cents, 100_000, "additions never join gross pay");
    assert_eq!(paid.social_security_cents, 6_200, "reimbursements are not taxed");
    assert_eq!(paid.federal_cents, 12_000);
    assert_eq!(paid.net_cents, 76_350);
    assert_eq!(paid.paid_cents, 76_350 + 13_040, "the check is net plus additions");

    // The books: wages and reimbursements are separate expenses, and the bank
    // paid exactly what the check says.
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
    let pnl = simple::profit_and_loss(&conn, None, None).unwrap();
    assert_eq!(pnl.total_expense_cents, 100_000 + 13_040);
    assert!(pnl
        .expenses
        .iter()
        .any(|row| row.name == "Employee Reimbursements" && row.amount_cents == 13_040));
    assert_eq!(simple::dashboard(&conn).unwrap().cash_cents, -paid.paid_cents);

    // Those miles are paid now, so the next run is not offered them again.
    let due = employees::mileage_due(&conn, Some(&person), None).unwrap();
    assert_eq!(due.miles_hundredths, 0);
    let mut second = run(Some(person.id), "");
    second.pay_mileage = true;
    let paid_again = simple::save_payroll(&mut conn, &second).unwrap();
    assert_eq!(paid_again.mileage_cents, 0, "a mile is only reimbursed once");
    assert_eq!(paid_again.additions_cents, 0);
}

#[test]
fn additions_can_be_declined_for_one_run() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let person = employees::save(&mut conn, &employee("Dana Reed", &owner)).unwrap();
    log_miles(&mut conn, &owner, 5_000);

    // Every addition is a plain yes or no on the run.
    let plain = simple::save_payroll(&mut conn, &run(Some(person.id), "")).unwrap();
    assert_eq!(plain.additions_cents, 0);
    assert_eq!(plain.paid_cents, plain.net_cents);
    assert_eq!(
        employees::mileage_due(&conn, Some(&person), None)
            .unwrap()
            .miles_hundredths,
        5_000,
        "declined miles stay available"
    );
}

#[test]
fn editing_a_run_repays_its_own_miles_exactly_once() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let person = employees::save(&mut conn, &employee("Dana Reed", &owner)).unwrap();
    log_miles(&mut conn, &owner, 10_000);

    let mut input = run(Some(person.id), "");
    input.pay_mileage = true;
    let first = simple::save_payroll(&mut conn, &input).unwrap();
    assert_eq!(first.mileage_cents, 6_700);

    let mut edit = run(Some(person.id), "");
    edit.id = Some(first.id);
    edit.pay_mileage = true;
    edit.regular_hours_hundredths = 7_600;
    let edited = simple::save_payroll(&mut conn, &edit).unwrap();

    assert_eq!(edited.id, first.id);
    assert_eq!(edited.mileage_cents, 6_700, "the run still owes the same miles");
    assert_eq!(edited.mileage_hundredths, 10_000);
    assert_eq!(
        employees::mileage_due(&conn, Some(&person), None)
            .unwrap()
            .miles_hundredths,
        0,
        "editing did not release the miles"
    );
    assert_eq!(simple::list_payroll(&conn).unwrap().len(), 1);
}

#[test]
fn deleting_a_run_gives_its_miles_back() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let person = employees::save(&mut conn, &employee("Dana Reed", &owner)).unwrap();
    log_miles(&mut conn, &owner, 10_000);

    let mut input = run(Some(person.id), "");
    input.pay_mileage = true;
    let paid = simple::save_payroll(&mut conn, &input).unwrap();
    simple::delete_payroll(&mut conn, paid.id).unwrap();

    let due = employees::mileage_due(&conn, Some(&person), None).unwrap();
    assert_eq!(due.miles_hundredths, 10_000);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn reimbursed_mileage_is_history() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let person = employees::save(&mut conn, &employee("Dana Reed", &owner)).unwrap();
    log_miles(&mut conn, &owner, 10_000);
    let entry = users::list_time_entries(&conn, &owner).unwrap().remove(0);

    let mut input = run(Some(person.id), "");
    input.pay_mileage = true;
    simple::save_payroll(&mut conn, &input).unwrap();

    let mut edit = TimeEntryInput {
        id: Some(entry.id),
        user_id: Some(owner.id),
        entry_date: entry.entry_date.clone(),
        kind: "Mileage".into(),
        description: "Edited after payment".into(),
        customer: String::new(),
        quantity_hundredths: 20_000,
        rate_cents: 0,
        is_billable: false,
    };
    let err = users::save_time_entry(&mut conn, &owner, &edit).unwrap_err();
    assert!(err.to_string().contains("already reimbursed"), "{err}");

    let err = users::delete_time_entry(&mut conn, &owner, entry.id).unwrap_err();
    assert!(err.to_string().contains("reimbursed"), "{err}");

    // Once the pay run is gone, the mile is editable again.
    let paid = simple::list_payroll(&conn).unwrap().remove(0);
    simple::delete_payroll(&mut conn, paid.id).unwrap();
    edit.quantity_hundredths = 20_000;
    assert!(users::save_time_entry(&mut conn, &owner, &edit).is_ok());
}

#[test]
fn an_employee_needs_a_w4_and_an_identity_but_not_a_login() {
    let mut conn = company();
    let mut input = employee("Rae Lin", &users::current_user(&conn).unwrap());
    input.user_id = None; // payroll only — she never opens the file
    let saved = employees::save(&mut conn, &input).unwrap();

    assert_eq!(saved.name, "Rae Lin");
    assert_eq!(saved.ssn_last4, "4821");
    assert_eq!(saved.filing_status, "Married");
    assert_eq!(saved.allowances, 1);
    assert_eq!(saved.address, "18 Mill St");
    assert_eq!(saved.hire_date.as_deref(), Some("2025-04-01"));
    assert_eq!(saved.user_id, None);

    let due = employees::mileage_due(&conn, Some(&saved), None).unwrap();
    assert_eq!(due.miles_hundredths, 0);
    assert!(!due.linked, "there is no sheet to draw miles from");

    let listed = employees::list(&conn).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, saved.id);
}

#[test]
fn employee_details_are_checked_before_they_are_stored() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let mut input = employee("Rae Lin", &owner);

    input.ssn = "12345".into();
    let err = employees::save(&mut conn, &input).unwrap_err();
    assert!(err.to_string().contains("last four"), "{err}");

    input.ssn = "4821".into();
    input.filing_status = "Head of household".into();
    let err = employees::save(&mut conn, &input).unwrap_err();
    assert!(err.to_string().contains("filing status"), "{err}");

    input.filing_status = "Single".into();
    input.hire_date = Some("2025-02-30".into());
    let err = employees::save(&mut conn, &input).unwrap_err();
    assert!(err.to_string().contains("hire date"), "{err}");

    input.hire_date = None;
    let saved = employees::save(&mut conn, &input).unwrap();
    assert_eq!(saved.ssn_last4, "4821", "the last four are kept");

    // Two people cannot share a name in the roster or on a check.
    let mut duplicate = employee("rae lin", &owner);
    duplicate.id = None;
    let err = employees::save(&mut conn, &duplicate).unwrap_err();
    assert!(err.to_string().contains("already an employee"), "{err}");
}

#[test]
fn an_employee_with_pay_runs_is_retired_not_deleted() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let person = employees::save(&mut conn, &employee("Dana Reed", &owner)).unwrap();
    simple::save_payroll(&mut conn, &run(Some(person.id), "")).unwrap();

    let err = employees::delete(&mut conn, person.id).unwrap_err();
    assert!(err.to_string().contains("inactive"), "{err}");

    // Retiring keeps the history and stops them appearing as payable.
    let mut retire = employee("Dana Reed", &owner);
    retire.id = Some(person.id);
    retire.is_active = false;
    let retired = employees::save(&mut conn, &retire).unwrap();
    assert!(!retired.is_active);
}

#[test]
fn a_pay_run_cannot_reimburse_mileage_to_someone_off_the_roster() {
    let mut conn = company();
    let mut input = run(None, "Walk-in");
    input.pay_mileage = true;
    let err = simple::save_payroll(&mut conn, &input).unwrap_err();
    assert!(err.to_string().contains("employee record"), "{err}");
    assert!(simple::list_payroll(&conn).unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// Salaried pay and the whole Social Security number
// ---------------------------------------------------------------------------

fn salaried(name: &str, owner: &users::User, salary_cents: i64, frequency: &str) -> EmployeeInput {
    let mut input = employee(name, owner);
    input.pay_type = "Salary".into();
    input.pay_frequency = frequency.into();
    input.pay_rate_cents = 0;
    input.salary_cents = salary_cents;
    input.allowance_cents = 0;
    input.mileage_reimbursement = false;
    input
}

fn salary_run(person: &employees::Employee) -> PayrollInput {
    let mut input = run(Some(person.id), "");
    input.pay_type = person.pay_type.clone();
    input.pay_frequency = person.pay_frequency.clone();
    input.salary_cents = person.salary_cents;
    input.pay_rate_cents = 0;
    input.regular_hours_hundredths = 0;
    input.overtime_hours_hundredths = 0;
    input
}

#[test]
fn a_salary_is_paid_in_equal_periods_of_the_year() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();

    // $78,000 a year, split the four ways a business actually pays people.
    for (name, frequency, periods, period_gross) in [
        ("Weekly Paid", "Weekly", 52, 150_000),
        ("BiWeekly Paid", "BiWeekly", 26, 300_000),
        ("SemiMonthly Paid", "SemiMonthly", 24, 325_000),
        ("Monthly Paid", "Monthly", 12, 650_000),
    ] {
        let person = employees::save(&mut conn, &salaried(name, &owner, 7_800_000, frequency))
            .unwrap();
        let paid = simple::save_payroll(&mut conn, &salary_run(&person)).unwrap();

        assert_eq!(paid.gross_cents, period_gross, "{frequency} of 78,000");
        assert_eq!(paid.periods_per_year, periods);
        assert_eq!(paid.salary_cents, 7_800_000, "the run keeps the salary it used");
        assert_eq!(paid.pay_rate_cents, 0, "a salary is not an hourly rate");
        assert_eq!(paid.regular_hours_hundredths, 0, "a salary has no hours");
        assert_eq!(paid.federal_cents, period_gross * 12 / 100, "federal still applies");
        assert_eq!(paid.social_security_cents, period_gross * 620 / 10_000);
    }

    // Every period was booked as wages, and the books still balance.
    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_expense_cents,
        150_000 + 300_000 + 325_000 + 650_000
    );
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn a_period_of_salary_rounds_to_the_cent() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    // $70,000 twice a month is $2,916.666…; the check has to be a whole cent.
    let person = employees::save(&mut conn, &salaried("Dana Reed", &owner, 7_000_000, "SemiMonthly"))
        .unwrap();
    let paid = simple::save_payroll(&mut conn, &salary_run(&person)).unwrap();
    assert_eq!(paid.gross_cents, 291_667);
    assert_eq!(paid.periods_per_year, 24);
}

#[test]
fn a_salaried_run_does_not_take_hours() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let person = employees::save(&mut conn, &salaried("Dana Reed", &owner, 5_200_000, "BiWeekly"))
        .unwrap();

    let mut input = salary_run(&person);
    input.regular_hours_hundredths = 8_000;
    let err = simple::save_payroll(&mut conn, &input).unwrap_err();
    assert!(err.to_string().contains("fixed amount"), "{err}");
    assert!(simple::list_payroll(&conn).unwrap().is_empty());
}

#[test]
fn a_salary_is_required_on_a_salaried_employee() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let mut input = employee("Rae Lin", &owner);
    input.pay_type = "Salary".into();
    input.salary_cents = 0;
    let err = employees::save(&mut conn, &input).unwrap_err();
    assert!(err.to_string().contains("annual salary"), "{err}");

    input.pay_frequency = "Fortnightly".into();
    input.salary_cents = 6_000_000;
    let err = employees::save(&mut conn, &input).unwrap_err();
    assert!(err.to_string().contains("pay frequency"), "{err}");
}

#[test]
fn the_whole_social_security_number_is_kept_for_the_w2() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let mut input = employee("Rae Lin", &owner);
    input.ssn = "123-45-4821".into();
    let saved = employees::save(&mut conn, &input).unwrap();

    assert_eq!(saved.ssn, "123454821", "the W-2 needs the whole number");
    assert_eq!(saved.ssn_last4, "4821", "lists still only show the last four");

    // The audit trail is faithful: a corrected digit has to be visible, which a
    // last-four-only image could not show.
    let logged: String = conn
        .query_row(
            "SELECT COALESCE(group_concat(COALESCE(after_json, '')), '') FROM audit_log",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(logged.contains("123454821"), "the number is part of the record");

    // An edit that leaves the number alone keeps it.
    input.id = Some(saved.id);
    input.job_title = "Crew lead".into();
    let edited = employees::save(&mut conn, &input).unwrap();
    assert_eq!(edited.ssn, "123454821");
    assert_eq!(edited.job_title, "Crew lead");

    // A corrected digit is visible in the trail, before and after — the reason
    // the audit image carries the number instead of only its last four.
    input.ssn = "123-45-9902".into();
    employees::save(&mut conn, &input).unwrap();
    let changed: String = conn
        .query_row(
            "SELECT COALESCE(group_concat(COALESCE(before_json, '') || COALESCE(after_json, '')), '')
               FROM audit_log",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(changed.contains("123454821"), "the old number is on record");
    assert!(changed.contains("123459902"), "so is the correction");
}

#[test]
fn a_four_digit_number_from_an_older_file_survives_an_edit() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let mut input = employee("Rae Lin", &owner);
    input.ssn = "4821".into();
    let saved = employees::save(&mut conn, &input).unwrap();
    assert_eq!(saved.ssn, "", "four digits are not a whole number");
    assert_eq!(saved.ssn_last4, "4821");

    // Clearing the field clears the record.
    input.id = Some(saved.id);
    input.ssn = String::new();
    let cleared = employees::save(&mut conn, &input).unwrap();
    assert_eq!(cleared.ssn, "");
    assert_eq!(cleared.ssn_last4, "");
}

#[test]
fn pay_basis_and_frequency_are_remembered_on_the_employee() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let input = salaried("Rae Lin", &owner, 9_100_000, "Monthly");
    let saved = employees::save(&mut conn, &input).unwrap();

    assert_eq!(saved.pay_type, "Salary");
    assert_eq!(saved.pay_frequency, "Monthly");
    assert_eq!(saved.salary_cents, 9_100_000);

    let listed = employees::list(&conn).unwrap();
    assert_eq!(listed[0].pay_frequency, "Monthly");
}
