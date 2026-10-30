//! Tests for the plain-language record layer: every friendly record must leave
//! the books balanced, the reports consistent and the audit chain intact.

use accounting_core::db;
use accounting_core::simple::{self, ExpenseInput, IncomeInput, InvoiceInput, InvoiceLineInput, PartyInput, PayrollInput, PurchaseInput, PurchaseLineInput};
use accounting_core::{accounts, audit, reports};

fn company() -> rusqlite::Connection {
    let conn = db::open_in_memory().expect("in-memory company");
    accounts::seed_default_chart(&conn).expect("chart");
    conn
}

fn income(conn: &mut rusqlite::Connection, amount: i64, paid: bool) -> simple::IncomeRecord {
    simple::save_income(
        conn,
        &IncomeInput {
            id: None,
            entry_date: "2026-08-03".into(),
            customer_id: None,
            category: "Contract Revenue".into(),
            description: "Deck rebuild".into(),
            amount_cents: amount,
            tax_bp: 0,
            is_paid: paid,
            invoice_no: String::new(),
        },
    )
    .expect("income saved")
}

#[test]
fn recording_income_posts_a_balanced_entry() {
    let mut conn = company();
    let record = income(&mut conn, 420_000, true);

    assert!(record.journal_entry_id.is_some());
    let pnl = simple::profit_and_loss(&conn, None, None).unwrap();
    assert_eq!(pnl.total_income_cents, 420_000);
    assert_eq!(pnl.net_cents, 420_000);
    assert!(pnl.income.iter().any(|row| row.name == "Contract Revenue"));

    let trial = reports::trial_balance(&conn).unwrap();
    assert!(trial.is_balanced, "the ledger must stay balanced");
    let health = reports::ledger_is_balanced(&conn).unwrap();
    assert!(health);
}

#[test]
fn unpaid_income_waits_in_receivables_until_it_is_paid() {
    let mut conn = company();
    income(&mut conn, 100_000, false);

    let dash = simple::dashboard(&conn).unwrap();
    assert_eq!(dash.unpaid_income_cents, 100_000);
    assert_eq!(dash.cash_cents, 0, "unpaid money is not in the bank yet");

    let sheet = simple::balance_sheet(&conn, None).unwrap();
    assert!(sheet.balanced);
    assert!(sheet
        .assets
        .iter()
        .any(|row| row.name == "Accounts Receivable" && row.amount_cents == 100_000));
}

#[test]
fn a_new_category_creates_one_account_and_reuses_it() {
    let mut conn = company();
    let before = accounts::list(&conn).unwrap().len();

    for _ in 0..2 {
        simple::save_expense(
            &mut conn,
            &ExpenseInput {
                id: None,
                entry_date: "2026-08-04".into(),
                vendor_id: None,
                category: "Truck Wraps".into(),
                description: "Van lettering".into(),
                amount_cents: 45_000,
                tax_bp: 0,
                is_paid: true,
            },
        )
        .unwrap();
    }

    let chart = accounts::list(&conn).unwrap();
    assert_eq!(chart.len(), before + 1, "the category is created once");
    let created = chart
        .iter()
        .find(|account| account.name == "Truck Wraps")
        .expect("category account exists");
    assert_eq!(created.account_type.code(), "EXPENSE");
}

#[test]
fn editing_income_voids_the_old_entry_and_posts_a_new_one() {
    let mut conn = company();
    let original = income(&mut conn, 50_000, true);
    let first_entry = original.journal_entry_id.unwrap();

    let edited = simple::save_income(
        &mut conn,
        &IncomeInput {
            id: Some(original.id),
            entry_date: "2026-08-03".into(),
            customer_id: None,
            category: "Contract Revenue".into(),
            description: "Deck rebuild (corrected)".into(),
            amount_cents: 65_000,
            tax_bp: 0,
            is_paid: true,
            invoice_no: String::new(),
        },
    )
    .unwrap();

    assert_ne!(edited.journal_entry_id.unwrap(), first_entry);
    let status: String = conn
        .query_row(
            "SELECT status FROM journal_entries WHERE id = ?1",
            [first_entry],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "VOID", "the old entry is kept, marked void");
    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_income_cents,
        65_000
    );
}

