//! # accounting-core
//!
//! Double-entry bookkeeping engine for the LedgerWorks desktop ledger.
//!
//! The engine is deliberately storage-first: every invariant that protects the
//! books (balanced entries, immutability of posted entries, posting only to
//! active detail accounts, an append-only audit trail) is enforced by the
//! SQLite schema itself, not only by this crate and certainly not only by the
//! UI. The Rust layer exists to give good error messages, to keep multi-step
//! operations transactional, and to compute reports.
//!
//! Invariants enforced in the database (see [`schema`]):
//!
//! * A journal entry is created as `DRAFT` and may only become `POSTED` when it
//!   has at least two lines, total debits equal total credits, and the value is
//!   non-zero.
//! * Each line carries exactly one of a debit or a credit (never both, never
//!   neither, never negative).
//! * Lines can only be added/changed/removed while the entry is a draft.
//! * Posted entries cannot be edited or deleted; they can only be voided.
//! * Posting to an inactive account or to a header account with sub-accounts is
//!   rejected.
//! * Every write to accounts, journal entries and journal lines is captured by
//!   triggers into `audit_log`, which is sealed into a SHA-256 hash chain.

pub mod accounts;
pub mod audit;
pub mod company;
pub mod dates;
pub mod db;
pub mod error;
pub mod journal;
pub mod money;
pub mod reports;
pub mod simple;

pub(crate) mod schema;

pub use error::{CoreError, Result};
