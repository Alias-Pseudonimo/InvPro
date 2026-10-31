//! Company file schema. Each company lives in its own SQLite file, so the
//! schema is per-file and migrations are tracked with `PRAGMA user_version`.

pub const SCHEMA_VERSION: i32 = 8;

/// Everything a company file needs, including the invariants that must hold
/// even if a future UI (or a hand-written SQL session) bypasses this crate.
pub const MIGRATION_1: &str = r#"
CREATE TABLE app_session (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    actor       TEXT    NOT NULL,
    opened_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE company (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    file_id                 TEXT    NOT NULL UNIQUE,
    name                    TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    legal_name              TEXT,
    base_currency           TEXT    NOT NULL DEFAULT 'USD' CHECK (length(base_currency) = 3),
    fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
    created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    number      TEXT    NOT NULL UNIQUE CHECK (length(trim(number)) > 0),
    name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    type        TEXT    NOT NULL CHECK (type IN (
                    'ASSET', 'LIABILITY', 'EQUITY', 'INCOME',
                    'COGS', 'EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')),
    subtype     TEXT,
    parent_id   INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
    currency    TEXT    CHECK (currency IS NULL OR length(currency) = 3),
    description TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX idx_accounts_parent ON accounts(parent_id);
CREATE INDEX idx_accounts_type   ON accounts(type);

CREATE TABLE journal_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_no    INTEGER NOT NULL UNIQUE CHECK (entry_no > 0),
    entry_date  TEXT    NOT NULL CHECK (entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    memo        TEXT    NOT NULL DEFAULT '',
    reference   TEXT,
    source      TEXT    NOT NULL DEFAULT 'MANUAL' CHECK (source IN (
                    'MANUAL', 'INVOICE', 'BILL', 'PAYMENT', 'PAYROLL',
                    'INVENTORY', 'ADJUSTMENT', 'OPENING_BALANCE', 'IMPORT')),
    status      TEXT    NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'VOID')),
    posted_at   TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_by  TEXT    NOT NULL DEFAULT 'system'
);

CREATE INDEX idx_entries_date   ON journal_entries(entry_date);
CREATE INDEX idx_entries_status ON journal_entries(status);

CREATE TABLE journal_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id     INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    line_no      INTEGER NOT NULL CHECK (line_no > 0),
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    debit_cents  INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
    credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
    memo         TEXT    NOT NULL DEFAULT '',
    UNIQUE (entry_id, line_no),
    -- Exactly one side of the entry, and never a zero-value line.
    CHECK ((debit_cents > 0 AND credit_cents = 0)
        OR (credit_cents > 0 AND debit_cents = 0))
);

CREATE INDEX idx_lines_entry   ON journal_lines(entry_id);
CREATE INDEX idx_lines_account ON journal_lines(account_id);

CREATE TABLE audit_log (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actor       TEXT    NOT NULL,
    action      TEXT    NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    entity      TEXT    NOT NULL,
    entity_id   INTEGER,
    before_json TEXT,
    after_json  TEXT,
    prev_hash   TEXT,
    hash        TEXT
);

CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

-- The session actor is read by the audit triggers, so every audit row records
-- who was driving the connection at the time rather than a hard-coded name.
INSERT INTO app_session (id, actor) VALUES (1, 'system');

-- ---------------------------------------------------------------------------
-- Account tree rules
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_accounts_parent_type_ins
BEFORE INSERT ON accounts
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'a sub-account must have the same type as its parent')
    WHERE (SELECT type FROM accounts WHERE id = NEW.parent_id) IS NOT NEW.type;
END;

CREATE TRIGGER trg_accounts_parent_type_upd
BEFORE UPDATE OF parent_id, type ON accounts
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'a sub-account must have the same type as its parent')
    WHERE (SELECT type FROM accounts WHERE id = NEW.parent_id) IS NOT NEW.type;
END;

-- ---------------------------------------------------------------------------
-- Journal entry lifecycle: DRAFT -> POSTED -> (VOID)
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_entry_create_as_draft
BEFORE INSERT ON journal_entries
WHEN NEW.status <> 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'journal entries are created as drafts and then posted');
END;

CREATE TRIGGER trg_entry_post_guard
BEFORE UPDATE OF status ON journal_entries
WHEN NEW.status = 'POSTED' AND OLD.status = 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'cannot post: an entry needs at least two lines')
    WHERE (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) < 2;

    SELECT RAISE(ABORT, 'cannot post: total debits must equal total credits')
    WHERE (SELECT COALESCE(SUM(debit_cents), 0) FROM journal_lines WHERE entry_id = NEW.id)
       <> (SELECT COALESCE(SUM(credit_cents), 0) FROM journal_lines WHERE entry_id = NEW.id);

    SELECT RAISE(ABORT, 'cannot post: an entry must have a non-zero value')
    WHERE (SELECT COALESCE(SUM(debit_cents), 0) FROM journal_lines WHERE entry_id = NEW.id) = 0;
END;

CREATE TRIGGER trg_entry_posted_immutable
BEFORE UPDATE ON journal_entries
WHEN OLD.status = 'POSTED' AND NEW.status <> 'VOID'
BEGIN
    SELECT RAISE(ABORT, 'posted entries are immutable: void the entry and post a correcting entry');
END;

CREATE TRIGGER trg_entry_no_delete_posted
BEFORE DELETE ON journal_entries
WHEN OLD.status = 'POSTED'
BEGIN
    SELECT RAISE(ABORT, 'posted entries cannot be deleted: void the entry instead');
END;

CREATE TRIGGER trg_lines_draft_only_ins
BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.entry_id) IS NOT 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'lines can only be added to a draft entry');
END;

CREATE TRIGGER trg_lines_draft_only_upd
BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) IS NOT 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'lines of a posted entry cannot be changed');
END;

CREATE TRIGGER trg_lines_draft_only_del
BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) IS NOT 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'lines of a posted entry cannot be removed');
END;

CREATE TRIGGER trg_lines_account_rules_ins
BEFORE INSERT ON journal_lines
BEGIN
    SELECT RAISE(ABORT, 'cannot post to an inactive account')
    WHERE (SELECT is_active FROM accounts WHERE id = NEW.account_id) = 0;

    SELECT RAISE(ABORT, 'cannot post to a header account that has sub-accounts')
    WHERE (SELECT COUNT(*) FROM accounts WHERE parent_id = NEW.account_id) > 0;
END;

CREATE TRIGGER trg_lines_account_rules_upd
BEFORE UPDATE OF account_id ON journal_lines
BEGIN
    SELECT RAISE(ABORT, 'cannot post to an inactive account')
    WHERE (SELECT is_active FROM accounts WHERE id = NEW.account_id) = 0;

    SELECT RAISE(ABORT, 'cannot post to a header account that has sub-accounts')
    WHERE (SELECT COUNT(*) FROM accounts WHERE parent_id = NEW.account_id) > 0;
