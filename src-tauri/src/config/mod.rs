// ═══════════════════════════════════════════════════════════
// config/mod.rs — Application configuration persistence
// Stored at ~/.config/athena-nexus/config.json
// ═══════════════════════════════════════════════════════════

pub mod commands;
pub mod user_tools;

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

fn deserialize_ports<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    struct PortVecVisitor;
    impl<'de> serde::de::Visitor<'de> for PortVecVisitor {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(f, "array of port specs (integers or strings)")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut ports = Vec::new();
            while let Some(val) = seq.next_element::<serde_json::Value>()? {
                let s = match val {
                    serde_json::Value::Number(n) => format!("{n}:{n}"),
                    serde_json::Value::String(s) => if s.contains(':') { s } else { format!("{s}:{s}") },
                    other => return Err(serde::de::Error::custom(format!("unexpected port value: {other}"))),
                };
                ports.push(s);
            }
            Ok(ports)
        }
    }
    d.deserialize_seq(PortVecVisitor)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub version: String,
    pub podman_socket: Option<String>,
    /// Docker socket path override. Defaults to /var/run/docker.sock
    #[serde(default)]
    pub docker_socket: Option<String>,
    /// "podman" or "docker". Defaults to "podman".
    #[serde(default = "default_runtime")]
    pub container_runtime: String,
    /// Optional override for the tools.json registry path.
    /// When None, defaults to ~/.config/athena-nexus/tools.json
    #[serde(default)]
    pub registry_path: Option<String>,
    pub categories: Vec<CategoryConfig>,
    pub tool_definitions: Vec<UserToolConfig>,
    pub network_assignments: HashMap<String, Vec<String>>,
    pub settings: Settings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CategoryConfig {
    pub id: String,
    pub label: String,
    pub icon: String,
    pub order: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserToolConfig {
    pub id: String,
    pub name: String,
    pub category: String,
    #[serde(default)]
    pub categories: Vec<String>,
    pub description: String,
    /// Container registry hostname, e.g. "docker.io". Defaults to "docker.io".
    #[serde(default = "default_registry")]
    pub registry: String,
    /// Image name without registry or tag, e.g. "mitmproxy/mitmproxy"
    pub image: Option<String>,
    /// Image tag, e.g. "latest", "v2.1.0". Defaults to "latest".
    #[serde(default = "default_version")]
    pub version: String,
    pub compose_file: Option<String>,
    pub entrypoint: Option<String>,
    #[serde(deserialize_with = "deserialize_ports", default)]
    pub ports: Vec<String>,
    pub secret_refs: Vec<String>,  // references to vault secrets by name
    /// Interactive env vars shown in Deploy Modal — unified with registry tools.
    #[serde(default)]
    pub env_vars: Vec<crate::registry::EnvVarDef>,
    /// Legacy flat env dict — kept for backward compat, not used for new tools.
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// Git repository URL for tools that need a full repo (not just a single compose file).
    #[serde(default)]
    pub compose_repo: Option<String>,
    #[serde(default)]
    pub compose_repo_tag: Option<String>,
    #[serde(default)]
    pub compose_subdir: Option<String>,
    #[serde(default)]
    pub pre_deploy: Vec<crate::registry::PreDeployStep>,
    #[serde(default)]
    pub cli_tool: bool,
    pub user_defined: bool,
}

fn default_registry() -> String { "docker.io".to_string() }
fn default_version()  -> String { "latest".to_string() }
fn default_runtime()  -> String { "podman".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    pub theme: String,
    pub poll_interval_secs: u64,
    pub log_tail_lines: u32,
    pub notifications_enabled: bool,
    pub auto_update_check: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            podman_socket: None,
            docker_socket: None,
            container_runtime: "podman".to_string(),
            registry_path: None,
            categories: vec![],
            tool_definitions: vec![],
            network_assignments: HashMap::new(),
            settings: Settings {
                theme: "dark".to_string(),
                poll_interval_secs: 5,
                log_tail_lines: 200,
                notifications_enabled: true,
                auto_update_check: false,
            },
        }
    }
}

pub fn config_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    home.join(".config").join("athena-nexus").join("config.json")
}
