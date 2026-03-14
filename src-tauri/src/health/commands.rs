// ═══════════════════════════════════════════════════════════
// health/commands.rs — Container health checking
//
// Web tools:  HTTP HEAD to health_check URL (4s timeout)
// CLI tools:  `<runtime> exec <id> true` (verifies exec works)
// ═══════════════════════════════════════════════════════════

use std::time::Duration;
use tokio::process::Command;
use tauri::State;
use crate::AppState;

#[derive(Debug, serde::Serialize)]
pub struct HealthResult {
    /// "healthy" | "unhealthy" | "ready" | "unresponsive"
    pub status: String,
    /// Short detail: HTTP status code, error message, etc.
    pub detail: Option<String>,
}

impl HealthResult {
    fn healthy(detail: impl Into<String>) -> Self {
        Self { status: "healthy".into(), detail: Some(detail.into()) }
    }
    fn unhealthy(detail: impl Into<String>) -> Self {
        Self { status: "unhealthy".into(), detail: Some(detail.into()) }
    }
    fn ready() -> Self {
        Self { status: "ready".into(), detail: None }
    }
    fn unresponsive(detail: impl Into<String>) -> Self {
        Self { status: "unresponsive".into(), detail: Some(detail.into()) }
    }
}

/// Check container health.
/// Returns Ok(None) if there is nothing to check (no URL, not CLI).
#[tauri::command]
pub async fn check_health(
    state: State<'_, AppState>,
    container_id: Option<String>,
    health_check_url: Option<String>,
    cli_tool: bool,
) -> Result<Option<HealthResult>, String> {
    if cli_tool {
        let id = match container_id {
            Some(id) => id,
            None => return Ok(None),
        };
        let cli = state.container.lock().await.runtime.cli().to_string();
        let result = Command::new(&cli)
            .args(["exec", &id, "true"])
            .output()
            .await;
        return Ok(Some(match result {
            Ok(out) if out.status.success() => HealthResult::ready(),
            Ok(out) => {
                let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                HealthResult::unresponsive(if msg.is_empty() { "exec failed".to_string() } else { msg })
            }
            Err(e) => HealthResult::unresponsive(e.to_string()),
        }));
    }

    let url = match health_check_url {
        Some(u) => u,
        None => return Ok(None),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(Some(match client.head(&url).send().await {
        Ok(resp) => HealthResult::healthy(format!("HTTP {}", resp.status().as_u16())),
        Err(e) if e.is_timeout()  => HealthResult::unhealthy("timeout"),
        Err(e) if e.is_connect()  => HealthResult::unhealthy("connection refused"),
        Err(_)                    => HealthResult::unhealthy("unreachable"),
    }))
}