#[test]
fn deleting_a_record_removes_its_effect_but_keeps_the_audit_trail() {
    let mut conn = company();
    let record = income(&mut conn, 75_000, true);
    simple::delete_income(&mut conn, record.id).unwrap();

    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_income_cents,
        0
    );
    let chain = audit::verify(&conn).unwrap();
    assert!(chain.ok, "audit chain verifies after delete: {chain:?}");
    assert!(chain.total > 0);
}

#[test]
fn sales_tax_is_collected_into_a_liability() {
    let mut conn = company();
    simple::save_income(
        &mut conn,
        &IncomeInput {
            id: None,
            entry_date: "2026-08-06".into(),
            customer_id: None,
            category: "Service Revenue".into(),
            description: "Cooler repair".into(),
            amount_cents: 100_000,
            tax_bp: 850,
            is_paid: true,
            invoice_no: String::new(),
        },
    )
    .unwrap();

    assert_eq!(simple::tax_of(100_000, 850), 8_500);
    let dash = simple::dashboard(&conn).unwrap();
    assert_eq!(dash.sales_tax_due_cents, 8_500);
    assert_eq!(dash.cash_cents, 108_500, "the customer paid tax as well");
    assert!(simple::balance_sheet(&conn, None).unwrap().balanced);
}

#[test]
fn invoices_move_stock_and_reserve_the_asset_only_once_sent() {
    let mut conn = company();
    let item = simple::save_inventory_item(
        &mut conn,
        &simple::InventoryInput {
            id: None,
            name: "Cedar post".into(),
            sku: "FP-408".into(),
            barcode: String::new(),
            category: "Lumber".into(),
            kind: "Product".into(),
            qty_hundredths: 2_000,
            unit_cost_cents: 1_450,
            sale_price_cents: 2_400,
        },
    )
    .unwrap();

    let invoice = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: None,
            invoice_no: None,
            customer_id: None,
            invoice_date: "2026-08-10".into(),
            due_date: Some("2026-09-09".into()),
            status: "Draft".into(),
            tax_bp: 0,
            lines: vec![InvoiceLineInput {
                description: "Cedar post".into(),
                qty_hundredths: 500,
                unit_price_cents: 2_400,
                inventory_item_id: Some(item.id),
            }],
        },
    )
    .unwrap();

    assert_eq!(invoice.total_cents, 12_000, "5 units at 24.00");
    assert_eq!(
        simple::item_by_id(&conn, item.id).unwrap().qty_hundredths,
        2_000,
        "a draft invoice does not touch stock"
    );
    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_income_cents,
        0,
        "a draft invoice is not revenue yet"
    );

    let sent = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: Some(invoice.id),
            invoice_no: Some(invoice.invoice_no.clone()),
            customer_id: None,
            invoice_date: "2026-08-10".into(),
            due_date: Some("2026-09-09".into()),
            status: "Sent".into(),
            tax_bp: 0,
            lines: vec![InvoiceLineInput {
                description: "Cedar post".into(),
                qty_hundredths: 500,
                unit_price_cents: 2_400,
                inventory_item_id: Some(item.id),
            }],
        },
    )
    .unwrap();

    assert!(sent.stock_deducted);
    assert_eq!(simple::item_by_id(&conn, item.id).unwrap().qty_hundredths, 1_500);
    let pnl = simple::profit_and_loss(&conn, None, None).unwrap();
    assert_eq!(pnl.total_income_cents, 12_000);
    assert_eq!(
        pnl.total_expense_cents, 7_250,
        "cost of goods sold is 5 units at the 14.50 item cost"
    );
    assert_eq!(simple::dashboard(&conn).unwrap().invoice_outstanding_cents, 12_000);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn a_paid_invoice_puts_the_money_in_the_bank_and_stops_being_outstanding() {
    let mut conn = company();
    let invoice = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: None,
            invoice_no: None,
            customer_id: None,
            invoice_date: "2026-08-11".into(),
            due_date: None,
            status: "Paid".into(),
            tax_bp: 0,
            lines: vec![InvoiceLineInput {
                description: "Consulting".into(),
                qty_hundredths: 100,
                unit_price_cents: 90_000,
                inventory_item_id: None,
            }],
        },
    )
    .unwrap();

    let dash = simple::dashboard(&conn).unwrap();
    assert_eq!(dash.cash_cents, 90_000);
    assert_eq!(dash.invoice_outstanding_cents, 0);
    assert_eq!(dash.income_cents, 90_000);
    assert_eq!(invoice.status, "Paid");
    assert!(
        simple::list_invoices(&conn).unwrap().len() == 1,
        "the invoice is stored once"
    );
}

