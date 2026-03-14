// ═══════════════════════════════════════════════════════════
// registry/commands.rs
//
// The bundled tools.json ships inside the binary via include_str!.
// On first run it is seeded to ~/.config/athena-nexus/tools.json.
// The active path can be overridden in config.json (registry_path field).
// ═══════════════════════════════════════════════════════════

use super::{Registry, ToolDefinition};
use crate::config::{self, AppConfig};
use std::path::PathBuf;

const BUNDLED_REGISTRY: &str = include_str!("../../registry/tools.json");

/// Default registry path: ~/.config/athena-nexus/tools.json
fn default_registry_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".config").join("athena-nexus").join("tools.json")
}

/// Resolve the active registry path: config override → default
fn active_registry_path() -> PathBuf {
    if let Ok(cfg) = load_app_config() {
        if let Some(custom) = cfg.registry_path.filter(|s| !s.is_empty()) {
            return PathBuf::from(custom);
        }
    }
    default_registry_path()
}

fn load_app_config() -> Result<AppConfig, String> {
    let path = config::config_path();
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_app_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config::config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Seed default tools.json on first run, or overwrite if the bundled version is newer.
/// This ensures users with old integer-port files get the corrected format.
pub fn seed_registry_if_missing() {
    let path = default_registry_path();

    // Parse the bundled version number
    let bundled_version: u64 = serde_json::from_str::<serde_json::Value>(BUNDLED_REGISTRY)
        .ok()
        .and_then(|v| v["version"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(1);

    // If file exists, only overwrite if bundled version is strictly newer
    if path.exists() {
        let should_overwrite = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v["version"].as_str().and_then(|s| s.parse::<u64>().ok()))
            .map(|disk_ver| bundled_version > disk_ver)
            .unwrap_or(false); // if disk file is unreadable/corrupt, leave it alone

        if !should_overwrite { return; }
        log::info!("Bundled registry v{bundled_version} is newer than disk copy — updating");
    }

    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::error!("Failed to create config dir: {e}");
            return;
        }
    }
    match std::fs::write(&path, BUNDLED_REGISTRY) {
        Ok(_)  => log::info!("Seeded registry → {}", path.display()),
        Err(e) => log::error!("Failed to seed registry: {e}"),
    }
}

/// Load tools from the active registry path.
#[tauri::command]
pub fn load_registry() -> Result<Vec<ToolDefinition>, String> {
    let path = active_registry_path();
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let registry: Registry = serde_json::from_str(&raw)
        .map_err(|e| format!("Parse error in {}: {e}", path.display()))?;
    Ok(registry.tools.into_iter().map(resolve_port_placeholders).collect())
}

/// Resolve `{port}` placeholders in `entrypoint` and `health_check`.
///
/// `{port}` is replaced with the host-side port extracted from `ports[0]`.
/// e.g. ports = ["8081:8000"], entrypoint = "http://localhost:{port}"
///      → entrypoint = "http://localhost:8081"
///
/// If no ports are defined or the entry has no placeholder, it is unchanged.
fn resolve_port_placeholders(mut tool: ToolDefinition) -> ToolDefinition {
    // Extract host port from first port spec: "8081:8000" → "8081", "8080" → "8080"
    let host_port: Option<String> = tool.access.ports.first().map(|spec: &String| {
        spec.split(':').next().unwrap_or(spec.as_str()).to_string()
    });

    if let Some(ref port) = host_port {
        if let Some(ref ep) = tool.access.entrypoint.clone() {
            if ep.contains("{port}") {
                tool.access.entrypoint = Some(ep.replace("{port}", port));
            }
        }
        if let Some(ref hc) = tool.access.health_check.clone() {
            if hc.contains("{port}") {
                tool.access.health_check = Some(hc.replace("{port}", port));
            }
        }
    }
    tool
}

/// Return the currently active registry file path.
#[tauri::command]
pub fn registry_file_path() -> String {
    active_registry_path().to_string_lossy().to_string()
}

/// Persist a new registry path into config.json.
/// Pass an empty string to reset to the default path.
#[tauri::command]
pub fn set_registry_path(path: String) -> Result<String, String> {
    let mut cfg = load_app_config().unwrap_or_default();
    let trimmed = path.trim().to_string();

    if trimmed.is_empty() {
        cfg.registry_path = None;
    } else {
        // Validate: file must exist and be valid JSON
        let raw = std::fs::read_to_string(&trimmed)
            .map_err(|e| format!("Cannot read {trimmed}: {e}"))?;
        serde_json::from_str::<Registry>(&raw)
            .map_err(|e| format!("Parse error in {trimmed}: {e}"))?;
        cfg.registry_path = Some(trimmed.clone());
    }

    save_app_config(&cfg)?;

    // Return the now-active path for the UI to display
    Ok(active_registry_path().to_string_lossy().to_string())
}
