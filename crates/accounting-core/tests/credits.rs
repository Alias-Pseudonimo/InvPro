//! Credit memos, access levels, time entries and closing the books. Each test
//! checks the books themselves — the trial balance, the account balances and the
//! invoice — not just the record that was written.

use accounting_core::credits::{self, CreditMemoInput, CreditMemoLineInput};
use accounting_core::db;
use accounting_core::simple::{
    self, InventoryInput, InvoiceInput, InvoiceLineInput, PartyInput,
};
use accounting_core::users::{self, Capability, TimeEntryInput, UserInput};
use accounting_core::{accounts, reports};
use rusqlite::Connection;

fn company() -> Connection {
    let conn = db::open_in_memory().expect("in-memory company");
    accounts::seed_default_chart(&conn).expect("chart");
    conn
}

fn customer(conn: &mut Connection, name: &str) -> i64 {
    simple::save_customer(
        conn,
        &PartyInput {
            id: None,
            name: name.into(),
            email: String::new(),
            phone: String::new(),
            address: String::new(),
            notes: String::new(),
        },
    )
    .expect("customer")
    .id
}

fn line(description: &str, qty_hundredths: i64, unit_price_cents: i64) -> InvoiceLineInput {
    InvoiceLineInput {
        description: description.into(),
        qty_hundredths,
        unit_price_cents,
        inventory_item_id: None,
    }
}

fn invoice(conn: &mut Connection, lines: Vec<InvoiceLineInput>, status: &str) -> simple::Invoice {
    let customer_id = customer(conn, "Alameda Property Group");
    simple::save_invoice(
        conn,
        &InvoiceInput {
            id: None,
            invoice_no: None,
            customer_id: Some(customer_id),
            invoice_date: "2026-08-01".into(),
            due_date: None,
            status: status.into(),
            tax_bp: 0,
            lines,
        },
    )
    .expect("invoice")
}

fn posted_entries(conn: &Connection, source: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM journal_entries WHERE source = ?1 AND status = 'POSTED'",
        [source],
        |row| row.get(0),
    )
    .unwrap()
}

/// The account's balance as the report would print it. The trial balance hides
/// accounts with no movement, so this asks the accounts directly and reads a
/// quiet account as zero.
fn balance(conn: &Connection, account_name: &str) -> i64 {
    conn.query_row(
        "SELECT a.type,
                COALESCE(SUM(l.debit_cents), 0),
                COALESCE(SUM(l.credit_cents), 0)
           FROM accounts a
           LEFT JOIN journal_lines l
                  ON l.account_id = a.id
                 AND l.entry_id IN (SELECT id FROM journal_entries WHERE status = 'POSTED')
          WHERE a.name = ?1
          GROUP BY a.id, a.type",
        [account_name],
        |row| {
            let code: String = row.get(0)?;
            let debits: i64 = row.get(1)?;
            let credits: i64 = row.get(2)?;
            let account_type = accounting_core::accounts::AccountType::parse(&code)
                .unwrap_or(accounting_core::accounts::AccountType::Asset);
            Ok(if account_type.is_debit_normal() {
                debits - credits
            } else {
                credits - debits
            })
        },
    )
    .unwrap_or_else(|_| panic!("{account_name} is not in the chart"))
}

fn memo(
    conn: &mut Connection,
    invoice: &simple::Invoice,
    qty_hundredths: i64,
    outcome: &str,
    status: &str,
) -> credits::CreditMemo {
    credits::save_credit_memo(
        conn,
        &CreditMemoInput {
            id: None,
            invoice_id: invoice.id,
            memo_no: None,
            memo_date: "2026-08-10".into(),
            reason: "Damaged goods".into(),
            status: status.into(),
            outcome: outcome.into(),
            tax_bp: 0,
            lines: vec![CreditMemoLineInput {
                invoice_line_id: Some(invoice.lines[0].id),
                description: String::new(),
                qty_hundredths,
                unit_price_cents: 0,
                inventory_item_id: None,
            }],
        },
    )
    .expect("credit memo")
}