#[test]
fn reverting_an_invoice_to_draft_restores_stock_and_voids_revenue() {
    let mut conn = company();
    let item = simple::save_inventory_item(
        &mut conn,
        &simple::InventoryInput {
            id: None,
            name: "Hinge".into(),
            sku: String::new(),
            barcode: String::new(),
            category: String::new(),
            kind: "Product".into(),
            qty_hundredths: 600,
            unit_cost_cents: 425,
            sale_price_cents: 800,
        },
    )
    .unwrap();
    let lines = vec![InvoiceLineInput {
        description: "Hinge".into(),
        qty_hundredths: 200,
        unit_price_cents: 800,
        inventory_item_id: Some(item.id),
    }];
    let sent = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: None,
            invoice_no: None,
            customer_id: None,
            invoice_date: "2026-08-12".into(),
            due_date: None,
            status: "Sent".into(),
            tax_bp: 0,
            lines: lines.clone(),
        },
    )
    .unwrap();
    assert_eq!(simple::item_by_id(&conn, item.id).unwrap().qty_hundredths, 400);

    simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: Some(sent.id),
            invoice_no: Some(sent.invoice_no.clone()),
            customer_id: None,
            invoice_date: "2026-08-12".into(),
            due_date: None,
            status: "Draft".into(),
            tax_bp: 0,
            lines,
        },
    )
    .unwrap();

    assert_eq!(simple::item_by_id(&conn, item.id).unwrap().qty_hundredths, 600);
    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_income_cents,
        0
    );
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn purchases_bring_stock_in_at_a_weighted_average_cost() {
    let mut conn = company();
    simple::save_purchase(
        &mut conn,
        &PurchaseInput {
            id: None,
            purchase_date: "2026-08-01".into(),
            vendor_id: None,
            category: "Materials".into(),
            note: String::new(),
            is_paid: true,
            lines: vec![PurchaseLineInput {
                description: "Deck screws".into(),
                qty_hundredths: 1_000,
                unit_cost_cents: 1_900,
                sale_price_cents: 2_900,
                inventory_item_id: None,
            }],
        },
    )
    .unwrap();

    let created = simple::list_inventory(&conn)
        .unwrap()
        .into_iter()
        .find(|item| item.name == "Deck screws")
        .expect("the purchase created the item");
    assert_eq!(created.qty_hundredths, 1_000);
    assert_eq!(created.unit_cost_cents, 1_900);

    simple::save_purchase(
        &mut conn,
        &PurchaseInput {
            id: None,
            purchase_date: "2026-08-05".into(),
            vendor_id: None,
            category: "Materials".into(),
            note: String::new(),
            is_paid: true,
            lines: vec![PurchaseLineInput {
                description: "Deck screws".into(),
                qty_hundredths: 1_000,
                unit_cost_cents: 2_100,
                sale_price_cents: 2_900,
                inventory_item_id: Some(created.id),
            }],
        },
    )
    .unwrap();

    let after = simple::item_by_id(&conn, created.id).unwrap();
    assert_eq!(after.qty_hundredths, 2_000);
    assert_eq!(after.unit_cost_cents, 2_000, "weighted average of 19.00 and 21.00");
    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_expense_cents,
        40_000
    );
}

