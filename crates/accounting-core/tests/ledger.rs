//! End-to-end tests against a real company file. Every invariant is asserted
//! twice where it matters: once through the Rust API and once through raw SQL,
//! because the database — not the UI — has to be the thing that cannot be
//! talked out of the rules.

use std::path::PathBuf;

use accounting_core::accounts::{self, AccountInput, AccountType};
use accounting_core::company::{self, CompanySummary};
use accounting_core::journal::{self, EntrySource, JournalEntryInput, JournalLineInput};
use accounting_core::{audit, db, money, reports, CoreError};
use rusqlite::Connection;
use tempfile::TempDir;

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    company: CompanySummary,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let company = company::create(dir.path(), "Acme Widgets", "USD", 1).unwrap();
    let path = PathBuf::from(&company.path);
    Fixture {
        _dir: dir,
        path,
        company,
    }
}

fn open(path: &PathBuf) -> Connection {
    let conn = db::open(path).unwrap();
    db::set_actor(&conn, "tester").unwrap();
    conn
}

fn account_id(conn: &Connection, number: &str) -> i64 {
    conn.query_row("SELECT id FROM accounts WHERE number = ?1", [number], |row| {
        row.get(0)
    })
    .unwrap()
}

fn line(account: i64, debit: i64, credit: i64) -> JournalLineInput {
    JournalLineInput {
        account_id: account,
        debit_cents: debit,
        credit_cents: credit,
        memo: None,
    }
}

fn entry(lines: Vec<JournalLineInput>) -> JournalEntryInput {
    JournalEntryInput {
        entry_date: "2026-10-30".to_string(),
        memo: "test entry".to_string(),
        reference: None,
        source: EntrySource::Manual,
        lines,
    }
}

#[test]
fn new_company_is_seeded_and_audited() {
    let fixture = fixture();
    let conn = open(&fixture.path);

    assert_eq!(fixture.company.name, "Acme Widgets");
    assert_eq!(fixture.company.base_currency, "USD");
    assert_eq!(fixture.company.schema_version, 3);

    let chart = accounts::list(&conn).unwrap();
    assert_eq!(chart.len(), accounts::DEFAULT_CHART.len());
    assert!(chart.iter().any(|account| account.number == "1000"));

    // Seeding wrote through the audit triggers and the chain verifies.
    let report = audit::verify(&conn).unwrap();
    assert!(report.ok, "audit chain should verify after seeding: {report:?}");
    assert!(report.sealed > 0);
}

#[test]
fn balanced_entry_posts_and_moves_the_books() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    let posted = journal::post(
        &mut conn,
        &entry(vec![line(cash, 125_000, 0), line(sales, 0, 125_000)]),
    )
    .unwrap();

    assert_eq!(posted.summary.status, "POSTED");
    assert_eq!(posted.summary.total_cents, 125_000);
    assert_eq!(posted.lines.len(), 2);
    assert_eq!(posted.lines[0].account_number, "1000");

    let trial = reports::trial_balance(&conn).unwrap();
    assert!(trial.is_balanced);
    assert_eq!(trial.total_debit_cents, 125_000);
    assert_eq!(trial.total_credit_cents, 125_000);

    let cash_row = trial.rows.iter().find(|row| row.number == "1000").unwrap();
    assert_eq!(cash_row.balance_cents, 125_000);
    assert_eq!(cash_row.normal_balance, "DEBIT");

    let sales_row = trial.rows.iter().find(|row| row.number == "4000").unwrap();
    assert_eq!(sales_row.balance_cents, 125_000, "credit-normal accounts grow with credits");

    assert!(reports::ledger_is_balanced(&conn).unwrap());
    assert!(audit::verify(&conn).unwrap().ok);
}