#[test]
fn applying_a_credit_reduces_what_the_customer_owes() {
    let mut conn = company();
    let bill = invoice(&mut conn, vec![line("Deck rebuild", 500, 10_000)], "Sent");
    assert_eq!(balance(&conn, "Accounts Receivable"), 50_000);

    let credit = memo(&mut conn, &bill, 200, "Apply", "Posted");
    assert_eq!(credit.total_cents, 20_000);
    assert_eq!(credit.memo_no, "CM-1001");

    // The customer owes less, revenue is lower, and the books still balance.
    assert_eq!(balance(&conn, "Accounts Receivable"), 30_000);
    assert_eq!(balance(&conn, "Sales Revenue"), 30_000);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);

    let after = simple::get_invoice(&conn, bill.id).unwrap();
    assert_eq!(after.credited_cents, 20_000);
    // Applying books the credit itself and nothing else: no refund entry.
    assert_eq!(posted_entries(&conn, "PAYMENT"), 0);
    // The money lives on the invoice, not in a floating record.
    assert_eq!(simple::list_invoices(&conn).unwrap().len(), 1);
}

#[test]
fn refunding_a_credit_puts_money_back_in_the_customers_hands() {
    let mut conn = company();
    let bill = invoice(&mut conn, vec![line("Deck rebuild", 500, 10_000)], "Paid");
    // Paid means the full $500 landed in the bank.
    assert_eq!(balance(&conn, "Checking"), 50_000);

    let credit = memo(&mut conn, &bill, 200, "Refund", "Posted");

    assert_eq!(balance(&conn, "Checking"), 30_000, "cash left the bank");
    assert_eq!(balance(&conn, "Accounts Receivable"), 0, "receivable cleared");
    assert_eq!(posted_entries(&conn, "PAYMENT"), 2, "the sale and the refund");
    let _ = credit;
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn a_retained_credit_becomes_a_liability_not_a_negative_receivable() {
    let mut conn = company();
    let bill = invoice(&mut conn, vec![line("Deck rebuild", 500, 10_000)], "Sent");

    memo(&mut conn, &bill, 200, "Credit", "Posted");

    // The receivable is whole again: the customer's $200 now sits in a
    // liability they can spend on a future invoice, not as a dent in AR.
    assert_eq!(balance(&conn, "Accounts Receivable"), 50_000);
    assert_eq!(balance(&conn, "Customer Credits"), 20_000);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn the_three_outcomes_post_three_different_things() {
    let mut applied = company();
    let invoice_a = invoice(&mut applied, vec![line("Work", 100, 10_000)], "Sent");
    memo(&mut applied, &invoice_a, 100, "Apply", "Posted");
    let apply_cash = balance(&applied, "Checking");
    let apply_credit_liability = balance(&applied, "Customer Credits");

    let mut refunded = company();
    let invoice_b = invoice(&mut refunded, vec![line("Work", 100, 10_000)], "Sent");
    memo(&mut refunded, &invoice_b, 100, "Refund", "Posted");
    let refund_cash = balance(&refunded, "Checking");

    let mut retained = company();
    let invoice_c = invoice(&mut retained, vec![line("Work", 100, 10_000)], "Sent");
    memo(&mut retained, &invoice_c, 100, "Credit", "Posted");
    let retain_credit_liability = balance(&retained, "Customer Credits");

    assert_eq!(apply_cash, 0);
    assert_eq!(refund_cash, -10_000, "a refund walks money out of the bank");
    assert_eq!(apply_credit_liability, 0);
    assert_eq!(retain_credit_liability, 10_000);
}

#[test]
fn a_credit_cannot_be_more_than_the_invoice_charged() {
    let mut conn = company();
    let bill = invoice(&mut conn, vec![line("Deck rebuild", 500, 10_000)], "Sent");

    let too_many = credits::save_credit_memo(
        &mut conn,
        &CreditMemoInput {
            id: None,
            invoice_id: bill.id,
            memo_no: None,
            memo_date: "2026-08-10".into(),
            reason: "Returned goods".into(),
            status: "Draft".into(),
            outcome: "Apply".into(),
            tax_bp: 0,
            lines: vec![CreditMemoLineInput {
                invoice_line_id: Some(bill.lines[0].id),
                description: String::new(),
                qty_hundredths: 600,
                unit_price_cents: 0,
                inventory_item_id: None,
            }],
        },
    )
    .expect_err("six of five cannot be credited");
    assert!(too_many.to_string().contains("only has 5.00"));

    // Two valid partial credits add up, but a third cannot push past the total.
    memo(&mut conn, &bill, 300, "Apply", "Posted");
    memo(&mut conn, &bill, 200, "Apply", "Posted");
    let third = credits::save_credit_memo(
        &mut conn,
        &CreditMemoInput {
            id: None,
            invoice_id: bill.id,
            memo_no: None,
            memo_date: "2026-08-11".into(),
            reason: "Goodwill".into(),
            status: "Draft".into(),
            outcome: "Apply".into(),
            tax_bp: 0,
            lines: vec![CreditMemoLineInput {
                invoice_line_id: None,
                description: "Goodwill".into(),
                qty_hundredths: 100,
                unit_price_cents: 1,
                inventory_item_id: None,
            }],
        },
    )
    .expect_err("nothing is left to credit");
    assert!(third.to_string().contains("only 0.00 is left"));
}

#[test]
fn a_draft_credit_can_change_but_a_posted_one_is_frozen() {
    let mut conn = company();
    let bill = invoice(&mut conn, vec![line("Deck rebuild", 500, 10_000)], "Sent");

    let draft = memo(&mut conn, &bill, 100, "Apply", "Draft");
    assert_eq!(balance(&conn, "Accounts Receivable"), 50_000, "drafts post nothing");

    // A draft may be edited in place.
    let edited = credits::save_credit_memo(
        &mut conn,
        &CreditMemoInput {
            id: Some(draft.id),
            invoice_id: bill.id,
            memo_no: Some(draft.memo_no.clone()),
            memo_date: "2026-08-12".into(),
            reason: "Pricing error".into(),
            status: "Draft".into(),
            outcome: "Credit".into(),
            tax_bp: 0,
            lines: vec![CreditMemoLineInput {
                invoice_line_id: Some(bill.lines[0].id),
                description: String::new(),
                qty_hundredths: 200,
                unit_price_cents: 0,
                inventory_item_id: None,
            }],
        },
    )
    .expect("a draft can be edited");
    assert_eq!(edited.total_cents, 20_000);

    // Posting it freezes the money.
    let posted = credits::save_credit_memo(
        &mut conn,
        &CreditMemoInput {
            id: Some(draft.id),
            invoice_id: bill.id,
            memo_no: Some(draft.memo_no.clone()),
            memo_date: edited.memo_date.clone(),
            reason: edited.reason.clone(),
            status: "Posted".into(),
            outcome: edited.outcome.clone(),
            tax_bp: 0,
            lines: vec![CreditMemoLineInput {
                invoice_line_id: Some(bill.lines[0].id),
                description: String::new(),
                qty_hundredths: 200,
                unit_price_cents: 0,
                inventory_item_id: None,
            }],
        },
    )
    .expect("posting a draft");
    assert_eq!(posted.status, "Posted");
    assert_eq!(balance(&conn, "Customer Credits"), 20_000);

    let late_edit = credits::save_credit_memo(
        &mut conn,
        &CreditMemoInput {
            id: Some(posted.id),
            invoice_id: bill.id,
            memo_no: Some(posted.memo_no.clone()),
            memo_date: "2026-08-13".into(),
            reason: "Changed my mind".into(),
            status: "Posted".into(),
            outcome: "Apply".into(),
            tax_bp: 0,
            lines: vec![CreditMemoLineInput {
                invoice_line_id: Some(bill.lines[0].id),
                description: String::new(),
                qty_hundredths: 100,
                unit_price_cents: 0,
                inventory_item_id: None,
            }],
        },
    )
    .expect_err("posted money is frozen");
    assert!(late_edit.to_string().contains("already posted"));

    // Even behind the app's back, the database refuses.
    let raw = conn.execute(
        "UPDATE credit_memos SET total_cents = 1 WHERE id = ?1",
        [posted.id],
    );
    assert!(raw.is_err());

    // Voiding is the corrections path, and it returns everything.
    credits::void_credit_memo(&mut conn, posted.id).expect("void");
    assert_eq!(balance(&conn, "Customer Credits"), 0);
    assert_eq!(balance(&conn, "Accounts Receivable"), 50_000);
    let after = simple::get_invoice(&conn, bill.id).unwrap();
    assert_eq!(after.credited_cents, 0);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);
}

#[test]
fn crediting_a_stock_item_puts_the_stock_back() {
    let mut conn = company();
    let item = simple::save_inventory_item(
        &mut conn,
        &InventoryInput {
            id: None,
            name: "Cedar fence post".into(),
            sku: "FP-408".into(),
            barcode: String::new(),
            category: "Lumber".into(),
            kind: "Product".into(),
            qty_hundredths: 3_400,
            unit_cost_cents: 1_450,
            sale_price_cents: 2_400,
        },
    )
    .expect("item");

    let customer_id = customer(&mut conn, "Alameda Property Group");
    let bill = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: None,
            invoice_no: None,
            customer_id: Some(customer_id),
            invoice_date: "2026-08-01".into(),
            due_date: None,
            status: "Sent".into(),
            tax_bp: 0,
            lines: vec![InvoiceLineInput {
                description: item.name.clone(),
                qty_hundredths: 1_000,
                unit_price_cents: 2_400,
                inventory_item_id: Some(item.id),
            }],
        },
    )
    .expect("invoice");
    let on_hand = |conn: &Connection| {
        conn.query_row(
            "SELECT qty_hundredths FROM inventory_items WHERE id = ?1",
            [item.id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!(on_hand(&conn), 2_400);

    let credit = credits::save_credit_memo(
        &mut conn,
        &CreditMemoInput {
            id: None,
            invoice_id: bill.id,
            memo_no: None,
            memo_date: "2026-08-10".into(),
            reason: "Returned goods".into(),
            status: "Posted".into(),
            outcome: "Apply".into(),
            tax_bp: 0,
            lines: vec![CreditMemoLineInput {
                invoice_line_id: Some(bill.lines[0].id),
                description: String::new(),
                qty_hundredths: 400,
                unit_price_cents: 0,
                inventory_item_id: None,
            }],
        },
    )
    .expect("credit memo");

    assert_eq!(on_hand(&conn), 2_800, "returned stock is stock again");
    assert!(credit.stock_returned);
    // Cost of goods sold comes back down by 4 × $14.50.
    assert_eq!(balance(&conn, "Cost of Goods Sold"), 8_700);
    assert!(reports::trial_balance(&conn).unwrap().is_balanced);

    credits::void_credit_memo(&mut conn, credit.id).expect("void");
    assert_eq!(on_hand(&conn), 2_400, "voiding takes the stock out again");
}

#[test]
fn a_draft_invoice_cannot_be_credited_because_nothing_was_charged() {
    let mut conn = company();
    let bill = invoice(&mut conn, vec![line("Deck rebuild", 100, 10_000)], "Draft");
    let refusal = credits::save_credit_memo(
        &mut conn,
        &CreditMemoInput {
            id: None,
            invoice_id: bill.id,
            memo_no: None,
            memo_date: "2026-08-10".into(),
            reason: "Damaged goods".into(),
            status: "Draft".into(),
            outcome: "Apply".into(),
            tax_bp: 0,
            lines: vec![CreditMemoLineInput {
                invoice_line_id: Some(bill.lines[0].id),
                description: String::new(),
                qty_hundredths: 100,
                unit_price_cents: 0,
                inventory_item_id: None,
            }],
        },
    )
    .expect_err("drafts are not on the books");
    assert!(refusal.to_string().contains("still a draft"));
}

#[test]
fn an_invoice_with_credits_keeps_its_money_and_cannot_be_deleted() {
    let mut conn = company();
    let bill = invoice(&mut conn, vec![line("Deck rebuild", 500, 10_000)], "Sent");
    memo(&mut conn, &bill, 100, "Apply", "Posted");

    let edit = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: Some(bill.id),
            invoice_no: Some(bill.invoice_no.clone()),
            customer_id: bill.customer_id,
            invoice_date: bill.invoice_date.clone(),
            due_date: None,
            status: "Sent".into(),
            tax_bp: 0,
            lines: vec![line("Something else entirely", 500, 10_000)],
        },
    );
    assert!(edit.is_err(), "lines are fixed once a credit exists");

    let delete = simple::delete_invoice(&mut conn, bill.id);
    assert!(delete.is_err(), "the credit would point at nothing");

    // Marking the credited invoice paid only banks what is left owing.
    simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: Some(bill.id),
            invoice_no: Some(bill.invoice_no.clone()),
            customer_id: bill.customer_id,
            invoice_date: bill.invoice_date.clone(),
            due_date: None,
            status: "Paid".into(),
            tax_bp: 0,
            lines: vec![line("Deck rebuild", 500, 10_000)],
        },
    )
    .expect("status can still move");
    assert_eq!(balance(&conn, "Checking"), 40_000);
    assert_eq!(balance(&conn, "Accounts Receivable"), 0);
}