#[test]
fn a_pay_run_splits_gross_pay_between_the_bank_and_liabilities() {
    let mut conn = company();
    let run = simple::save_payroll(
        &mut conn,
        &PayrollInput {
            id: None,
            employee: "J. Alvarez".into(),
            pay_date: "2026-08-15".into(),
            check_number: "1042".into(),
            pay_rate_cents: 4_000,
            regular_hours_hundredths: 8_000,
            overtime_hours_hundredths: 500,
            federal_cents: 42_000,
            state_cents: 14_000,
            social_security_cents: 21_700,
            medicare_cents: 5_100,
            other_deductions_cents: 0,
        },
    )
    .unwrap();

    assert_eq!(run.gross_cents, 350_000, "80h at 40.00 plus 5h at 60.00");
    assert_eq!(run.net_cents, 350_000 - 82_800);

    let dash = simple::dashboard(&conn).unwrap();
    assert_eq!(
        dash.cash_cents, -run.net_cents,
        "wages leave the bank, so an opening-less account is overdrawn by the net pay"
    );
    let pnl = simple::profit_and_loss(&conn, None, None).unwrap();
    assert_eq!(pnl.total_expense_cents, 350_000);
    assert!(simple::balance_sheet(&conn, None).unwrap().balanced);
}

#[test]
fn reports_can_be_narrowed_to_a_date_range() {
    let mut conn = company();
    for (day, amount) in [("2026-06-10", 10_000), ("2026-07-10", 20_000)] {
        simple::save_income(
            &mut conn,
            &IncomeInput {
                id: None,
                entry_date: day.into(),
                customer_id: None,
                category: "Service Revenue".into(),
                description: String::new(),
                amount_cents: amount,
                tax_bp: 0,
                is_paid: true,
                invoice_no: String::new(),
            },
        )
        .unwrap();
    }

    let july = simple::profit_and_loss(&conn, Some("2026-07-01"), Some("2026-07-31")).unwrap();
    assert_eq!(july.total_income_cents, 20_000);
    let everything = simple::profit_and_loss(&conn, None, None).unwrap();
    assert_eq!(everything.total_income_cents, 30_000);
}

#[test]
fn customers_and_vendors_are_created_and_linked_to_money() {
    let mut conn = company();
    let customer = simple::save_customer(
        &mut conn,
        &PartyInput {
            id: None,
            name: "Alameda Property Group".into(),
            email: "ap@example.com".into(),
            phone: String::new(),
            address: String::new(),
            notes: String::new(),
        },
    )
    .unwrap();
    simple::save_income(
        &mut conn,
        &IncomeInput {
            id: None,
            entry_date: "2026-08-20".into(),
            customer_id: Some(customer.id),
            category: "Contract Revenue".into(),
            description: "Phase 1".into(),
            amount_cents: 250_000,
            tax_bp: 0,
            is_paid: false,
            invoice_no: "INV-1001".into(),
        },
    )
    .unwrap();

    let refreshed = simple::customer_by_id(&conn, customer.id).unwrap();
    assert_eq!(refreshed.billed_cents, 250_000);
    assert_eq!(refreshed.outstanding_cents, 250_000);
    assert!(simple::delete_customer(&mut conn, customer.id).is_err());
}

