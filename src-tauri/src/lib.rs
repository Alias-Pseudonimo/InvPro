//! Tauri command surface. The shell owns exactly one open company file and
//! forwards each call into `accounting-core`; no bookkeeping rule lives here.

use std::path::PathBuf;
use std::sync::Mutex;

use accounting_core::accounts::{self, Account, AccountInput};
use accounting_core::audit::{self, AuditRow, ChainReport};
use accounting_core::company::{self, CompanySummary};
use accounting_core::journal::{self, EntryDetail, EntrySummary, JournalEntryInput};
use accounting_core::reports::{self, TrialBalanceReport};
use accounting_core::simple::{
    self, BalanceSheet, Customer, Dashboard, ExpenseInput, ExpenseRecord, IncomeInput,
    IncomeRecord, InventoryInput, InventoryItem, Invoice, InvoiceInput, PartyInput, PayrollInput,
    PayrollRun, ProfitAndLoss, Purchase, PurchaseInput, RecurringInvoice, RecurringInvoiceInput,
    Setting, TaxSummary, Vendor,
};
use accounting_core::{db, CoreError};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

struct Session {
    path: PathBuf,
    conn: Connection,
}

pub struct AppState {
    session: Mutex<Option<Session>>,
    companies_directory: PathBuf,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            companies_directory: company::default_directory(),
        }
    }
}

fn error_text(err: CoreError) -> String {
    err.to_string()
}

fn with_session<T>(
    state: &AppState,
    action: impl FnOnce(&mut Connection) -> accounting_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "the company session is unavailable".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "no company file is open".to_string())?;
    action(&mut session.conn).map_err(error_text)
}