#[test]
fn unbalanced_entry_is_rejected_by_the_api() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    let err = journal::post(
        &mut conn,
        &entry(vec![line(cash, 100_000, 0), line(sales, 0, 90_000)]),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("out of balance"),
        "unexpected error: {err}"
    );

    // Nothing was left behind by the rejected attempt.
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn database_refuses_to_post_an_unbalanced_entry_even_without_the_api() {
    let fixture = fixture();
    let conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    conn.execute(
        "INSERT INTO journal_entries (entry_no, entry_date, memo, status) VALUES (1, '2026-10-30', 'raw', 'DRAFT')",
        [],
    )
    .unwrap();
    let entry_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO journal_lines (entry_id, line_no, account_id, debit_cents) VALUES (?1, 1, ?2, 100000)",
        rusqlite::params![entry_id, cash],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO journal_lines (entry_id, line_no, account_id, credit_cents) VALUES (?1, 2, ?2, 99000)",
        rusqlite::params![entry_id, sales],
    )
    .unwrap();

    let err = conn
        .execute("UPDATE journal_entries SET status = 'POSTED' WHERE id = ?1", [entry_id])
        .unwrap_err();
    assert!(
        err.to_string().contains("total debits must equal total credits"),
        "unexpected error: {err}"
    );

    // A single-line entry is refused too.
    let err = conn
        .execute(
            "INSERT INTO journal_entries (entry_no, entry_date, status) VALUES (2, '2026-10-30', 'POSTED')",
            [],
        )
        .unwrap_err();
    assert!(
        err.to_string().contains("created as drafts"),
        "unexpected error: {err}"
    );
}

#[test]
fn zero_value_and_double_sided_lines_are_refused() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    let err = journal::post(&mut conn, &entry(vec![line(cash, 5_000, 5_000), line(sales, 0, 5_000)]))
        .unwrap_err();
    assert!(err.to_string().contains("not both"), "unexpected error: {err}");

    let err = journal::post(&mut conn, &entry(vec![line(cash, 0, 0), line(sales, 0, 5_000)]))
        .unwrap_err();
    assert!(err.to_string().contains("enter a debit or a credit"), "unexpected error: {err}");

    let err = journal::post(&mut conn, &entry(vec![line(cash, 0, 0), line(sales, 0, 0)]))
        .unwrap_err();
    assert!(err.to_string().contains("enter a debit or a credit"), "unexpected error: {err}");
}

#[test]
fn posted_entries_are_immutable_and_survive_deletion_attempts() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    let posted = journal::post(&mut conn, &entry(vec![line(cash, 4_200, 0), line(sales, 0, 4_200)]))
        .unwrap();
    let entry_id = posted.summary.id;

    let err = conn
        .execute(
            "INSERT INTO journal_lines (entry_id, line_no, account_id, debit_cents) VALUES (?1, 99, ?2, 1)",
            rusqlite::params![entry_id, cash],
        )
        .unwrap_err();
    assert!(err.to_string().contains("draft entry"), "unexpected error: {err}");

    let err = conn
        .execute("DELETE FROM journal_lines WHERE entry_id = ?1", [entry_id])
        .unwrap_err();
    assert!(err.to_string().contains("cannot be removed"), "unexpected error: {err}");

    let err = conn
        .execute("DELETE FROM journal_entries WHERE id = ?1", [entry_id])
        .unwrap_err();
    assert!(err.to_string().contains("cannot be deleted"), "unexpected error: {err}");

    let err = conn
        .execute("UPDATE journal_entries SET memo = 'edited' WHERE id = ?1", [entry_id])
        .unwrap_err();
    assert!(err.to_string().contains("immutable"), "unexpected error: {err}");
}

#[test]
fn only_detail_accounts_can_be_posted_to() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    accounts::create(
        &mut conn,
        &AccountInput {
            number: "1001".to_string(),
            name: "Petty Cash".to_string(),
            account_type: AccountType::Asset,
            subtype: Some("Bank".to_string()),
            parent_id: Some(cash),
            currency: None,
            description: None,
        },
    )
    .unwrap();

    let err = journal::post(&mut conn, &entry(vec![line(cash, 1_000, 0), line(sales, 0, 1_000)]))
        .unwrap_err();
    assert!(err.to_string().contains("header account"), "unexpected error: {err}");
}