#[test]
fn the_audit_chain_survives_a_full_day_of_bookkeeping() {
    let mut conn = company();
    income(&mut conn, 100_000, true);
    simple::save_expense(
        &mut conn,
        &ExpenseInput {
            id: None,
            entry_date: "2026-08-21".into(),
            vendor_id: None,
            category: "Materials".into(),
            description: "Boards".into(),
            amount_cents: 30_000,
            tax_bp: 850,
            is_paid: true,
        },
    )
    .unwrap();
    simple::save_purchase(
        &mut conn,
        &PurchaseInput {
            id: None,
            purchase_date: "2026-08-22".into(),
            vendor_id: None,
            category: "Materials".into(),
            note: String::new(),
            is_paid: false,
            lines: vec![PurchaseLineInput {
                description: "Screws".into(),
                qty_hundredths: 100,
                unit_cost_cents: 1_000,
                sale_price_cents: 2_000,
                inventory_item_id: None,
            }],
        },
    )
    .unwrap();

    let chain = audit::verify(&conn).unwrap();
    assert!(chain.ok, "audit chain verifies: {chain:?}");
    assert!(chain.total > 0);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

// ---------------------------------------------------------------------------
// Income, invoices and schedules
// ---------------------------------------------------------------------------

fn income_with_number(
    conn: &mut rusqlite::Connection,
    number: &str,
    amount: i64,
    paid: bool,
) -> simple::IncomeRecord {
    simple::save_income(
        conn,
        &IncomeInput {
            id: None,
            entry_date: "2026-08-03".into(),
            customer_id: None,
            category: "Contract Revenue".into(),
            description: "Deck rebuild".into(),
            amount_cents: amount,
            tax_bp: 0,
            is_paid: paid,
            invoice_no: number.to_string(),
        },
    )
    .expect("income saved")
}

#[test]
fn income_with_an_invoice_number_creates_that_invoice_once() {
    let mut conn = company();
    let record = income_with_number(&mut conn, "INV-2001", 150_000, true);

    assert_eq!(record.invoice_no, "INV-2001");
    let invoice_id = record.invoice_id.expect("the income owns its invoice");

    let invoices = simple::list_invoices(&conn).unwrap();
    assert_eq!(invoices.len(), 1, "one sale, one invoice");
    assert_eq!(invoices[0].id, invoice_id);
    assert_eq!(invoices[0].invoice_no, "INV-2001");
    assert_eq!(invoices[0].status, "Paid");
    assert_eq!(invoices[0].total_cents, 150_000);

    // Recording the same sale again is refused, not duplicated.
    let again = simple::save_income(
        &mut conn,
        &IncomeInput {
            id: None,
            entry_date: "2026-08-03".into(),
            customer_id: None,
            category: "Contract Revenue".into(),
            description: "Deck rebuild".into(),
            amount_cents: 150_000,
            tax_bp: 0,
            is_paid: true,
            invoice_no: "INV-2001".into(),
        },
    );
    assert!(again.is_err(), "a paid invoice cannot be paid twice");
    assert_eq!(simple::list_invoices(&conn).unwrap().len(), 1);
    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_income_cents,
        150_000
    );
    assert_eq!(simple::dashboard(&conn).unwrap().cash_cents, 150_000);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn automatic_invoice_numbers_skip_numbers_already_in_use() {
    let mut conn = company();
    income_with_number(&mut conn, "INV-1007", 10_000, true);

    let next = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: None,
            invoice_no: None,
            customer_id: None,
            invoice_date: "2026-08-20".into(),
            due_date: None,
            status: "Sent".into(),
            tax_bp: 0,
            lines: vec![InvoiceLineInput {
                description: "Consulting".into(),
                qty_hundredths: 100,
                unit_price_cents: 5_000,
                inventory_item_id: None,
            }],
        },
    )
    .unwrap();

    assert_eq!(next.invoice_no, "INV-1008", "the number already taken is skipped");
}

