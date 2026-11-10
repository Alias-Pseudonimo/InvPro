//! Tests for the documents that come before an invoice.
//!
//! The point of these documents is that they never touch the ledger. A quote is
//! a promise, an order is a commitment, and only the invoice is money. These
//! tests hold that line, and hold the one-way conversion and its frozen lines.

use accounting_core::db;
use accounting_core::pipeline::{self, EstimateInput, SalesOrderInput};
use accounting_core::simple::{
    self, Customer, InvoiceInput, InvoiceLineInput, PartyInput, PayrollInput,
};
use accounting_core::{accounts, reports};

fn company() -> rusqlite::Connection {
    let conn = db::open_in_memory().expect("in-memory company");
    accounts::seed_default_chart(&conn).expect("chart");
    conn
}

fn customer(conn: &mut rusqlite::Connection) -> Customer {
    simple::save_customer(
        conn,
        &PartyInput {
            id: None,
            name: "Alameda Property Group".into(),
            email: "books@alameda.example".into(),
            phone: "510-555-0110".into(),
            address: "9 Harbor Way\nAlameda, CA".into(),
            notes: String::new(),
        },
    )
    .expect("customer")
}

fn line(description: &str, qty: i64, price: i64) -> InvoiceLineInput {
    InvoiceLineInput {
        description: description.into(),
        qty_hundredths: qty * 100,
        unit_price_cents: price,
        inventory_item_id: None,
    }
}

fn estimate_input(customer_id: i64) -> EstimateInput {
    EstimateInput {
        id: None,
        estimate_no: None,
        customer_id: Some(customer_id),
        estimate_date: "2026-08-01".into(),
        expiry_date: Some("2026-08-31".into()),
        status: "Sent".into(),
        tax_bp: 0,
        notes: "Deck rebuild".into(),
        lines: vec![line("Deck rebuild — labour", 1, 320_000), line("Sealant", 1, 6_000)],
    }
}

fn entries(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn a_quote_never_touches_the_ledger() {
    let mut conn = company();
    let party = customer(&mut conn);

    let estimate = pipeline::save_estimate(&mut conn, &estimate_input(party.id)).unwrap();
    assert_eq!(estimate.estimate_no, "EST-1001");
    assert_eq!(estimate.total_cents, 326_000);
    assert_eq!(entries(&conn), 0, "a quote is not a transaction");
    assert_eq!(reports::trial_balance(&conn).unwrap().total_debit_cents, 0);

    // Turning it into an invoice is still only paperwork while it is a draft...
    let invoice = pipeline::convert_estimate_to_invoice(&mut conn, estimate.id, Some("2026-08-04"))
        .unwrap();
    assert_eq!(invoice.status, "Draft");
    assert_eq!(invoice.total_cents, 326_000);
    assert_eq!(invoice.lines.len(), 2);
    assert_eq!(entries(&conn), 0, "a draft invoice has not been posted");

    // ...and becomes real money when the invoice is sent.
    let saved = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: Some(invoice.id),
            invoice_no: Some(invoice.invoice_no.clone()),
            customer_id: invoice.customer_id,
            invoice_date: invoice.invoice_date.clone(),
            due_date: Some("2026-09-03".into()),
            status: "Sent".into(),
            tax_bp: 0,
            lines: vec![line("Deck rebuild — labour", 1, 320_000), line("Sealant", 1, 6_000)],
        },
    )
    .unwrap();
    assert_eq!(saved.status, "Sent");
    assert!(entries(&conn) >= 1);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn a_converted_quote_is_history_and_cannot_be_edited() {
    let mut conn = company();
    let party = customer(&mut conn);
    let estimate = pipeline::save_estimate(&mut conn, &estimate_input(party.id)).unwrap();

    pipeline::convert_estimate_to_invoice(&mut conn, estimate.id, None).unwrap();

    let frozen = pipeline::estimate_by_id(&conn, estimate.id).unwrap();
    assert_eq!(frozen.status, "Accepted");
    assert!(frozen.converted_invoice_id.is_some());
    assert!(frozen.converted_at.is_some());
    assert!(frozen.invoice_no.is_some());

    let mut retry = estimate_input(party.id);
    retry.id = Some(estimate.id);
    let err = pipeline::save_estimate(&mut conn, &retry).unwrap_err();
    assert!(
        err.to_string().contains("already become"),
        "the engine explains why: {err}"
    );

    // And the database refuses even if a caller goes around the engine.
    let raw = conn.execute(
        "DELETE FROM estimate_lines WHERE estimate_id = ?1",
        [estimate.id],
    );
    assert!(raw.is_err(), "the trigger must freeze converted lines");

    let delete = pipeline::delete_estimate(&mut conn, estimate.id).unwrap_err();
    assert!(delete.to_string().contains("stays on file"));
}

#[test]
fn a_quote_becomes_an_order_and_the_order_becomes_the_bill() {
    let mut conn = company();
    let party = customer(&mut conn);
    let estimate = pipeline::save_estimate(&mut conn, &estimate_input(party.id)).unwrap();

    let order = pipeline::convert_estimate_to_order(&mut conn, estimate.id, Some("2026-08-05")).unwrap();
    assert_eq!(order.order_no, "SO-1001");
    assert_eq!(order.status, "Confirmed");
    assert_eq!(order.estimate_no.as_deref(), Some("EST-1001"));
    assert_eq!(order.total_cents, 326_000);

    let after_order = pipeline::estimate_by_id(&conn, estimate.id).unwrap();
    assert_eq!(after_order.converted_order_id, Some(order.id));
    assert_eq!(after_order.converted_invoice_id, None);

    let invoice = pipeline::convert_order_to_invoice(&mut conn, order.id, Some("2026-08-20")).unwrap();
    assert_eq!(invoice.customer_id, Some(party.id));
    assert_eq!(invoice.total_cents, 326_000);

    let invoiced = pipeline::sales_order_by_id(&conn, order.id).unwrap();
    assert_eq!(invoiced.status, "Fulfilled");
    assert_eq!(invoiced.invoice_id, Some(invoice.id));

    let quote = pipeline::estimate_by_id(&conn, estimate.id).unwrap();
    assert_eq!(
        quote.converted_invoice_id,
        Some(invoice.id),
        "the quote shows the invoice the whole chain produced"
    );

    let again = pipeline::convert_order_to_invoice(&mut conn, order.id, None).unwrap_err();
    assert!(again.to_string().contains("already been invoiced"));
}

