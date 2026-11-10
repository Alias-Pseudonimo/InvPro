//! Tamper-evident audit trail.
//!
//! Triggers in the schema capture every write as a row with `hash IS NULL`. The
//! application calls [`seal_pending`] inside the same transaction that made the
//! change, which links each row to its predecessor with a SHA-256 hash. Rows
//! that were never sealed are reported as such rather than being silently
//! trusted, and a rewritten or deleted row breaks the chain.

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub seq: i64,
    pub at: String,
    pub actor: String,
    pub action: String,
    pub entity: String,
    pub entity_id: Option<i64>,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainReport {
    pub total: i64,
    pub sealed: i64,
    pub unsealed: i64,
    /// First sequence number whose stored hash does not match a recomputation
    /// of the row and its predecessor, if any.
    pub broken_at: Option<i64>,
    pub head_hash: Option<String>,
    pub ok: bool,
}

/// Genesis link for the first sealed row.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn digest(prev: &str, row: &(i64, String, String, String, String, Option<i64>, Option<String>, Option<String>)) -> String {
    let (seq, at, actor, action, entity, entity_id, before, after) = row;
    let payload = format!(
        "{prev}|{seq}|{at}|{actor}|{action}|{entity}|{}|{}|{}",
        entity_id.map(|v| v.to_string()).unwrap_or_default(),
        before.as_deref().unwrap_or(""),
        after.as_deref().unwrap_or(""),
    );
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    let out = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in out {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Seal every unsealed audit row on this connection. Call inside the writing
/// transaction so the trail commits together with the change it describes.
pub fn seal_pending(conn: &Connection) -> Result<usize> {
    let mut prev: String = conn
        .query_row(
            "SELECT hash FROM audit_log WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| GENESIS.to_string());

    let mut stmt = conn.prepare(
        "SELECT seq, at, actor, action, entity, entity_id, before_json, after_json
           FROM audit_log WHERE hash IS NULL ORDER BY seq",
    )?;
    let pending = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut update = conn.prepare("UPDATE audit_log SET prev_hash = ?2, hash = ?3 WHERE seq = ?1")?;
    let mut count = 0;
    for row in &pending {
        let hash = digest(&prev, row);
        update.execute(params![row.0, prev, hash])?;
        prev = hash;
        count += 1;
    }
    Ok(count)
}

pub fn list(conn: &Connection, limit: i64) -> Result<Vec<AuditRow>> {
    let limit = limit.clamp(1, 2_000);
    let mut stmt = conn.prepare(
        "SELECT seq, at, actor, action, entity, entity_id, before_json, after_json, hash
           FROM audit_log ORDER BY seq DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(AuditRow {
                seq: row.get(0)?,
                at: row.get(1)?,
                actor: row.get(2)?,
                action: row.get(3)?,
                entity: row.get(4)?,
                entity_id: row.get(5)?,
                before_json: row.get(6)?,
                after_json: row.get(7)?,
                hash: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Recompute the whole chain and report the first row that does not verify.
pub fn verify(conn: &Connection) -> Result<ChainReport> {
    let mut stmt = conn.prepare(
        "SELECT seq, at, actor, action, entity, entity_id, before_json, after_json,
                prev_hash, hash
           FROM audit_log ORDER BY seq",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                (
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ),
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut total = 0;
    let mut sealed = 0;
    let mut unsealed = 0;
    let mut broken_at = None;
    let mut prev = GENESIS.to_string();
    let mut head = None;

    for ((seq, at, actor, action, entity, entity_id, before, after), stored_prev, stored_hash) in rows
    {
        total += 1;
        match (stored_hash, stored_prev) {
            (Some(hash), Some(prev_hash)) => {
                let expected = digest(
                    &prev_hash,
                    &(seq, at, actor, action, entity, entity_id, before, after),
                );
                if broken_at.is_none() && (expected != hash || prev_hash != prev) {
                    broken_at = Some(seq);
                }
                prev = hash.clone();
                head = Some(hash);
                sealed += 1;
            }
            _ => {
                unsealed += 1;
            }
        }
    }

    Ok(ChainReport {
        total,
        sealed,
        unsealed,
        broken_at,
        head_hash: head,
        ok: broken_at.is_none() && unsealed == 0,
    })
}