fn summarize(session: &Session) -> Result<CompanySummary, String> {
    company::describe(&session.path).map_err(error_text)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCompanyInput {
    pub name: String,
    #[serde(default)]
    pub base_currency: Option<String>,
    #[serde(default)]
    pub fiscal_year_start_month: Option<u8>,
    #[serde(default)]
    pub actor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCompanyInput {
    pub path: String,
    #[serde(default)]
    pub actor: Option<String>,
}

fn resolve_actor(requested: Option<String>) -> String {
    requested
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("USERNAME").ok())
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "local user".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerHealth {
    pub schema_version: i32,
    pub integrity: String,
    pub balanced: bool,
    pub account_count: i64,
    pub entry_count: i64,
}

#[tauri::command]
fn list_companies(state: State<'_, AppState>) -> Result<Vec<CompanySummary>, String> {
    company::list(&state.companies_directory).map_err(error_text)
}

#[tauri::command]
fn companies_directory(state: State<'_, AppState>) -> String {
    state.companies_directory.to_string_lossy().to_string()
}

#[tauri::command]
fn create_company(
    state: State<'_, AppState>,
    input: CreateCompanyInput,
) -> Result<CompanySummary, String> {
    let created = company::create(
        &state.companies_directory,
        &input.name,
        input.base_currency.as_deref().unwrap_or("USD"),
        input.fiscal_year_start_month.unwrap_or(1),
    )
    .map_err(error_text)?;

    let conn = db::open(std::path::Path::new(&created.path)).map_err(error_text)?;
    db::set_actor(&conn, &resolve_actor(input.actor)).map_err(error_text)?;

    let mut guard = state
        .session
        .lock()
        .map_err(|_| "the company session is unavailable".to_string())?;
    *guard = Some(Session {
        path: PathBuf::from(&created.path),
        conn,
    });
    drop(guard);
    Ok(created)
}

#[tauri::command]
fn open_company(
    state: State<'_, AppState>,
    input: OpenCompanyInput,
) -> Result<CompanySummary, String> {
    let path = PathBuf::from(&input.path);
    let summary = company::describe(&path).map_err(error_text)?;
    let conn = db::open(&path).map_err(error_text)?;
    db::set_actor(&conn, &resolve_actor(input.actor)).map_err(error_text)?;

    let mut guard = state
        .session
        .lock()
        .map_err(|_| "the company session is unavailable".to_string())?;
    *guard = Some(Session { path, conn });
    drop(guard);
    Ok(summary)
}

#[tauri::command]
fn close_company(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "the company session is unavailable".to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
fn current_company(state: State<'_, AppState>) -> Result<Option<CompanySummary>, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "the company session is unavailable".to_string())?;
    match guard.as_ref() {
        Some(session) => summarize(session).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn list_accounts(state: State<'_, AppState>) -> Result<Vec<Account>, String> {
    with_session(&state, |conn| accounts::list(conn))
}

#[tauri::command]
fn create_account(state: State<'_, AppState>, input: AccountInput) -> Result<Account, String> {
    with_session(&state, |conn| accounts::create(conn, &input))
}

#[tauri::command]
fn set_account_active(state: State<'_, AppState>, account_id: i64, active: bool) -> Result<(), String> {
    with_session(&state, |conn| accounts::set_active(conn, account_id, active))
}

#[tauri::command]
fn list_journal_entries(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<EntrySummary>, String> {
    with_session(&state, |conn| journal::list(conn, limit.unwrap_or(100)))
}

#[tauri::command]
fn post_journal_entry(
    state: State<'_, AppState>,
    input: JournalEntryInput,
) -> Result<EntryDetail, String> {
    with_session(&state, |conn| journal::post(conn, &input))
}

#[tauri::command]
fn void_journal_entry(state: State<'_, AppState>, entry_id: i64) -> Result<(), String> {
    with_session(&state, |conn| journal::void_entry(conn, entry_id))
}

#[tauri::command]
fn trial_balance(state: State<'_, AppState>) -> Result<TrialBalanceReport, String> {
    with_session(&state, |conn| reports::trial_balance(conn))
}

#[tauri::command]
fn verify_audit_chain(state: State<'_, AppState>) -> Result<ChainReport, String> {
    with_session(&state, |conn| audit::verify(conn))
}

#[tauri::command]
fn list_audit_log(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<AuditRow>, String> {
    with_session(&state, |conn| audit::list(conn, limit.unwrap_or(200)))
}

#[tauri::command]
fn ledger_health(state: State<'_, AppState>) -> Result<LedgerHealth, String> {
    with_session(&state, |conn| {
        let account_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))?;
        let entry_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))?;
        Ok(LedgerHealth {
            schema_version: db::schema_version(conn)?,
            integrity: db::integrity_check(conn)?,
            balanced: reports::ledger_is_balanced(conn)?,
            account_count,
            entry_count,
        })
    })
}

// ---------------------------------------------------------------------------
// Plain-language records. Each of these is a single call from the UI; the
// posting rules behind them live in `accounting_core::simple`.
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_customers(state: State<'_, AppState>) -> Result<Vec<Customer>, String> {
    with_session(&state, |conn| simple::list_customers(conn))
}

#[tauri::command]
fn save_customer(state: State<'_, AppState>, input: PartyInput) -> Result<Customer, String> {
    with_session(&state, |conn| simple::save_customer(conn, &input))
}

#[tauri::command]
fn delete_customer(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_customer(conn, id))
}

#[tauri::command]
fn list_vendors(state: State<'_, AppState>) -> Result<Vec<Vendor>, String> {
    with_session(&state, |conn| simple::list_vendors(conn))
}

#[tauri::command]
fn save_vendor(state: State<'_, AppState>, input: PartyInput) -> Result<Vendor, String> {
    with_session(&state, |conn| simple::save_vendor(conn, &input))
}

#[tauri::command]
fn delete_vendor(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_vendor(conn, id))
}

#[tauri::command]
fn list_inventory(state: State<'_, AppState>) -> Result<Vec<InventoryItem>, String> {
    with_session(&state, |conn| simple::list_inventory(conn))
}

#[tauri::command]
fn save_inventory_item(
    state: State<'_, AppState>,
    input: InventoryInput,
) -> Result<InventoryItem, String> {
    with_session(&state, |conn| simple::save_inventory_item(conn, &input))
}

#[tauri::command]
fn delete_inventory_item(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_inventory_item(conn, id))
}

#[tauri::command]
fn list_income(state: State<'_, AppState>) -> Result<Vec<IncomeRecord>, String> {
    with_session(&state, |conn| simple::list_income(conn))
}

#[tauri::command]
fn save_income(state: State<'_, AppState>, input: IncomeInput) -> Result<IncomeRecord, String> {
    with_session(&state, |conn| simple::save_income(conn, &input))
}

#[tauri::command]
fn delete_income(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_income(conn, id))
}

#[tauri::command]
fn list_expenses(state: State<'_, AppState>) -> Result<Vec<ExpenseRecord>, String> {
    with_session(&state, |conn| simple::list_expenses(conn))
}

#[tauri::command]
fn save_expense(state: State<'_, AppState>, input: ExpenseInput) -> Result<ExpenseRecord, String> {
    with_session(&state, |conn| simple::save_expense(conn, &input))
}

#[tauri::command]
fn delete_expense(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_expense(conn, id))
}

#[tauri::command]
fn list_invoices(state: State<'_, AppState>) -> Result<Vec<Invoice>, String> {
    with_session(&state, |conn| simple::list_invoices(conn))
}