END;

-- ---------------------------------------------------------------------------
-- Audit trail. Triggers write the before/after image; the application seals the
-- rows into a hash chain inside the same transaction (see audit::seal_pending).
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_audit_accounts_ins AFTER INSERT ON accounts
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, after_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'INSERT', 'accounts', NEW.id,
            json_object('id', NEW.id, 'number', NEW.number, 'name', NEW.name,
                        'type', NEW.type, 'subtype', NEW.subtype,
                        'parent_id', NEW.parent_id, 'currency', NEW.currency,
                        'is_active', NEW.is_active));
END;

CREATE TRIGGER trg_audit_accounts_upd AFTER UPDATE ON accounts
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'UPDATE', 'accounts', NEW.id,
            json_object('id', OLD.id, 'number', OLD.number, 'name', OLD.name,
                        'type', OLD.type, 'subtype', OLD.subtype,
                        'parent_id', OLD.parent_id, 'currency', OLD.currency,
                        'is_active', OLD.is_active),
            json_object('id', NEW.id, 'number', NEW.number, 'name', NEW.name,
                        'type', NEW.type, 'subtype', NEW.subtype,
                        'parent_id', NEW.parent_id, 'currency', NEW.currency,
                        'is_active', NEW.is_active));
END;

CREATE TRIGGER trg_audit_accounts_del AFTER DELETE ON accounts
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, before_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'DELETE', 'accounts', OLD.id,
            json_object('id', OLD.id, 'number', OLD.number, 'name', OLD.name,
                        'type', OLD.type, 'subtype', OLD.subtype,
                        'parent_id', OLD.parent_id, 'currency', OLD.currency,
                        'is_active', OLD.is_active));
END;

CREATE TRIGGER trg_audit_entries_ins AFTER INSERT ON journal_entries
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, after_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'INSERT', 'journal_entries', NEW.id,
            json_object('id', NEW.id, 'entry_no', NEW.entry_no, 'entry_date', NEW.entry_date,
                        'memo', NEW.memo, 'reference', NEW.reference, 'source', NEW.source,
                        'status', NEW.status, 'created_by', NEW.created_by));
END;

CREATE TRIGGER trg_audit_entries_upd AFTER UPDATE ON journal_entries
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'UPDATE', 'journal_entries', NEW.id,
            json_object('id', OLD.id, 'entry_no', OLD.entry_no, 'entry_date', OLD.entry_date,
                        'memo', OLD.memo, 'reference', OLD.reference, 'source', OLD.source,
                        'status', OLD.status, 'posted_at', OLD.posted_at),
            json_object('id', NEW.id, 'entry_no', NEW.entry_no, 'entry_date', NEW.entry_date,
                        'memo', NEW.memo, 'reference', NEW.reference, 'source', NEW.source,
                        'status', NEW.status, 'posted_at', NEW.posted_at));
END;

CREATE TRIGGER trg_audit_entries_del AFTER DELETE ON journal_entries
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, before_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'DELETE', 'journal_entries', OLD.id,
            json_object('id', OLD.id, 'entry_no', OLD.entry_no, 'entry_date', OLD.entry_date,
                        'memo', OLD.memo, 'status', OLD.status));
END;

CREATE TRIGGER trg_audit_lines_ins AFTER INSERT ON journal_lines
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, after_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'INSERT', 'journal_lines', NEW.id,
            json_object('id', NEW.id, 'entry_id', NEW.entry_id, 'line_no', NEW.line_no,
                        'account_id', NEW.account_id, 'debit_cents', NEW.debit_cents,
                        'credit_cents', NEW.credit_cents, 'memo', NEW.memo));
END;

CREATE TRIGGER trg_audit_lines_upd AFTER UPDATE ON journal_lines
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'UPDATE', 'journal_lines', NEW.id,
            json_object('id', OLD.id, 'entry_id', OLD.entry_id, 'line_no', OLD.line_no,
                        'account_id', OLD.account_id, 'debit_cents', OLD.debit_cents,
                        'credit_cents', OLD.credit_cents),
            json_object('id', NEW.id, 'entry_id', NEW.entry_id, 'line_no', NEW.line_no,
                        'account_id', NEW.account_id, 'debit_cents', NEW.debit_cents,
                        'credit_cents', NEW.credit_cents));
END;

CREATE TRIGGER trg_audit_lines_del AFTER DELETE ON journal_lines
BEGIN
    INSERT INTO audit_log (actor, action, entity, entity_id, before_json)
    VALUES ((SELECT actor FROM app_session WHERE id = 1), 'DELETE', 'journal_lines', OLD.id,
            json_object('id', OLD.id, 'entry_id', OLD.entry_id, 'line_no', OLD.line_no,
                        'account_id', OLD.account_id, 'debit_cents', OLD.debit_cents,
                        'credit_cents', OLD.credit_cents));
END;
"#;

// ---------------------------------------------------------------------------
// Schema v2 — the plain-language record layer.
//
// These tables are what a business owner actually touches: customers, vendors,
// income, expenses, invoices, purchases, stock and pay runs. They do not hold
// balances and they never bypass the journal: every write posts a balanced
// entry through `journal::post`. Keeping the friendly record and the accounting
// fact side by side is what lets the app stay simple without losing the books.
// ---------------------------------------------------------------------------

pub fn migration_2() -> String {
    let mut sql = String::from(MIGRATION_2_DDL);
    for (table, columns) in AUDITED_TABLES {
        sql.push_str(&audit_triggers(table, columns));
    }
    sql
}

/// Every record table is audited. The column list is the before/after image
/// written into `audit_log`, so the trail shows what changed, not just that
/// something changed.
const AUDITED_TABLES: &[(&str, &[&str])] = &[
    ("customers", &["id", "name", "email", "phone", "address", "notes", "is_active"]),
    ("vendors", &["id", "name", "email", "phone", "address", "notes", "is_active"]),
    (
        "inventory_items",
        &["id", "name", "sku", "barcode", "category", "kind", "qty_hundredths", "unit_cost_cents", "sale_price_cents", "is_active"],
    ),
    (
        "income_records",
        &["id", "entry_date", "customer_id", "category", "account_id", "description", "amount_cents", "tax_bp", "is_paid", "invoice_no", "journal_entry_id"],
    ),
    (
        "expense_records",
        &["id", "entry_date", "vendor_id", "category", "account_id", "description", "amount_cents", "tax_bp", "is_paid", "journal_entry_id"],
    ),
    (
        "invoices",
        &["id", "invoice_no", "customer_id", "invoice_date", "due_date", "status", "tax_bp", "stock_deducted", "ar_entry_id", "cash_entry_id", "cogs_entry_id"],
    ),
    ("invoice_lines", &["id", "invoice_id", "position", "description", "qty_hundredths", "unit_price_cents", "inventory_item_id"]),
    (
        "purchases",
        &["id", "purchase_date", "vendor_id", "category", "account_id", "note", "is_paid", "journal_entry_id"],
    ),
    (
        "purchase_lines",
        &["id", "purchase_id", "position", "description", "qty_hundredths", "unit_cost_cents", "sale_price_cents", "inventory_item_id"],
    ),
    (
        "payroll_runs",
        &["id", "employee", "pay_date", "check_number", "pay_rate_cents", "regular_hours_hundredths", "overtime_hours_hundredths", "gross_cents", "federal_cents", "state_cents", "social_security_cents", "medicare_cents", "other_deductions_cents", "net_cents", "journal_entry_id"],
    ),
];

