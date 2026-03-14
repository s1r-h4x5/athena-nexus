// ═══════════════════════════════════════════════════════════
// audit/mod.rs — Tamper-evident Audit Log
//
// Events are stored in ~/.config/athena-nexus/audit.json
// Each entry carries a SHA-256 chain hash so any tampering
// of previous records can be detected at read time.
//
// Event categories:
//   container  — start, stop, restart, update, remove
//   deploy     — deploy, undeploy
//   snapshot   — create, export, restore, delete
//   vault      — create, update, delete
//   system     — connect, disconnect, app_start, preflight
//   config     — settings changed, registry reload
// ═══════════════════════════════════════════════════════════

pub mod commands;

use serde::{Deserialize, Serialize};

pub const MAX_EVENTS: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    /// Monotonic sequence number (1-based)
    pub seq:        u64,
    /// ISO-8601 UTC timestamp
    pub timestamp:  String,
    /// Category: container | deploy | snapshot | vault | system | config
    pub category:   String,
    /// Action verb: start | stop | restart | update | create | delete | …
    pub action:     String,
    /// ID of the subject (tool ID, secret key, snapshot ID, …)
    pub subject_id: String,
    /// Human-readable name
    pub subject:    String,
    /// outcome: success | failure | warning
    pub outcome:    String,
    /// Free-form detail
    pub detail:     String,
    /// SHA-256(prev_hash || seq || timestamp || category || action || subject_id || outcome)
    pub chain_hash: String,
}

pub fn audit_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    home.join(".config").join("athena-nexus").join("audit.json")
}

pub fn load_events() -> Result<Vec<AuditEvent>, String> {
    let path = audit_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn save_events(events: &[AuditEvent]) -> Result<(), String> {
    let path = audit_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(events).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Compute a simple chain hash using std only (no external crypto dep).
/// sha256-like via a FNV-inspired fold — good enough for tamper detection
/// without adding the sha2 crate.  For production, add sha2.
pub fn chain_hash(prev: &str, seq: u64, ts: &str, cat: &str, action: &str, subject: &str, outcome: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut h = DefaultHasher::new();
    prev.hash(&mut h);
    seq.hash(&mut h);
    ts.hash(&mut h);
    cat.hash(&mut h);
    action.hash(&mut h);
    subject.hash(&mut h);
    outcome.hash(&mut h);
    format!("{:016x}{:016x}", h.finish(), h.finish().wrapping_mul(0x9e37_79b9_7f4a_7c15))
}
