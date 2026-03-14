// ═══════════════════════════════════════════════════════════
// vault/mod.rs — Secrets Vault backed by OS keyring
//
// Uses the `keyring` crate which delegates to:
//   Linux  → libsecret / GNOME Keyring / KWallet
//   macOS  → Keychain
//   Windows → Credential Manager
//
// Secret metadata (name, description, tool associations, kind)
// is stored in ~/.config/athena-nexus/vault.json.
// Secret VALUES live only in the OS keyring — never on disk.
// ═══════════════════════════════════════════════════════════

pub mod commands;

use serde::{Deserialize, Serialize};

/// Keyring service name — all secrets are stored under this namespace.
pub const SERVICE: &str = "athena-nexus";

/// Metadata record stored in vault.json (no secret values here).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretMeta {
    /// Unique key used both as vault index and keyring username.
    pub key: String,
    /// Human-readable display name.
    pub name: String,
    /// Free-form description of what this secret is for.
    pub description: String,
    /// Which tools inject this secret (list of tool IDs).
    pub tool_ids: Vec<String>,
    /// Category/kind: api_key | password | token | cert | env | other
    pub kind: String,
    /// Env-var name used when injecting into containers.
    pub env_var: String,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
    /// ISO-8601 last-modified timestamp.
    pub updated_at: String,
}

/// Path to the vault metadata file.
pub fn vault_meta_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    home.join(".config").join("athena-nexus").join("vault.json")
}

/// Load all secret metadata records from disk.
pub fn load_meta() -> Result<Vec<SecretMeta>, String> {
    let path = vault_meta_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Persist all secret metadata records to disk.
pub fn save_meta(records: &[SecretMeta]) -> Result<(), String> {
    let path = vault_meta_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Current UTC timestamp as ISO-8601 string.
pub fn now_iso() -> String {
    // Simple RFC-3339 via std — avoids pulling in chrono
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Format: YYYY-MM-DDTHH:MM:SSZ (approximate, good enough for display)
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    // Days since 1970-01-01 → Gregorian (Zeller-like)
    let (year, month, day) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, h, m, s)
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Epoch offset algorithm (no leap-second awareness, adequate for display)
    let z = days + 719468;
    let era = z / 146097;
    let doe = z % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