#[test]
fn editing_income_moves_its_invoice_with_it() {
    let mut conn = company();
    let first = income_with_number(&mut conn, "INV-2010", 50_000, false);
    let invoice_id = first.invoice_id.unwrap();

    let edited = simple::save_income(
        &mut conn,
        &IncomeInput {
            id: Some(first.id),
            entry_date: "2026-08-03".into(),
            customer_id: None,
            category: "Contract Revenue".into(),
            description: "Deck rebuild".into(),
            amount_cents: 75_000,
            tax_bp: 0,
            is_paid: false,
            invoice_no: "INV-2011".into(),
        },
    )
    .unwrap();

    assert_eq!(edited.invoice_id, Some(invoice_id), "the same invoice, renumbered");
    let invoices = simple::list_invoices(&conn).unwrap();
    assert_eq!(invoices.len(), 1, "editing does not leave a second invoice behind");
    assert_eq!(invoices[0].invoice_no, "INV-2011");
    assert_eq!(invoices[0].total_cents, 75_000);
    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_income_cents,
        75_000
    );
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn recording_income_against_a_sent_invoice_does_not_count_it_twice() {
    let mut conn = company();
    let invoice = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: None,
            invoice_no: Some("INV-3000".into()),
            customer_id: None,
            invoice_date: "2026-08-05".into(),
            due_date: None,
            status: "Sent".into(),
            tax_bp: 0,
            lines: vec![InvoiceLineInput {
                description: "Consulting".into(),
                qty_hundredths: 100,
                unit_price_cents: 100_000,
                inventory_item_id: None,
            }],
        },
    )
    .unwrap();
    assert_eq!(
        simple::dashboard(&conn).unwrap().invoice_outstanding_cents,
        100_000
    );

    let payment = income_with_number(&mut conn, "inv-3000", 100_000, true);
    assert_eq!(payment.invoice_no, "INV-3000", "the invoice's own spelling is kept");

    let invoices = simple::list_invoices(&conn).unwrap();
    assert_eq!(invoices.len(), 1, "the payment settles the invoice, it does not add one");
    assert_eq!(invoices[0].id, invoice.id);
    assert_eq!(invoices[0].status, "Paid");
    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_income_cents,
        100_000,
        "the invoice's revenue is not repeated by the payment"
    );

    let dash = simple::dashboard(&conn).unwrap();
    assert_eq!(dash.cash_cents, 100_000);
    assert_eq!(dash.invoice_outstanding_cents, 0);
    assert_eq!(dash.unpaid_income_cents, 0);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn deleting_income_removes_the_invoice_it_created() {
    let mut conn = company();
    let record = income_with_number(&mut conn, "INV-4000", 80_000, true);

    simple::delete_income(&mut conn, record.id).unwrap();

    assert!(simple::list_invoices(&conn).unwrap().is_empty());
    assert_eq!(simple::dashboard(&conn).unwrap().cash_cents, 0);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

fn monthly_schedule(
    conn: &mut rusqlite::Connection,
    end_date: Option<&str>,
) -> simple::RecurringInvoice {
    simple::save_recurring_invoice(
        conn,
        &simple::RecurringInvoiceInput {
            id: None,
            customer_id: None,
            description: "Monthly retainer".into(),
            frequency: "Monthly".into(),
            start_date: "2026-01-15".into(),
            end_date: end_date.map(str::to_string),
            tax_bp: 0,
            is_active: true,
            lines: vec![InvoiceLineInput {
                description: "Retainer".into(),
                qty_hundredths: 100,
                unit_price_cents: 25_000,
                inventory_item_id: None,
            }],
        },
    )
    .unwrap()
}

#[test]
fn a_recurring_invoice_produces_one_invoice_per_cycle() {
    let mut conn = company();
    let schedule = monthly_schedule(&mut conn, None);
    assert_eq!(schedule.next_date, "2026-01-15");

    let created = simple::generate_due_invoices(&mut conn, "2026-03-15").unwrap();
    let dates: Vec<&str> = created
        .iter()
        .map(|invoice| invoice.invoice_date.as_str())
        .collect();
    assert_eq!(dates, vec!["2026-01-15", "2026-02-15", "2026-03-15"]);
    assert!(created.iter().all(|invoice| invoice.status == "Sent"));
    let numbers: Vec<String> = created
        .iter()
        .map(|invoice| invoice.invoice_no.clone())
        .collect();
    assert_eq!(numbers, vec!["INV-1001", "INV-1002", "INV-1003"]);

    assert!(
        simple::generate_due_invoices(&mut conn, "2026-03-15").unwrap().is_empty(),
        "a cycle is only invoiced once"
    );
    let schedule = simple::get_recurring_invoice(&conn, schedule.id).unwrap();
    assert_eq!(schedule.next_date, "2026-04-15");
    assert!(schedule.is_active);

    assert_eq!(
        simple::profit_and_loss(&conn, None, None).unwrap().total_income_cents,
        75_000
    );
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn a_schedule_stops_at_its_end_date() {
    let mut conn = company();
    let schedule = monthly_schedule(&mut conn, Some("2026-03-31"));

    let created = simple::generate_due_invoices(&mut conn, "2026-06-15").unwrap();
    assert_eq!(created.len(), 3, "January, February and March only");

    let schedule = simple::get_recurring_invoice(&conn, schedule.id).unwrap();
    assert!(!schedule.is_active, "nothing is left to invoice");
    assert_eq!(schedule.next_date, "2026-04-15");
    assert!(simple::generate_due_invoices(&mut conn, "2026-12-31").unwrap().is_empty());
}
