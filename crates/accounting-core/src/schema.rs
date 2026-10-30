//! Company file schema. Each company lives in its own SQLite file, so the
//! schema is per-file and migrations are tracked with `PRAGMA user_version`.

pub const SCHEMA_VERSION: i32 = 3;

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
