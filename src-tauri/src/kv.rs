// ── kv.rs ─────────────────────────────────────────────────────
// Tiny key-value store backed by ~/.config/athena-nexus/kv.json
// Used for persisting UI state (card order, preferences, etc.)

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::command;

fn kv_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("athena-nexus").join("kv.json"))
}

fn read_store() -> HashMap<String, String> {
    kv_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(store: &HashMap<String, String>) {
    if let Some(path) = kv_path() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(store) {
            let _ = fs::write(path, json);
        }
    }
}

#[command]
pub fn kv_get(key: String) -> Option<String> {
    read_store().remove(&key)
}

#[command]
pub fn kv_set(key: String, value: String) {
    let mut store = read_store();
    store.insert(key, value);
    write_store(&store);
}

#[command]
pub fn kv_delete(key: String) {
    let mut store = read_store();
    store.remove(&key);
    write_store(&store);
}
