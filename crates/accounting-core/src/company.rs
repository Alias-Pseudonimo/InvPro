//! Company files: one SQLite database per company, plus the directory that
//! lists them.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::{accounts, db, CoreError, Result};

const FILE_EXTENSION: &str = "ledgerdb";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanySummary {
    pub path: String,
    pub file_name: String,
    pub name: String,
    pub legal_name: Option<String>,
    pub file_id: String,
    pub base_currency: String,
    pub fiscal_year_start_month: i64,
    pub schema_version: i32,
    pub size_bytes: u64,
    pub modified_at: String,
}

/// Default location for company files: `%APPDATA%\LedgerWorks\companies` on
/// Windows, `~/LedgerWorks/companies` elsewhere.
pub fn default_directory() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("LedgerWorks").join("companies");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("LedgerWorks").join("companies");
    }
    PathBuf::from(".").join("companies")
}

fn file_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{nanos:032x}{:08x}", std::process::id())
}

pub fn sanitize_file_stem(name: &str) -> String {
    let mut stem: String = name
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '&' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    stem = stem.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if stem.is_empty() {
        stem = "company".to_string();
    }
    if stem.len() > 80 {
        stem.truncate(80);
    }
    stem
}

/// Create a new company file with the standard chart of accounts.
pub fn create(
    directory: &Path,
    name: &str,
    base_currency: &str,
    fiscal_year_start_month: u8,
) -> Result<CompanySummary> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::validation("a company name is required"));
    }
    let currency = base_currency.trim().to_ascii_uppercase();
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(CoreError::validation(
            "the base currency must be a three-letter code, for example USD",
        ));
    }
    if !(1..=12).contains(&fiscal_year_start_month) {
        return Err(CoreError::validation(
            "the fiscal year must start in a month between 1 and 12",
        ));
    }

    fs::create_dir_all(directory)?;
    let mut path = directory.join(format!("{}.{}", sanitize_file_stem(name), FILE_EXTENSION));
    let mut suffix = 1;
    while path.exists() {
        suffix += 1;
        path = directory.join(format!(
            "{}-{}.{}",
            sanitize_file_stem(name),
            suffix,
            FILE_EXTENSION
        ));
    }

    let mut conn = db::open(&path)?;
    let id = file_id();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO company (id, file_id, name, base_currency, fiscal_year_start_month)
         VALUES (1, ?1, ?2, ?3, ?4)",
        params![id, name, currency, fiscal_year_start_month as i64],
    )?;
    accounts::seed_default_chart(&tx)?;
    crate::audit::seal_pending(&tx)?;
    tx.commit()?;

    describe(&path)
}

/// Read a company file's identity without keeping it open. Read-only so that it
/// is safe to list files that another session may be using.
pub fn describe(path: &Path) -> Result<CompanySummary> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let schema_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if schema_version == 0 {
        return Err(CoreError::validation(format!(
            "{} is not a company file",
            path.display()
        )));
    }
    let row = conn
        .query_row(
            "SELECT file_id, name, legal_name, base_currency, fiscal_year_start_month FROM company WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let (file_id, name, legal_name, base_currency, fiscal_year_start_month) = row
        .ok_or_else(|| CoreError::validation(format!("{} has no company record", path.display())))?;
    drop(conn);

    let metadata = fs::metadata(path)?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_default();

    Ok(CompanySummary {
        path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        name,
        legal_name,
        file_id,
        base_currency,
        fiscal_year_start_month,
        schema_version,
        size_bytes: metadata.len(),
        modified_at,
    })
}

/// Every company file in a directory. Unreadable files are skipped rather than
/// failing the whole list.
pub fn list(directory: &Path) -> Result<Vec<CompanySummary>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut companies = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some(FILE_EXTENSION) {
            continue;
        }
        if let Ok(summary) = describe(&path) {
            companies.push(summary);
        }
    }
    companies.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(companies)
}

/// Copy a company file to a new name inside the same directory. Used by
/// "save a copy" and by the migration path for imported companies.
pub fn copy_to(source: &Path, directory: &Path, new_name: &str) -> Result<CompanySummary> {
    describe(source)?;
    fs::create_dir_all(directory)?;
    let mut target = directory.join(format!("{}.{}", sanitize_file_stem(new_name), FILE_EXTENSION));
    let mut suffix = 1;
    while target.exists() {
        suffix += 1;
        target = directory.join(format!(
            "{}-{}.{}",
            sanitize_file_stem(new_name),
            suffix,
            FILE_EXTENSION
        ));
    }
    fs::copy(source, &target)?;
    let conn = db::open(&target)?;
    conn.execute("UPDATE company SET name = ?1 WHERE id = 1", [new_name.trim()])?;
    drop(conn);
    describe(&target)
}