/// Schema v3 — an income record and its invoice become one story, and a
/// recurring invoice becomes a schedule that can produce real documents.
pub fn migration_3() -> String {
    let mut sql = String::from(MIGRATION_3_DDL);
    for (table, columns) in RECURRING_AUDITED {
        sql.push_str(&audit_triggers(table, columns));
    }
    sql
}

const RECURRING_AUDITED: &[(&str, &[&str])] = &[
    (
        "recurring_invoices",
        &["id", "customer_id", "description", "frequency", "start_date", "next_date", "end_date", "tax_bp", "is_active"],
    ),
    (
        "recurring_invoice_lines",
        &["id", "recurring_id", "position", "description", "qty_hundredths", "unit_price_cents", "inventory_item_id"],
    ),
];

/// Schema v5 — the documents that come before an invoice. An estimate is a
/// quote, a sales order is a confirmed commitment, and neither posts anything:
/// they only become money when they are turned into an invoice. The same
/// migration carries the payroll facts that change withholding (marital status
/// and withholding allowances).
/// Schema v6 — employees as their own record, and pay runs that can pay more
/// than wages.
///
/// An employee is not a user: payroll needs a W-4 and W-2 for people who never
/// open this file. The two records are linked only when it helps (mileage is
/// logged by a user), and the link is optional. Pay runs gained the additions
/// that ride on top of net pay — mileage reimbursement and a per-period
/// allowance — plus the W-4 extra withholding that is added after the rates.
pub fn migration_6() -> String {
    let mut sql = String::from(MIGRATION_6_DDL);
    for (table, columns) in EMPLOYEE_AUDITED {
        sql.push_str(&audit_triggers(table, columns));
    }
    // payroll_runs gained additions and the employee link, so its audit image
    // is rebuilt to include them.
    for trigger in ["ins", "upd", "del"] {
        sql.push_str(&format!(
            "DROP TRIGGER IF EXISTS trg_audit_payroll_runs_{trigger};\n"
        ));
    }
    sql.push_str(&audit_triggers("payroll_runs", PAYROLL_AUDITED_V6));
    // Mileage now records the pay run that reimbursed it.
    for trigger in ["ins", "upd", "del"] {
        sql.push_str(&format!(
            "DROP TRIGGER IF EXISTS trg_audit_time_entries_{trigger};\n"
        ));
    }
    sql.push_str(&audit_triggers("time_entries", TIME_AUDITED_V6));
    sql
}

/// v8 widens the access level a user can hold. A `CHECK` cannot be altered in
/// SQLite, so the table is rebuilt with its rows intact.
pub fn migration_8() -> String {
    MIGRATION_8_DDL.to_string()
}

pub fn migration_7() -> String {
    let mut sql = String::from(MIGRATION_7_DDL);
    // Both tables gained columns the audit image has to name, so their triggers
    // are rebuilt rather than left pointing at the old column list.
    for table in ["employees", "payroll_runs"] {
        for trigger in ["ins", "upd", "del"] {
            sql.push_str(&format!(
                "DROP TRIGGER IF EXISTS trg_audit_{table}_{trigger};\n"
            ));
        }
    }
    sql.push_str(&audit_triggers("employees", EMPLOYEE_AUDITED_V7));
    sql.push_str(&audit_triggers("payroll_runs", PAYROLL_AUDITED_V7));
    sql
}

const EMPLOYEE_AUDITED_V7: &[&str] = &[
    "id",
    "name",
    "employee_no",
    "email",
    "phone",
    "address",
    "ssn",
    "ssn_last4",
    "hire_date",
    "job_title",
    "user_id",
    "filing_status",
    "allowances",
    "extra_withholding_cents",
    "pay_type",
    "pay_frequency",
    "pay_rate_cents",
    "salary_cents",
    "allowance_cents",
    "mileage_reimbursement",
    "is_active",
];

const PAYROLL_AUDITED_V7: &[&str] = &[
    "id",
    "employee",
    "employee_id",
    "pay_date",
    "check_number",
    "pay_type",
    "pay_frequency",
    "pay_rate_cents",
    "salary_cents",
    "regular_hours_hundredths",
    "overtime_hours_hundredths",
    "gross_cents",
    "marital_status",
    "allowances",
    "extra_withholding_cents",
    "federal_cents",
    "state_cents",
    "social_security_cents",
    "medicare_cents",
    "other_deductions_cents",
    "mileage_hundredths",
    "mileage_cents",
    "allowance_cents",
    "additions_cents",
    "net_cents",
    "journal_entry_id",
];

const EMPLOYEE_AUDITED: &[(&str, &[&str])] = &[(
    "employees",
    &[
        "id",
        "name",
        "employee_no",
        "email",
        "phone",
        "address",
        "ssn_last4",
        "hire_date",
        "job_title",
        "user_id",
        "filing_status",
        "allowances",
        "extra_withholding_cents",
        "pay_rate_cents",
        "allowance_cents",
        "mileage_reimbursement",
        "is_active",
    ],
)];

const TIME_AUDITED_V6: &[&str] = &[
    "id",
    "user_id",
    "entered_by",
    "entry_date",
    "kind",
    "description",
    "customer",
    "quantity_hundredths",
    "rate_cents",
    "is_billable",
    "reimbursed_run_id",
];

const PAYROLL_AUDITED_V6: &[&str] = &[
    "id",
    "employee",
    "employee_id",
    "pay_date",
    "check_number",
    "pay_rate_cents",
    "regular_hours_hundredths",
    "overtime_hours_hundredths",
    "gross_cents",
    "marital_status",
    "allowances",
    "extra_withholding_cents",
    "federal_cents",
    "state_cents",
    "social_security_cents",
    "medicare_cents",
    "other_deductions_cents",
    "mileage_hundredths",
    "mileage_cents",
    "allowance_cents",
    "additions_cents",
    "net_cents",
    "journal_entry_id",
];