#[test]
fn deleting_the_invoice_opens_the_quote_again() {
    let mut conn = company();
    let party = customer(&mut conn);
    let estimate = pipeline::save_estimate(&mut conn, &estimate_input(party.id)).unwrap();
    let invoice =
        pipeline::convert_estimate_to_invoice(&mut conn, estimate.id, Some("2026-08-04")).unwrap();

    simple::delete_invoice(&mut conn, invoice.id).unwrap();

    let reopened = pipeline::estimate_by_id(&conn, estimate.id).unwrap();
    assert_eq!(reopened.converted_invoice_id, None);
    assert_eq!(reopened.converted_at, None, "nothing depends on it any more");

    let mut edit = estimate_input(party.id);
    edit.id = Some(estimate.id);
    edit.lines = vec![line("Deck rebuild — revised", 1, 300_000)];
    let revised = pipeline::save_estimate(&mut conn, &edit).unwrap();
    assert_eq!(revised.total_cents, 300_000);
    assert_eq!(revised.lines.len(), 1);
}

#[test]
fn each_document_family_keeps_its_own_numbers() {
    let mut conn = company();
    let party = customer(&mut conn);

    let first = pipeline::save_estimate(&mut conn, &estimate_input(party.id)).unwrap();
    let second = pipeline::save_estimate(&mut conn, &estimate_input(party.id)).unwrap();
    assert_eq!(first.estimate_no, "EST-1001");
    assert_eq!(second.estimate_no, "EST-1002");

    let order = pipeline::save_sales_order(
        &mut conn,
        &SalesOrderInput {
            id: None,
            order_no: None,
            customer_id: Some(party.id),
            order_date: "2026-08-02".into(),
            requested_date: Some("2026-08-20".into()),
            status: "Confirmed".into(),
            tax_bp: 0,
            notes: String::new(),
            lines: vec![line("Gate hardware", 2, 8_500)],
        },
    )
    .unwrap();
    assert_eq!(order.order_no, "SO-1001");

    let invoice = pipeline::convert_order_to_invoice(&mut conn, order.id, None).unwrap();
    assert!(
        invoice.invoice_no.starts_with("INV-"),
        "an invoice number stays an invoice number: {}",
        invoice.invoice_no
    );
}

#[test]
fn a_declined_quote_cannot_become_paperwork() {
    let mut conn = company();
    let party = customer(&mut conn);
    let mut input = estimate_input(party.id);
    input.status = "Declined".into();
    let estimate = pipeline::save_estimate(&mut conn, &input).unwrap();

    let err = pipeline::convert_estimate_to_invoice(&mut conn, estimate.id, None).unwrap_err();
    assert!(err.to_string().contains("Declined"), "{err}");
    let err = pipeline::convert_estimate_to_order(&mut conn, estimate.id, None).unwrap_err();
    assert!(err.to_string().contains("Declined"), "{err}");
}

fn pay_run(marital: &str, allowances: i64) -> PayrollInput {
    PayrollInput {
        id: None,
        employee_id: None,
        employee: "J. Alvarez".into(),
        pay_date: "2026-08-15".into(),
        check_number: "1042".into(),
        pay_rate_cents: 4_000,
        pay_type: "Hourly".into(),
        pay_frequency: "BiWeekly".into(),
        salary_cents: 0,
        regular_hours_hundredths: 8_000,
        overtime_hours_hundredths: 500,
        marital_status: marital.into(),
        allowances,
        extra_withholding_cents: 0,
        other_deductions_cents: 0,
        pay_mileage: false,
        pay_allowance: false,
        allowance_cents: 0,
    }
}

#[test]
fn marital_status_and_allowances_change_federal_withholding() {
    let mut conn = company();

    let single = simple::save_payroll(&mut conn, &pay_run("Single", 0)).unwrap();
    assert_eq!(single.gross_cents, 350_000);
    assert_eq!(single.federal_cents, 42_000, "12% of gross");

    let married = simple::save_payroll(&mut conn, &pay_run("Married", 0)).unwrap();
    assert_eq!(married.federal_cents, 28_000, "8% of gross");

    let married_with_allowances = simple::save_payroll(&mut conn, &pay_run("Married", 2)).unwrap();
    assert_eq!(
        married_with_allowances.allowances, 2,
        "the claim is kept with the pay run"
    );
    // Two allowances at $194 each come off the federal base first.
    assert_eq!(married_with_allowances.federal_cents, 24_896);
    assert!(married_with_allowances.net_cents > single.net_cents);

    // The preview is the same arithmetic as the saved run, so the composer
    // cannot show one number and save another.
    let preview = simple::preview_payroll(&conn, &pay_run("Married", 2)).unwrap();
    assert_eq!(preview.federal_cents, married_with_allowances.federal_cents);
    assert_eq!(preview.net_cents, married_with_allowances.net_cents);
    assert_eq!(preview.gross_cents, married_with_allowances.gross_cents);

    assert!(simple::balance_sheet(&conn, None).unwrap().balanced);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}
