// ═══════════════════════════════════════════════════════════
// snapshot/mod.rs — Snapshot & Backup
//
// Snapshot metadata is stored in ~/.config/athena-nexus/snapshots.json
// Actual image tarballs live in ~/.local/share/athena-nexus/snapshots/
// ═══════════════════════════════════════════════════════════

pub mod commands;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRecord {
    /// Unique ID (timestamp-based)
    pub id: String,
    /// Tool ID this snapshot belongs to
    pub tool_id: String,
    /// Display name of the tool at snapshot time
    pub tool_name: String,
    /// Container IDs included in this snapshot
    pub container_ids: Vec<String>,
    /// Committed image names (one per container)
    pub image_names: Vec<String>,
    /// Path to exported .tar on disk (optional — set after export)
    pub tar_path: Option<String>,
    /// Human description / note
    pub note: String,
    /// Snapshot size in bytes (set after export)
    pub size_bytes: Option<u64>,
    /// ISO-8601 creation timestamp
    pub created_at: String,
    /// Whether the .tar file still exists on disk
    pub exported: bool,
}

pub fn snapshots_meta_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    home.join(".config").join("athena-nexus").join("snapshots.json")
}

pub fn snapshots_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    home.join(".local").join("share").join("athena-nexus").join("snapshots")
}

pub fn load_meta() -> Result<Vec<SnapshotRecord>, String> {
    let path = snapshots_meta_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn save_meta(records: &[SnapshotRecord]) -> Result<(), String> {
    let path = snapshots_meta_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}