pub fn migration_5() -> String {
    let mut sql = String::from(MIGRATION_5_DDL);
    for (table, columns) in PIPELINE_AUDITED {
        sql.push_str(&audit_triggers(table, columns));
    }
    // pay runs gained two audited columns, so their triggers are rebuilt to
    // capture them in the before/after image.
    for trigger in ["ins", "upd", "del"] {
        sql.push_str(&format!(
            "DROP TRIGGER IF EXISTS trg_audit_payroll_runs_{trigger};\n"
        ));
    }
    sql.push_str(&audit_triggers("payroll_runs", PAYROLL_AUDITED_V5));
    sql
}

const PIPELINE_AUDITED: &[(&str, &[&str])] = &[
    (
        "estimates",
        &[
            "id",
            "estimate_no",
            "customer_id",
            "estimate_date",
            "expiry_date",
            "status",
            "tax_bp",
            "notes",
            "converted_order_id",
            "converted_invoice_id",
            "converted_at",
        ],
    ),
    (
        "estimate_lines",
        &[
            "id",
            "estimate_id",
            "position",
            "description",
            "qty_hundredths",
            "unit_price_cents",
            "inventory_item_id",
        ],
    ),
    (
        "sales_orders",
        &[
            "id",
            "order_no",
            "customer_id",
            "order_date",
            "requested_date",
            "status",
            "tax_bp",
            "notes",
            "invoice_id",
            "converted_at",
        ],
    ),
    (
        "sales_order_lines",
        &[
            "id",
            "order_id",
            "position",
            "description",
            "qty_hundredths",
            "unit_price_cents",
            "inventory_item_id",
        ],
    ),
];

const PAYROLL_AUDITED_V5: &[&str] = &[
    "id",
    "employee",
    "pay_date",
    "check_number",
    "pay_rate_cents",
    "regular_hours_hundredths",
    "overtime_hours_hundredths",
    "gross_cents",
    "marital_status",
    "allowances",
    "federal_cents",
    "state_cents",
    "social_security_cents",
    "medicare_cents",
    "other_deductions_cents",
    "net_cents",
    "journal_entry_id",
];

/// Schema v4 — credit memos against issued invoices, the people who use the
/// file and the access level each of them has, and billable time and mileage.
pub fn migration_4() -> String {
    let mut sql = String::from(MIGRATION_4_DDL);
    for (table, columns) in CREDIT_AUDITED {
        sql.push_str(&audit_triggers(table, columns));
    }
    sql
}

const CREDIT_AUDITED: &[(&str, &[&str])] = &[
    (
        "credit_memos",
        &[
            "id",
            "memo_no",
            "invoice_id",
            "customer_id",
            "memo_date",
            "reason",
            "status",
            "outcome",
            "tax_bp",
            "subtotal_cents",
            "tax_cents",
            "total_cents",
            "stock_returned",
            "issue_entry_id",
            "settlement_entry_id",
            "cogs_entry_id",
            "posted_at",
            "voided_at",
        ],
    ),
    (
        "credit_memo_lines",
        &[
            "id",
            "memo_id",
            "invoice_line_id",
            "position",
            "description",
            "qty_hundredths",
            "unit_price_cents",
            "inventory_item_id",
        ],
    ),
    (
        "users",
        &["id", "name", "email", "access", "is_active"],
    ),
    (
        "time_entries",
        &[
            "id",
            "user_id",
            "entered_by",
            "entry_date",
            "kind",
            "description",
            "customer",
            "quantity_hundredths",
            "rate_cents",
            "is_billable",
        ],
    ),
];

fn audit_triggers(table: &str, columns: &[&str]) -> String {
    let after = json_image(columns, "NEW");
    let before = json_image(columns, "OLD");
    format!(
        "CREATE TRIGGER trg_audit_{table}_ins AFTER INSERT ON {table}\n\
         BEGIN\n\
         \x20   INSERT INTO audit_log (actor, action, entity, entity_id, after_json)\n\
         \x20   VALUES ((SELECT actor FROM app_session WHERE id = 1), 'INSERT', '{table}', NEW.id, {after});\n\
         END;\n\
         CREATE TRIGGER trg_audit_{table}_upd AFTER UPDATE ON {table}\n\
         BEGIN\n\
         \x20   INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)\n\
         \x20   VALUES ((SELECT actor FROM app_session WHERE id = 1), 'UPDATE', '{table}', NEW.id, {before}, {after});\n\
         END;\n\
         CREATE TRIGGER trg_audit_{table}_del AFTER DELETE ON {table}\n\
         BEGIN\n\
         \x20   INSERT INTO audit_log (actor, action, entity, entity_id, before_json)\n\
         \x20   VALUES ((SELECT actor FROM app_session WHERE id = 1), 'DELETE', '{table}', OLD.id, {before});\n\
         END;\n\n"
    )
}

fn json_image(columns: &[&str], alias: &str) -> String {
    let pairs: Vec<String> = columns
        .iter()
        .map(|column| format!("'{column}', {alias}.{column}"))
        .collect();
    format!("json_object({})", pairs.join(", "))
}

const MIGRATION_2_DDL: &str = r#"
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    email      TEXT    NOT NULL DEFAULT '',
    phone      TEXT    NOT NULL DEFAULT '',
    address    TEXT    NOT NULL DEFAULT '',
    notes      TEXT    NOT NULL DEFAULT '',
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE vendors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    email      TEXT    NOT NULL DEFAULT '',
    phone      TEXT    NOT NULL DEFAULT '',
    address    TEXT    NOT NULL DEFAULT '',
    notes      TEXT    NOT NULL DEFAULT '',
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE inventory_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    sku              TEXT    NOT NULL DEFAULT '',
    barcode          TEXT    NOT NULL DEFAULT '',
    category         TEXT    NOT NULL DEFAULT '',
    kind             TEXT    NOT NULL DEFAULT 'Product'
                             CHECK (kind IN ('Product', 'Consumable', 'Service')),
    qty_hundredths   INTEGER NOT NULL DEFAULT 0 CHECK (qty_hundredths >= 0),
    unit_cost_cents  INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
    sale_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (sale_price_cents >= 0),
    is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_inventory_name ON inventory_items(lower(name));

