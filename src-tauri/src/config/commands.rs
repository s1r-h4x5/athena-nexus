use super::{config_path, AppConfig};
use crate::vault::{load_meta as load_vault_meta, now_iso};
use crate::snapshot::load_meta as load_snap_meta;
use crate::container::detect_available_runtimes;
use crate::AppState;
use std::fs;
use tauri::State;
use serde::{Deserialize, Serialize};

/// Full configuration bundle — what gets exported/imported.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigBundle {
    pub export_version: String,
    pub exported_at:    String,
    pub app_config:     AppConfig,
    /// Vault secret metadata (keys/names/envvars only — NO values)
    pub vault_keys:     Vec<crate::vault::SecretMeta>,
    /// Snapshot metadata (no tarballs)
    pub snapshots:      Vec<crate::snapshot::SnapshotRecord>,
}

#[tauri::command]
pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Parse error in {}: {e}", path.display()))
}

/// Write config to disk only — synchronous, no AppState, no async.
/// Used internally by user_tools.rs and config_import_apply where
/// no Tauri State handle is available.
pub(super) fn write_config_to_disk(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Tauri command: persist config AND apply runtime/socket change live without restart.
#[tauri::command]
pub async fn save_config(state: State<'_, AppState>, config: AppConfig) -> Result<(), String> {
    write_config_to_disk(&config)?;

    // Apply the runtime/socket selection immediately
    let mut client = state.container.lock().await;
    client.apply_config(
        &config.container_runtime,
        config.podman_socket.as_deref(),
        config.docker_socket.as_deref(),
    );
    Ok(())
}

/// Return detected socket paths and availability for Podman and Docker.
#[tauri::command]
pub fn detect_runtimes() -> Vec<crate::container::RuntimeInfo> {
    detect_available_runtimes()
}

/// Export the full config bundle to a file path.
#[tauri::command]
pub fn config_export(dest_path: String) -> Result<String, String> {
    let app_config  = load_config()?;
    let vault_keys  = load_vault_meta().unwrap_or_default();
    let snapshots   = load_snap_meta().unwrap_or_default();

    let bundle = ConfigBundle {
        export_version: "1".to_string(),
        exported_at:    now_iso(),
        app_config,
        vault_keys,
        snapshots,
    };

    let raw = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;

    let path = std::path::Path::new(&dest_path);
    let final_path = if path.is_dir() {
        path.join(format!("athena-nexus-config-{}.json", now_iso().replace(':', "-")))
    } else {
        path.to_path_buf()
    };

    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(&final_path, raw).map_err(|e| e.to_string())?;
    Ok(final_path.to_string_lossy().to_string())
}

/// Import a config bundle from a file path.
/// Returns the bundle so the frontend can preview before applying.
#[tauri::command]
pub fn config_import_preview(src_path: String) -> Result<ConfigBundle, String> {
    let raw = fs::read_to_string(&src_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid config bundle: {}", e))
}

/// Apply the imported bundle (replaces app_config on disk; vault/snapshot metadata merged).
/// Note: runtime is NOT hot-applied here because there is no AppState in a sync command.
/// The user will need to restart or trigger a save_config to pick up a runtime change from import.
#[tauri::command]
pub fn config_import_apply(bundle: ConfigBundle) -> Result<(), String> {
    write_config_to_disk(&bundle.app_config)?;

    // Merge vault metadata (add keys not already present — never overwrite)
    let mut vault = load_vault_meta().unwrap_or_default();
    for incoming in bundle.vault_keys {
        if !vault.iter().any(|v| v.key == incoming.key) {
            vault.push(incoming);
        }
    }
    crate::vault::save_meta(&vault)?;

    // Merge snapshot metadata (add records not already present)
    let mut snaps = load_snap_meta().unwrap_or_default();
    for incoming in bundle.snapshots {
        if !snaps.iter().any(|s| s.id == incoming.id) {
            snaps.push(incoming);
        }
    }
    crate::snapshot::save_meta(&snaps)?;

    Ok(())
}

/// Default export directory (home dir)
#[tauri::command]
pub fn config_default_export_dir() -> Result<String, String> {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    Ok(home.to_string_lossy().to_string())
}