#[test]
fn closing_the_books_stops_backdated_postings() {
    let mut conn = company();
    let bill = invoice(&mut conn, vec![line("Deck rebuild", 100, 10_000)], "Sent");

    simple::put_setting(&mut conn, "books_locked_through", "2026-08-31").unwrap();

    let late = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: None,
            invoice_no: None,
            customer_id: bill.customer_id,
            invoice_date: "2026-08-20".into(),
            due_date: None,
            status: "Sent".into(),
            tax_bp: 0,
            lines: vec![line("Late work", 100, 5_000)],
        },
    )
    .expect_err("a closed period refuses new money");
    assert!(late.to_string().contains("closed through 2026-08-31"));

    let open = simple::save_invoice(
        &mut conn,
        &InvoiceInput {
            id: None,
            invoice_no: None,
            customer_id: bill.customer_id,
            invoice_date: "2026-09-01".into(),
            due_date: None,
            status: "Sent".into(),
            tax_bp: 0,
            lines: vec![line("New work", 100, 5_000)],
        },
    );
    assert!(open.is_ok(), "the day after the lock is open for business");
}

#[test]
fn the_last_admin_cannot_lock_themselves_out() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    assert_eq!(owner.access, "Admin");

    let demote = users::save_user(
        &mut conn,
        &UserInput {
            id: Some(owner.id),
            name: owner.name.clone(),
            email: String::new(),
            access: "ReadOnly".into(),
            is_active: true,
        },
    );
    assert!(demote.is_err(), "there must always be an admin");

    let bookkeeper = users::save_user(
        &mut conn,
        &UserInput {
            id: None,
            name: "Sam the bookkeeper".into(),
            email: "sam@example.com".into(),
            access: "Standard".into(),
            is_active: true,
        },
    )
    .expect("a second person");
    assert_eq!(bookkeeper.access, "Standard");

    let duplicate = users::save_user(
        &mut conn,
        &UserInput {
            id: None,
            name: "Sam the bookkeeper".into(),
            email: String::new(),
            access: "ReadOnly".into(),
            is_active: true,
        },
    );
    assert!(duplicate.is_err());

    // With another admin in place the original can step down.
    users::save_user(
        &mut conn,
        &UserInput {
            id: Some(bookkeeper.id),
            name: bookkeeper.name.clone(),
            email: bookkeeper.email.clone(),
            access: "Admin".into(),
            is_active: true,
        },
    )
    .unwrap();
    users::save_user(
        &mut conn,
        &UserInput {
            id: Some(owner.id),
            name: owner.name.clone(),
            email: String::new(),
            access: "Standard".into(),
            is_active: true,
        },
    )
    .expect("no longer the only admin");
}