#[test]
fn sub_account_type_must_match_parent() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");

    let err = accounts::create(
        &mut conn,
        &AccountInput {
            number: "1002".to_string(),
            name: "Misfiled".to_string(),
            account_type: AccountType::Income,
            subtype: None,
            parent_id: Some(cash),
            currency: None,
            description: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("same type"), "unexpected error: {err}");
}

#[test]
fn inactive_accounts_cannot_receive_postings() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    accounts::set_active(&mut conn, cash, false).unwrap();
    let err = journal::post(&mut conn, &entry(vec![line(cash, 1_000, 0), line(sales, 0, 1_000)]))
        .unwrap_err();
    assert!(err.to_string().contains("inactive"), "unexpected error: {err}");
}

#[test]
fn drafts_can_be_posted_later_and_voids_leave_the_books() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    let draft_id = journal::create_draft(
        &mut conn,
        &entry(vec![line(cash, 9_900, 0), line(sales, 0, 9_900)]),
    )
    .unwrap();
    assert_eq!(journal::get(&conn, draft_id).unwrap().summary.status, "DRAFT");
    assert!(reports::trial_balance(&conn).unwrap().rows.is_empty());

    journal::post_draft(&mut conn, draft_id).unwrap();
    assert_eq!(journal::get(&conn, draft_id).unwrap().summary.status, "POSTED");
    assert_eq!(reports::trial_balance(&conn).unwrap().total_debit_cents, 9_900);

    journal::void_entry(&mut conn, draft_id).unwrap();
    assert_eq!(journal::get(&conn, draft_id).unwrap().summary.status, "VOID");
    assert!(reports::trial_balance(&conn).unwrap().rows.is_empty());
    assert!(reports::ledger_is_balanced(&conn).unwrap());

    let err = journal::post_draft(&mut conn, draft_id).unwrap_err();
    assert!(err.to_string().contains("void"), "unexpected error: {err}");
}

#[test]
fn audit_chain_detects_tampering() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);

    accounts::create(
        &mut conn,
        &AccountInput {
            number: "1050".to_string(),
            name: "Money Market".to_string(),
            account_type: AccountType::Asset,
            subtype: None,
            parent_id: None,
            currency: None,
            description: None,
        },
    )
    .unwrap();

    let report = audit::verify(&conn).unwrap();
    assert!(report.ok, "fresh chain should verify: {report:?}");
    assert_eq!(report.unsealed, 0);

    let first: i64 = conn
        .query_row("SELECT MIN(seq) FROM audit_log", [], |row| row.get(0))
        .unwrap();
    conn.execute("UPDATE audit_log SET actor = 'mallory' WHERE seq = ?1", [first])
        .unwrap();

    let report = audit::verify(&conn).unwrap();
    assert!(!report.ok);
    assert_eq!(report.broken_at, Some(first));

    let rows = audit::list(&conn, 10).unwrap();
    assert!(!rows.is_empty());
    assert!(rows[0].seq >= rows[rows.len() - 1].seq);
}

#[test]
fn audit_rows_record_the_acting_user() {
    let fixture = fixture();
    let mut conn = db::open(&fixture.path).unwrap();
    db::set_actor(&conn, "alice").unwrap();

    accounts::create(
        &mut conn,
        &AccountInput {
            number: "1050".to_string(),
            name: "Money Market".to_string(),
            account_type: AccountType::Asset,
            subtype: None,
            parent_id: None,
            currency: None,
            description: None,
        },
    )
    .unwrap();

    let rows = audit::list(&conn, 50).unwrap();
    assert_eq!(rows[0].actor, "alice", "the newest row is attributed to the acting user");
    assert_eq!(rows[0].entity, "accounts");
    // The chart was seeded before the actor changed and stays attributed to the
    // identity that actually performed the write.
    assert!(rows.iter().any(|row| row.actor == "system"));
    assert!(audit::verify(&conn).unwrap().ok);
}

