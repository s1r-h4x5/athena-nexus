// ═══════════════════════════════════════════════════════════
// vault/commands.rs — Tauri commands for Secrets Vault
// ═══════════════════════════════════════════════════════════

use super::{load_meta, now_iso, save_meta, SecretMeta, SERVICE};
use keyring::Entry;
use serde::{Deserialize, Serialize};

/// Lightweight record returned to the frontend (no secret value).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SecretRecord {
    pub key:         String,
    pub name:        String,
    pub description: String,
    pub tool_ids:    Vec<String>,
    pub kind:        String,
    pub env_var:     String,
    pub created_at:  String,
    pub updated_at:  String,
    /// Whether the keyring actually has a value stored for this key.
    pub has_value:   bool,
}

impl From<&SecretMeta> for SecretRecord {
    fn from(m: &SecretMeta) -> Self {
        let has_value = Entry::new(SERVICE, &m.key)
            .ok()
            .and_then(|e| e.get_password().ok())
            .is_some();
        Self {
            key:         m.key.clone(),
            name:        m.name.clone(),
            description: m.description.clone(),
            tool_ids:    m.tool_ids.clone(),
            kind:        m.kind.clone(),
            env_var:     m.env_var.clone(),
            created_at:  m.created_at.clone(),
            updated_at:  m.updated_at.clone(),
            has_value,
        }
    }
}

// ── List all secrets (metadata only, no values) ──────────── //
#[tauri::command]
pub fn vault_list() -> Result<Vec<SecretRecord>, String> {
    let meta = load_meta()?;
    Ok(meta.iter().map(SecretRecord::from).collect())
}

// ── Create a new secret ───────────────────────────────────── //
#[tauri::command]
pub fn vault_create(
    key:         String,
    name:        String,
    description: String,
    kind:        String,
    env_var:     String,
    value:       String,
    tool_ids:    Vec<String>,
) -> Result<SecretRecord, String> {
    let mut records = load_meta()?;

    // Reject duplicate keys
    if records.iter().any(|r| r.key == key) {
        return Err(format!("A secret with key '{}' already exists.", key));
    }

    // Store value in OS keyring
    Entry::new(SERVICE, &key)
        .map_err(|e| format!("Keyring error: {}", e))?
        .set_password(&value)
        .map_err(|e| format!("Failed to store secret: {}", e))?;

    let now = now_iso();
    let meta = SecretMeta {
        key: key.clone(),
        name,
        description,
        tool_ids,
        kind,
        env_var,
        created_at: now.clone(),
        updated_at: now,
    };

    let record = SecretRecord::from(&meta);
    records.push(meta);
    save_meta(&records)?;
    Ok(record)
}

// ── Update secret metadata (and optionally its value) ─────── //
#[tauri::command]
pub fn vault_update(
    key:         String,
    name:        Option<String>,
    description: Option<String>,
    kind:        Option<String>,
    env_var:     Option<String>,
    value:       Option<String>,
    tool_ids:    Option<Vec<String>>,
) -> Result<SecretRecord, String> {
    let mut records = load_meta()?;

    let meta = records.iter_mut()
        .find(|r| r.key == key)
        .ok_or_else(|| format!("Secret '{}' not found.", key))?;

    if let Some(v) = name        { meta.name        = v; }
    if let Some(v) = description { meta.description = v; }
    if let Some(v) = kind        { meta.kind        = v; }
    if let Some(v) = env_var     { meta.env_var     = v; }
    if let Some(v) = tool_ids    { meta.tool_ids    = v; }
    meta.updated_at = now_iso();

    // Update keyring value if provided
    if let Some(v) = value {
        if !v.is_empty() {
            Entry::new(SERVICE, &key)
                .map_err(|e| format!("Keyring error: {}", e))?
                .set_password(&v)
                .map_err(|e| format!("Failed to update secret: {}", e))?;
        }
    }

    let record = SecretRecord::from(&*meta);
    save_meta(&records)?;
    Ok(record)
}

// ── Delete a secret ───────────────────────────────────────── //
#[tauri::command]
pub fn vault_delete(key: String) -> Result<(), String> {
    // Remove from keyring (best-effort — if not found, continue)
    if let Ok(entry) = Entry::new(SERVICE, &key) {
        let _ = entry.delete_credential();
    }

    let mut records = load_meta()?;
    let before = records.len();
    records.retain(|r| r.key != key);

    if records.len() == before {
        return Err(format!("Secret '{}' not found.", key));
    }

    save_meta(&records)
}

// ── Retrieve the plaintext value for a single secret ─────── //
// (Only used internally — never sent to untrusted frontends)
#[tauri::command]
pub fn vault_get_value(key: String) -> Result<String, String> {
    Entry::new(SERVICE, &key)
        .map_err(|e| format!("Keyring error: {}", e))?
        .get_password()
        .map_err(|e| format!("Failed to read secret '{}': {}", key, e))
}

// ── Retrieve all env vars for a set of secret keys ────────── //
// Used by the deploy pipeline to inject secrets as env vars.
#[tauri::command]
pub fn vault_get_env_vars(keys: Vec<String>) -> Result<Vec<(String, String)>, String> {
    let records = load_meta()?;
    let mut pairs = Vec::new();

    for key in &keys {
        let meta = records.iter().find(|r| &r.key == key);
        let env_var = meta.map(|m| m.env_var.clone()).unwrap_or_else(|| key.to_uppercase());

        match Entry::new(SERVICE, key) {
            Ok(entry) => match entry.get_password() {
                Ok(val) => pairs.push((env_var, val)),
                Err(e)  => return Err(format!("Cannot read '{}': {}", key, e)),
            },
            Err(e) => return Err(format!("Keyring error for '{}': {}", key, e)),
        }
    }

    Ok(pairs)
}