#[test]
fn payroll_is_a_level_of_its_own() {
    let mut conn = company();
    let payroll = users::save_user(
        &mut conn,
        &UserInput {
            id: None,
            name: "Priya Raman".into(),
            email: "priya@example.com".into(),
            access: "Payroll Specialist".into(),
            is_active: true,
        },
    )
    .expect("a payroll person");
    assert_eq!(payroll.access, "Payroll", "the long name is stored as the level");

    // Payroll reaches the roster and the runs, and nothing that touches the
    // books directly. Standard is the other way round, which is the point.
    assert!(users::allows(&payroll.access, Capability::ManagePayroll));
    assert!(!users::allows(&payroll.access, Capability::EditRecords));
    assert!(!users::allows(&payroll.access, Capability::ManageUsers));

    users::set_current_user(&mut conn, payroll.id).unwrap();
    let stored = users::current_user(&conn).unwrap();
    assert_eq!(stored.access, "Payroll", "the level survives a reopen");

    let typo = users::save_user(
        &mut conn,
        &UserInput {
            id: None,
            name: "Someone Else".into(),
            email: String::new(),
            access: "Payroll Clerk".into(),
            is_active: true,
        },
    );
    assert!(typo.is_err(), "an unknown level is refused rather than downgraded");
}

#[test]
fn the_acting_user_is_the_name_on_the_audit_trail() {
    let mut conn = company();
    let bookkeeper = users::save_user(
        &mut conn,
        &UserInput {
            id: None,
            name: "Sam the bookkeeper".into(),
            email: String::new(),
            access: "Standard".into(),
            is_active: true,
        },
    )
    .unwrap();
    users::set_current_user(&mut conn, bookkeeper.id).unwrap();
    assert_eq!(db::actor(&conn).unwrap(), "Sam the bookkeeper");

    customer(&mut conn, "Nguyen Family Trust");
    let actor: String = conn
        .query_row(
            "SELECT actor FROM audit_log WHERE entity = 'customers' ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(actor, "Sam the bookkeeper");
}

#[test]
fn time_entry_people_only_see_their_own_sheet() {
    let mut conn = company();
    let owner = users::current_user(&conn).unwrap();
    let helper = users::save_user(
        &mut conn,
        &UserInput {
            id: None,
            name: "Rae".into(),
            email: String::new(),
            access: "TimeEntry".into(),
            is_active: true,
        },
    )
    .unwrap();

    let entry = |conn: &mut Connection, viewer: &users::User, hours: i64| {
        users::save_time_entry(
            conn,
            viewer,
            &TimeEntryInput {
                id: None,
                user_id: None,
                entry_date: "2026-08-05".into(),
                kind: "Time".into(),
                description: "Fence install".into(),
                customer: "Alameda Property Group".into(),
                quantity_hundredths: hours,
                rate_cents: 8_500,
                is_billable: true,
            },
        )
    };

    entry(&mut conn, &owner, 400).unwrap();
    let rae_entry = entry(&mut conn, &helper, 250).unwrap();
    assert_eq!(rae_entry.entered_by, "Rae");
    assert_eq!(rae_entry.amount_cents, 21_250, "2.5 hours at $85");
    assert_eq!(users::list_time_entries(&conn, &owner).unwrap().len(), 2);
    assert_eq!(users::list_time_entries(&conn, &helper).unwrap().len(), 1);
    assert_eq!(
        users::list_time_entries(&conn, &helper).unwrap()[0].id,
        rae_entry.id
    );

    // Rae cannot delete someone else's sheet even if she asks directly.
    let other: i64 = conn
        .query_row(
            "SELECT id FROM time_entries WHERE user_id = ?1",
            [owner.id],
            |row| row.get(0),
        )
        .unwrap();
    let refusal = users::delete_time_entry(&mut conn, &helper, other);
    assert!(refusal.is_err());
}