#[tauri::command]
fn get_invoice(state: State<'_, AppState>, id: i64) -> Result<Invoice, String> {
    with_session(&state, |conn| simple::get_invoice(conn, id))
}

#[tauri::command]
fn save_invoice(state: State<'_, AppState>, input: InvoiceInput) -> Result<Invoice, String> {
    with_session(&state, |conn| simple::save_invoice(conn, &input))
}

#[tauri::command]
fn delete_invoice(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_invoice(conn, id))
}

#[tauri::command]
fn list_recurring_invoices(state: State<'_, AppState>) -> Result<Vec<RecurringInvoice>, String> {
    with_session(&state, |conn| simple::list_recurring_invoices(conn))
}

#[tauri::command]
fn save_recurring_invoice(
    state: State<'_, AppState>,
    input: RecurringInvoiceInput,
) -> Result<RecurringInvoice, String> {
    with_session(&state, |conn| simple::save_recurring_invoice(conn, &input))
}

#[tauri::command]
fn delete_recurring_invoice(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_recurring_invoice(conn, id))
}

#[tauri::command]
fn generate_due_invoices(
    state: State<'_, AppState>,
    today: String,
) -> Result<Vec<Invoice>, String> {
    with_session(&state, |conn| simple::generate_due_invoices(conn, &today))
}

#[tauri::command]
fn list_purchases(state: State<'_, AppState>) -> Result<Vec<Purchase>, String> {
    with_session(&state, |conn| simple::list_purchases(conn))
}

#[tauri::command]
fn save_purchase(state: State<'_, AppState>, input: PurchaseInput) -> Result<Purchase, String> {
    with_session(&state, |conn| simple::save_purchase(conn, &input))
}

#[tauri::command]
fn delete_purchase(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_purchase(conn, id))
}

#[tauri::command]
fn list_payroll(state: State<'_, AppState>) -> Result<Vec<PayrollRun>, String> {
    with_session(&state, |conn| simple::list_payroll(conn))
}

#[tauri::command]
fn save_payroll(state: State<'_, AppState>, input: PayrollInput) -> Result<PayrollRun, String> {
    with_session(&state, |conn| simple::save_payroll(conn, &input))
}

#[tauri::command]
fn delete_payroll(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_session(&state, |conn| simple::delete_payroll(conn, id))
}

#[tauri::command]
fn dashboard(state: State<'_, AppState>) -> Result<Dashboard, String> {
    with_session(&state, |conn| simple::dashboard(conn))
}

#[tauri::command]
fn profit_and_loss(
    state: State<'_, AppState>,
    from: Option<String>,
    to: Option<String>,
) -> Result<ProfitAndLoss, String> {
    with_session(&state, |conn| {
        simple::profit_and_loss(conn, from.as_deref(), to.as_deref())
    })
}

#[tauri::command]
fn balance_sheet(
    state: State<'_, AppState>,
    as_of: Option<String>,
) -> Result<BalanceSheet, String> {
    with_session(&state, |conn| simple::balance_sheet(conn, as_of.as_deref()))
}

#[tauri::command]
fn tax_summary(
    state: State<'_, AppState>,
    from: Option<String>,
    to: Option<String>,
) -> Result<TaxSummary, String> {
    with_session(&state, |conn| {
        simple::tax_summary(conn, from.as_deref(), to.as_deref())
    })
}

#[tauri::command]
fn list_settings(state: State<'_, AppState>) -> Result<Vec<Setting>, String> {
    with_session(&state, |conn| simple::settings(conn))
}

#[tauri::command]
fn save_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    with_session(&state, |conn| simple::put_setting(conn, &key, &value))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_companies,
            companies_directory,
            create_company,
            open_company,
            close_company,
            current_company,
            list_accounts,
            create_account,
            set_account_active,
            list_journal_entries,
            post_journal_entry,
            void_journal_entry,
            trial_balance,
            verify_audit_chain,
            list_audit_log,
            ledger_health,
            list_customers,
            save_customer,
            delete_customer,
            list_vendors,
            save_vendor,
            delete_vendor,
            list_inventory,
            save_inventory_item,
            delete_inventory_item,
            list_income,
            save_income,
            delete_income,
            list_expenses,
            save_expense,
            delete_expense,
            list_invoices,
            get_invoice,
            save_invoice,
            delete_invoice,
            list_recurring_invoices,
            save_recurring_invoice,
            delete_recurring_invoice,
            generate_due_invoices,
            list_purchases,
            save_purchase,
            delete_purchase,
            list_payroll,
            save_payroll,
            delete_payroll,
            dashboard,
            profit_and_loss,
            balance_sheet,
            tax_summary,
            list_settings,
            save_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LedgerWorks");
}