CREATE TABLE income_records (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date       TEXT    NOT NULL CHECK (entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    category         TEXT    NOT NULL DEFAULT 'Uncategorized',
    account_id       INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
    description      TEXT    NOT NULL DEFAULT '',
    amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
    tax_bp           INTEGER NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
    is_paid          INTEGER NOT NULL DEFAULT 0 CHECK (is_paid IN (0, 1)),
    invoice_no       TEXT    NOT NULL DEFAULT '',
    journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_income_date     ON income_records(entry_date);
CREATE INDEX idx_income_customer ON income_records(customer_id);

CREATE TABLE expense_records (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date       TEXT    NOT NULL CHECK (entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    vendor_id        INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
    category         TEXT    NOT NULL DEFAULT 'Uncategorized',
    account_id       INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
    description      TEXT    NOT NULL DEFAULT '',
    amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
    tax_bp           INTEGER NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
    is_paid          INTEGER NOT NULL DEFAULT 0 CHECK (is_paid IN (0, 1)),
    journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_expense_date   ON expense_records(entry_date);
CREATE INDEX idx_expense_vendor ON expense_records(vendor_id);

CREATE TABLE invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no     TEXT    NOT NULL UNIQUE CHECK (length(trim(invoice_no)) > 0),
    customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    invoice_date   TEXT    NOT NULL CHECK (invoice_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    due_date       TEXT    CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    status         TEXT    NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Sent', 'Paid')),
    tax_bp         INTEGER NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
    stock_deducted INTEGER NOT NULL DEFAULT 0 CHECK (stock_deducted IN (0, 1)),
    ar_entry_id    INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    cash_entry_id  INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    cogs_entry_id  INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status   ON invoices(status);

CREATE TABLE invoice_lines (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id        INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    position          INTEGER NOT NULL CHECK (position > 0),
    description       TEXT    NOT NULL DEFAULT '',
    qty_hundredths    INTEGER NOT NULL DEFAULT 100 CHECK (qty_hundredths > 0),
    unit_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
    inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
    UNIQUE (invoice_id, position)
);

CREATE TABLE purchases (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_date    TEXT    NOT NULL CHECK (purchase_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    vendor_id        INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
    category         TEXT    NOT NULL DEFAULT 'Uncategorized',
    account_id       INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
    note             TEXT    NOT NULL DEFAULT '',
    is_paid          INTEGER NOT NULL DEFAULT 0 CHECK (is_paid IN (0, 1)),
    journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE purchase_lines (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id       INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    position          INTEGER NOT NULL CHECK (position > 0),
    description       TEXT    NOT NULL DEFAULT '',
    qty_hundredths    INTEGER NOT NULL DEFAULT 100 CHECK (qty_hundredths > 0),
    unit_cost_cents   INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
    sale_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK (sale_price_cents >= 0),
    inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
    UNIQUE (purchase_id, position)
);

CREATE TABLE payroll_runs (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    employee                  TEXT    NOT NULL CHECK (length(trim(employee)) > 0),
    pay_date                  TEXT    NOT NULL CHECK (pay_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    check_number              TEXT    NOT NULL DEFAULT '',
    pay_rate_cents            INTEGER NOT NULL DEFAULT 0 CHECK (pay_rate_cents >= 0),
    regular_hours_hundredths  INTEGER NOT NULL DEFAULT 0 CHECK (regular_hours_hundredths >= 0),
    overtime_hours_hundredths INTEGER NOT NULL DEFAULT 0 CHECK (overtime_hours_hundredths >= 0),
    gross_cents               INTEGER NOT NULL DEFAULT 0 CHECK (gross_cents >= 0),
    federal_cents             INTEGER NOT NULL DEFAULT 0 CHECK (federal_cents >= 0),
    state_cents               INTEGER NOT NULL DEFAULT 0 CHECK (state_cents >= 0),
    social_security_cents     INTEGER NOT NULL DEFAULT 0 CHECK (social_security_cents >= 0),
    medicare_cents            INTEGER NOT NULL DEFAULT 0 CHECK (medicare_cents >= 0),
    other_deductions_cents    INTEGER NOT NULL DEFAULT 0 CHECK (other_deductions_cents >= 0),
    net_cents                 INTEGER NOT NULL DEFAULT 0 CHECK (net_cents >= 0),
    journal_entry_id          INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Editable defaults. Account roles are stored as ids so the owner can point
-- "cash", "receivables" and friends at any account without touching code.
INSERT INTO settings (key, value) VALUES ('currency', 'USD');
INSERT INTO settings (key, value) VALUES ('invoice_income_account', 'Sales Revenue');
INSERT INTO settings (key, value) VALUES ('invoice_tax_bp', '0');
"#;



const MIGRATION_3_DDL: &str = r#"
-- An income record either owns the invoice it created or settles one that was
-- already there. Either way the money is booked once, on the invoice.
ALTER TABLE income_records ADD COLUMN invoice_id   INTEGER REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE income_records ADD COLUMN invoice_auto INTEGER NOT NULL DEFAULT 0 CHECK (invoice_auto IN (0, 1));

CREATE INDEX idx_income_invoice ON income_records(invoice_id);

CREATE TABLE recurring_invoices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    description TEXT    NOT NULL DEFAULT '',
    frequency   TEXT    NOT NULL DEFAULT 'Monthly'
                        CHECK (frequency IN ('Weekly', 'Monthly', 'Quarterly', 'Yearly')),
    start_date  TEXT    NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    next_date   TEXT    NOT NULL CHECK (next_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    end_date    TEXT    CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    tax_bp      INTEGER NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_recurring_next ON recurring_invoices(next_date);

CREATE TABLE recurring_invoice_lines (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    recurring_id      INTEGER NOT NULL REFERENCES recurring_invoices(id) ON DELETE CASCADE,
    position          INTEGER NOT NULL CHECK (position > 0),
    description       TEXT    NOT NULL DEFAULT '',
    qty_hundredths    INTEGER NOT NULL DEFAULT 100 CHECK (qty_hundredths > 0),
    unit_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
    inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
    UNIQUE (recurring_id, position)
);
"#;

const MIGRATION_4_DDL: &str = r#"
-- A credit memo is always built on an invoice that has already been issued, so
-- the credit can never exist without the charge it reduces.
CREATE TABLE credit_memos (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    memo_no             TEXT    NOT NULL UNIQUE CHECK (length(trim(memo_no)) > 0),
    invoice_id          INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    customer_id         INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    memo_date           TEXT    NOT NULL CHECK (memo_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    reason              TEXT    NOT NULL DEFAULT '',
    status              TEXT    NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Posted', 'Void')),
    outcome             TEXT    NOT NULL DEFAULT 'Apply' CHECK (outcome IN ('Apply', 'Refund', 'Credit')),
    tax_bp              INTEGER NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
    subtotal_cents      INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
    tax_cents           INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
    total_cents         INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
    stock_returned      INTEGER NOT NULL DEFAULT 0 CHECK (stock_returned IN (0, 1)),
    issue_entry_id      INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    settlement_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    cogs_entry_id       INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
    posted_at           TEXT,
    voided_at           TEXT,
    created_by          TEXT    NOT NULL DEFAULT '',
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_credit_memos_invoice ON credit_memos(invoice_id);
CREATE INDEX idx_credit_memos_status  ON credit_memos(status);

CREATE TABLE credit_memo_lines (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    memo_id           INTEGER NOT NULL REFERENCES credit_memos(id) ON DELETE CASCADE,
    invoice_line_id   INTEGER REFERENCES invoice_lines(id) ON DELETE SET NULL,
    position          INTEGER NOT NULL CHECK (position > 0),
    description       TEXT    NOT NULL DEFAULT '',
    qty_hundredths    INTEGER NOT NULL DEFAULT 0 CHECK (qty_hundredths >= 0),
    unit_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
    inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
    UNIQUE (memo_id, position)
);

-- People who use this company file, and the level of access each one has.
CREATE TABLE users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    email      TEXT    NOT NULL DEFAULT '',
    access     TEXT    NOT NULL DEFAULT 'Standard'
                       CHECK (access IN ('Admin', 'Standard', 'TimeEntry', 'ReadOnly')),
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_users_name ON users(lower(name));

-- Billable hours and miles. These are not posted to the journal until they are
-- billed, which is why they carry the person who entered them.
CREATE TABLE time_entries (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    entered_by          TEXT    NOT NULL DEFAULT '',
    entry_date          TEXT    NOT NULL CHECK (entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    kind                TEXT    NOT NULL DEFAULT 'Time' CHECK (kind IN ('Time', 'Mileage')),
    description         TEXT    NOT NULL DEFAULT '',
    customer            TEXT    NOT NULL DEFAULT '',
    quantity_hundredths INTEGER NOT NULL CHECK (quantity_hundredths > 0),
    rate_cents          INTEGER NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
    is_billable         INTEGER NOT NULL DEFAULT 1 CHECK (is_billable IN (0, 1)),
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_time_entries_user ON time_entries(user_id);
CREATE INDEX idx_time_entries_date ON time_entries(entry_date);

-- The first user is the owner, with full access. Switching users changes the
-- name the audit triggers write, so the trail names a person, not the machine.
INSERT INTO users (name, access) VALUES ('Owner', 'Admin');
INSERT INTO settings (key, value)
VALUES ('current_user_id', (SELECT CAST(id AS TEXT) FROM users WHERE name = 'Owner'));

-- A credit memo's money is frozen the moment it is posted. Corrections are a
-- void plus a new memo, never an edit, so the paper trail matches the books.
CREATE TRIGGER trg_credit_memo_posted_immutable
BEFORE UPDATE ON credit_memos
WHEN OLD.status = 'Posted'
 AND NEW.status = 'Posted'
 AND (NEW.invoice_id     IS NOT OLD.invoice_id
   OR NEW.customer_id    IS NOT OLD.customer_id
   OR NEW.memo_date      IS NOT OLD.memo_date
   OR NEW.reason         IS NOT OLD.reason
   OR NEW.outcome        IS NOT OLD.outcome
   OR NEW.tax_bp         IS NOT OLD.tax_bp
   OR NEW.subtotal_cents IS NOT OLD.subtotal_cents
   OR NEW.tax_cents      IS NOT OLD.tax_cents
   OR NEW.total_cents    IS NOT OLD.total_cents)
BEGIN
    SELECT RAISE(ABORT, 'a posted credit memo cannot be edited; void it and issue a new one');
END;

CREATE TRIGGER trg_credit_memo_lines_ins
BEFORE INSERT ON credit_memo_lines
WHEN (SELECT status FROM credit_memos WHERE id = NEW.memo_id) <> 'Draft'
BEGIN
    SELECT RAISE(ABORT, 'credit memo lines can only change while the memo is a draft');
END;

CREATE TRIGGER trg_credit_memo_lines_upd
BEFORE UPDATE ON credit_memo_lines
WHEN (SELECT status FROM credit_memos WHERE id = NEW.memo_id) <> 'Draft'
BEGIN
    SELECT RAISE(ABORT, 'credit memo lines can only change while the memo is a draft');
END;

CREATE TRIGGER trg_credit_memo_lines_del
BEFORE DELETE ON credit_memo_lines
WHEN (SELECT status FROM credit_memos WHERE id = OLD.memo_id) <> 'Draft'
BEGIN
    SELECT RAISE(ABORT, 'credit memo lines can only change while the memo is a draft');
END;

-- A posted memo stays on the books; voiding is the only way out.
CREATE TRIGGER trg_credit_memo_no_delete_posted
BEFORE DELETE ON credit_memos
WHEN OLD.status <> 'Draft'
BEGIN
    SELECT RAISE(ABORT, 'a posted or voided credit memo cannot be deleted; void it instead');
END;

-- There must always be someone who can administer the file.
CREATE TRIGGER trg_users_keep_an_admin_upd
BEFORE UPDATE OF access, is_active ON users
WHEN OLD.access = 'Admin'
 AND OLD.is_active = 1
 AND (NEW.access <> 'Admin' OR NEW.is_active <> 1)
 AND (SELECT COUNT(*) FROM users
       WHERE access = 'Admin' AND is_active = 1 AND id <> OLD.id) = 0
BEGIN
    SELECT RAISE(ABORT, 'this is the last admin; promote someone else before changing this user');
END;

CREATE TRIGGER trg_users_keep_an_admin_del
BEFORE DELETE ON users
WHEN OLD.access = 'Admin'
 AND OLD.is_active = 1
 AND (SELECT COUNT(*) FROM users
       WHERE access = 'Admin' AND is_active = 1 AND id <> OLD.id) = 0
BEGIN
    SELECT RAISE(ABORT, 'this is the last admin; promote someone else before deleting this user');
END;
"#;

const MIGRATION_5_DDL: &str = r#"
-- ---------------------------------------------------------------------------
-- Quotes and orders: the paperwork that comes before an invoice.
--
-- Neither table has a journal entry, because neither has moved money yet. They
-- exist so a quote can be sent, accepted, and then billed without retyping it.
-- The moment a document is turned into the next one, its lines freeze; a wrong
-- quote is replaced by a new quote, never edited under a document that already
-- relies on it.
-- ---------------------------------------------------------------------------

CREATE TABLE sales_orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no       TEXT    NOT NULL UNIQUE CHECK (length(trim(order_no)) > 0),
    customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    order_date     TEXT    NOT NULL CHECK (order_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    requested_date TEXT    CHECK (requested_date IS NULL OR requested_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    status         TEXT    NOT NULL DEFAULT 'Draft'
                           CHECK (status IN ('Draft', 'Confirmed', 'Fulfilled', 'Cancelled')),
    tax_bp         INTEGER NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
    notes          TEXT    NOT NULL DEFAULT '',
    invoice_id     INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    converted_at   TEXT,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_sales_orders_customer ON sales_orders(customer_id);
CREATE INDEX idx_sales_orders_status   ON sales_orders(status);

CREATE TABLE sales_order_lines (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id          INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    position          INTEGER NOT NULL CHECK (position > 0),
    description       TEXT    NOT NULL DEFAULT '',
    qty_hundredths    INTEGER NOT NULL DEFAULT 100 CHECK (qty_hundredths > 0),
    unit_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
    inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
    UNIQUE (order_id, position)
);

CREATE TABLE estimates (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    estimate_no         TEXT    NOT NULL UNIQUE CHECK (length(trim(estimate_no)) > 0),
    customer_id         INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    estimate_date       TEXT    NOT NULL CHECK (estimate_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    expiry_date         TEXT    CHECK (expiry_date IS NULL OR expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    status              TEXT    NOT NULL DEFAULT 'Draft'
                                CHECK (status IN ('Draft', 'Sent', 'Accepted', 'Declined', 'Expired')),
    tax_bp              INTEGER NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
    notes               TEXT    NOT NULL DEFAULT '',
    converted_order_id   INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
    converted_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    converted_at        TEXT,
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_estimates_customer ON estimates(customer_id);
CREATE INDEX idx_estimates_status   ON estimates(status);

CREATE TABLE estimate_lines (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    estimate_id       INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    position          INTEGER NOT NULL CHECK (position > 0),
    description       TEXT    NOT NULL DEFAULT '',
    qty_hundredths    INTEGER NOT NULL DEFAULT 100 CHECK (qty_hundredths > 0),
    unit_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
    inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
    UNIQUE (estimate_id, position)
);

-- A converted estimate is history. Its lines cannot move again, because a
-- sales order or an invoice was built from exactly what they said.
CREATE TRIGGER trg_estimate_lines_ins
BEFORE INSERT ON estimate_lines
WHEN (SELECT converted_at FROM estimates WHERE id = NEW.estimate_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'a converted estimate cannot be changed; start a new estimate');
END;

CREATE TRIGGER trg_estimate_lines_upd
BEFORE UPDATE ON estimate_lines
WHEN (SELECT converted_at FROM estimates WHERE id = NEW.estimate_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'a converted estimate cannot be changed; start a new estimate');
END;

CREATE TRIGGER trg_estimate_lines_del
BEFORE DELETE ON estimate_lines
WHEN (SELECT converted_at FROM estimates WHERE id = OLD.estimate_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'a converted estimate cannot be changed; start a new estimate');
END;

CREATE TRIGGER trg_sales_order_lines_ins
BEFORE INSERT ON sales_order_lines
WHEN (SELECT invoice_id FROM sales_orders WHERE id = NEW.order_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'an invoiced sales order cannot be changed; start a new order');
END;

CREATE TRIGGER trg_sales_order_lines_upd
BEFORE UPDATE ON sales_order_lines
WHEN (SELECT invoice_id FROM sales_orders WHERE id = NEW.order_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'an invoiced sales order cannot be changed; start a new order');
END;

CREATE TRIGGER trg_sales_order_lines_del
BEFORE DELETE ON sales_order_lines
WHEN (SELECT invoice_id FROM sales_orders WHERE id = OLD.order_id) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'an invoiced sales order cannot be changed; start a new order');
END;

CREATE TRIGGER trg_estimates_no_delete_converted
BEFORE DELETE ON estimates
WHEN OLD.converted_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'this estimate has already become an order or an invoice, so it stays on file');
END;

CREATE TRIGGER trg_sales_orders_no_delete_invoiced
BEFORE DELETE ON sales_orders
WHEN OLD.invoice_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'this order has already been invoiced, so it stays on file');
END;

-- An invoice number is how a customer refers to a bill, so quotes and orders
-- get their own series rather than borrowing it.
INSERT INTO settings (key, value) VALUES ('estimate_series', 'EST');
INSERT INTO settings (key, value) VALUES ('sales_order_series', 'SO');

-- Payroll facts that change withholding. Single and married are taxed at
-- different rates, and each withholding allowance takes a slice of pay out of
-- the federal calculation before the rate is applied.
ALTER TABLE payroll_runs ADD COLUMN marital_status TEXT NOT NULL DEFAULT 'Single'
    CHECK (marital_status IN ('Single', 'Married'));
ALTER TABLE payroll_runs ADD COLUMN allowances INTEGER NOT NULL DEFAULT 0
    CHECK (allowances >= 0);

INSERT INTO settings (key, value) VALUES ('payroll_federal_single_bp', '1200');
INSERT INTO settings (key, value) VALUES ('payroll_federal_married_bp', '800');
INSERT INTO settings (key, value) VALUES ('payroll_state_bp', '400');
INSERT INTO settings (key, value) VALUES ('payroll_allowance_cents', '19400');
"#;

// ---------------------------------------------------------------------------
// Schema v6 — employees and additions
// ---------------------------------------------------------------------------

const MIGRATION_6_DDL: &str = r#"
-- ---------------------------------------------------------------------------
-- Employees are people you pay. They are not users: most crews never open the
-- company file. W-2 details say who they are, W-4 details say how to withhold,
-- and a user link is optional — only needed when someone also logs time.
-- ---------------------------------------------------------------------------
CREATE TABLE employees (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    name                      TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    employee_no               TEXT    NOT NULL DEFAULT '',
    email                     TEXT    NOT NULL DEFAULT '',
    phone                     TEXT    NOT NULL DEFAULT '',
    address                   TEXT    NOT NULL DEFAULT '',
    -- Only the last four digits are kept, so the file never holds a full SSN.
    ssn_last4                 TEXT    NOT NULL DEFAULT ''
                                      CHECK (ssn_last4 = '' OR ssn_last4 GLOB '[0-9][0-9][0-9][0-9]'),
    hire_date                 TEXT    CHECK (hire_date IS NULL
                                             OR hire_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    job_title                 TEXT    NOT NULL DEFAULT '',
    user_id                   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    filing_status             TEXT    NOT NULL DEFAULT 'Single'
                                      CHECK (filing_status IN ('Single', 'Married')),
    allowances                INTEGER NOT NULL DEFAULT 0 CHECK (allowances >= 0),
    extra_withholding_cents   INTEGER NOT NULL DEFAULT 0 CHECK (extra_withholding_cents >= 0),
    pay_rate_cents            INTEGER NOT NULL DEFAULT 0 CHECK (pay_rate_cents >= 0),
    allowance_cents           INTEGER NOT NULL DEFAULT 0 CHECK (allowance_cents >= 0),
    mileage_reimbursement     INTEGER NOT NULL DEFAULT 0 CHECK (mileage_reimbursement IN (0, 1)),
    is_active                 INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_employees_name ON employees(lower(name));
CREATE INDEX idx_employees_user ON employees(user_id);

-- Additions ride on top of net pay. They are not wages: no income tax and no
-- Social Security or Medicare is taken from a reimbursement, which is why they
-- live in their own columns instead of being folded into gross.
ALTER TABLE payroll_runs ADD COLUMN employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE payroll_runs ADD COLUMN extra_withholding_cents INTEGER NOT NULL DEFAULT 0
    CHECK (extra_withholding_cents >= 0);
ALTER TABLE payroll_runs ADD COLUMN mileage_hundredths INTEGER NOT NULL DEFAULT 0
    CHECK (mileage_hundredths >= 0);
ALTER TABLE payroll_runs ADD COLUMN mileage_cents INTEGER NOT NULL DEFAULT 0
    CHECK (mileage_cents >= 0);
ALTER TABLE payroll_runs ADD COLUMN allowance_cents INTEGER NOT NULL DEFAULT 0
    CHECK (allowance_cents >= 0);
ALTER TABLE payroll_runs ADD COLUMN additions_cents INTEGER NOT NULL DEFAULT 0
    CHECK (additions_cents >= 0);

-- A mile is paid once. The pay run that reimbursed it is recorded here, so the
-- next run only offers the miles still outstanding.
ALTER TABLE time_entries ADD COLUMN reimbursed_run_id INTEGER
    REFERENCES payroll_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_time_entries_reimbursed ON time_entries(reimbursed_run_id);

-- The rates that change over time are settings, not constants in the engine.
INSERT INTO settings (key, value) VALUES ('payroll_social_security_bp', '620');
INSERT INTO settings (key, value) VALUES ('payroll_medicare_bp', '145');
INSERT INTO settings (key, value) VALUES ('payroll_mileage_rate_cents', '67');

-- An employee with pay runs on file is history. The pay runs keep the name
-- they were paid under, so the record is retired rather than deleted.
CREATE TRIGGER trg_employees_no_delete_with_payroll
BEFORE DELETE ON employees
WHEN EXISTS (SELECT 1 FROM payroll_runs WHERE employee_id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'this employee has pay runs on file; mark them inactive instead of deleting them');
END;
"#;

// ---------------------------------------------------------------------------
// Schema v7 — pay basis, and the whole Social Security number
// ---------------------------------------------------------------------------

const MIGRATION_7_DDL: &str = r#"
-- ---------------------------------------------------------------------------
-- Not everybody is paid by the hour. A salary is a yearly figure split into
-- equal payments, so the employee record has to say both how the money is
-- quoted and how often it is paid out.
-- ---------------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'Hourly'
    CHECK (pay_type IN ('Hourly', 'Salary'));

ALTER TABLE employees ADD COLUMN pay_frequency TEXT NOT NULL DEFAULT 'BiWeekly'
    CHECK (pay_frequency IN ('Weekly', 'BiWeekly', 'SemiMonthly', 'Monthly'));

-- Only used when the employee is salaried: the yearly figure the period pay is
-- worked out from. An hourly employee's rate stays in pay_rate_cents.
ALTER TABLE employees ADD COLUMN salary_cents INTEGER NOT NULL DEFAULT 0
    CHECK (salary_cents >= 0);

-- A W-2 has a box 2 wage total and box a Social Security number, so the file
-- has to hold the whole number, not a hint of it. A company file is a private
-- document: keep it on a protected drive, and hand out backups the way you
-- would hand out payroll paperwork.
ALTER TABLE employees ADD COLUMN ssn TEXT NOT NULL DEFAULT ''
    CHECK (ssn = '' OR ssn GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]');

-- A pay run records the basis it was paid on, so a later raise or a change of
-- pay frequency never rewrites what an old check was worked out from.
ALTER TABLE payroll_runs ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'Hourly'
    CHECK (pay_type IN ('Hourly', 'Salary'));

ALTER TABLE payroll_runs ADD COLUMN pay_frequency TEXT NOT NULL DEFAULT 'BiWeekly'
    CHECK (pay_frequency IN ('Weekly', 'BiWeekly', 'SemiMonthly', 'Monthly'));

ALTER TABLE payroll_runs ADD COLUMN salary_cents INTEGER NOT NULL DEFAULT 0
    CHECK (salary_cents >= 0);
"#;

// ---------------------------------------------------------------------------
// Schema v8 — payroll as an access level of its own
// ---------------------------------------------------------------------------

const MIGRATION_8_DDL: &str = r#"
-- ---------------------------------------------------------------------------
-- A payroll person is neither a full bookkeeper nor a limited one: they run pay
-- and keep the roster, and the wages and Social Security numbers stay out of
-- everyone else's reach. SQLite cannot change a CHECK in place, so the table is
-- rebuilt with the same rows and one wider rule.
--
-- Foreign keys are switched off for the rebuild: time entries point at users
-- with ON DELETE SET NULL, and dropping the old table with them on would quietly
-- blank the owner of every hour and mile on the way past. No row is deleted —
-- the same ids are copied — so the file is left with no violations.
-- ---------------------------------------------------------------------------
PRAGMA foreign_keys = OFF;

CREATE TABLE users_v8 (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    email      TEXT    NOT NULL DEFAULT '',
    access     TEXT    NOT NULL DEFAULT 'Standard'
                       CHECK (access IN ('Admin', 'Standard', 'Payroll', 'TimeEntry', 'ReadOnly')),
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO users_v8 (id, name, email, access, is_active, created_at)
SELECT id, name, email, access, is_active, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_v8 RENAME TO users;
CREATE UNIQUE INDEX idx_users_name ON users(lower(name));

-- Dropping the old table dropped its triggers with it, and the rules they
-- carried are the ones worth keeping: a file always has an admin.
CREATE TRIGGER trg_users_keep_an_admin_upd
BEFORE UPDATE OF access, is_active ON users
WHEN OLD.access = 'Admin'
 AND OLD.is_active = 1
 AND (NEW.access <> 'Admin' OR NEW.is_active <> 1)
 AND (SELECT COUNT(*) FROM users
       WHERE access = 'Admin' AND is_active = 1 AND id <> OLD.id) = 0
BEGIN
    SELECT RAISE(ABORT, 'this is the last admin; promote someone else before changing this user');
END;

CREATE TRIGGER trg_users_keep_an_admin_del
BEFORE DELETE ON users
WHEN OLD.access = 'Admin'
 AND OLD.is_active = 1
 AND (SELECT COUNT(*) FROM users
       WHERE access = 'Admin' AND is_active = 1 AND id <> OLD.id) = 0
BEGIN
    SELECT RAISE(ABORT, 'this is the last admin; promote someone else before deleting this user');
END;

PRAGMA foreign_keys = ON;
"#;