#[test]
fn money_round_trips_through_the_ledger() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let rent = account_id(&conn, "6400");

    let amount = money::parse("1,875.25").unwrap();
    assert_eq!(amount, 187_525);
    journal::post(&mut conn, &entry(vec![line(rent, amount, 0), line(cash, 0, amount)])).unwrap();

    let trial = reports::trial_balance(&conn).unwrap();
    let cash_row = trial.rows.iter().find(|row| row.number == "1000").unwrap();
    assert_eq!(money::format(cash_row.balance_cents), "-1,875.25");
}

#[test]
fn entry_numbers_are_sequential() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    for expected in 1..=3 {
        let posted = journal::post(&mut conn, &entry(vec![line(cash, 100, 0), line(sales, 0, 100)]))
            .unwrap();
        assert_eq!(posted.summary.entry_no, expected);
    }

    let listed = journal::list(&conn, 10).unwrap();
    assert_eq!(listed.len(), 3);
}

#[test]
fn invalid_dates_and_short_entries_are_refused() {
    let fixture = fixture();
    let mut conn = open(&fixture.path);
    let cash = account_id(&conn, "1000");
    let sales = account_id(&conn, "4000");

    let mut bad_date = entry(vec![line(cash, 100, 0), line(sales, 0, 100)]);
    bad_date.entry_date = "2026-02-30".to_string();
    let err = journal::post(&mut conn, &bad_date).unwrap_err();
    assert!(err.to_string().contains("date"), "unexpected error: {err}");

    let err = journal::post(&mut conn, &entry(vec![line(cash, 100, 0)])).unwrap_err();
    assert!(err.to_string().contains("at least two lines"), "unexpected error: {err}");
}

#[test]
fn company_files_are_listed_and_identifiable() {
    let dir = tempfile::tempdir().unwrap();
    company::create(dir.path(), "Acme Widgets", "USD", 1).unwrap();
    company::create(dir.path(), "Beta Bakery", "CAD", 4).unwrap();

    let listed = company::list(dir.path()).unwrap();
    assert_eq!(listed.len(), 2);
    // Sorted by name: Acme, then Beta.
    assert_eq!(listed[0].name, "Acme Widgets");
    assert_eq!(listed[0].base_currency, "USD");
    assert_eq!(listed[1].name, "Beta Bakery");
    assert_eq!(listed[1].base_currency, "CAD");
    assert!(listed[1].path.ends_with("Beta Bakery.ledgerdb"));

    // A plain SQLite file is not a company file.
    let stray = dir.path().join("notes.ledgerdb");
    Connection::open(&stray).unwrap();
    let err = company::describe(&stray).unwrap_err();
    assert!(err.to_string().contains("not a company file"));
}

#[test]
fn copying_a_company_keeps_the_books_and_changes_the_name() {
    let dir = tempfile::tempdir().unwrap();
    let original = company::create(dir.path(), "Acme Widgets", "USD", 1).unwrap();
    let copy = company::copy_to(
        std::path::Path::new(&original.path),
        dir.path(),
        "Acme Widgets 2026",
    )
    .unwrap();

    assert_eq!(copy.name, "Acme Widgets 2026");
    assert_ne!(copy.path, original.path);
    let conn = db::open(std::path::Path::new(&copy.path)).unwrap();
    assert_eq!(accounts::list(&conn).unwrap().len(), accounts::DEFAULT_CHART.len());
    assert!(audit::verify(&conn).unwrap().sealed > 0);
}

#[test]
fn opening_a_newer_file_fails_clearly() {
    let dir = tempfile::tempdir().unwrap();
    let company = company::create(dir.path(), "Future Books", "USD", 1).unwrap();
    let conn = Connection::open(&company.path).unwrap();
    conn.pragma_update(None, "user_version", 99).unwrap();
    drop(conn);

    let err = match db::open(std::path::Path::new(&company.path)) {
        Ok(_) => panic!("expected a version error"),
        Err(err) => err,
    };
    match err {
        CoreError::Validation(message) => assert!(message.contains("newer version")),
        other => panic!("unexpected error: {other}"),
    }
}
