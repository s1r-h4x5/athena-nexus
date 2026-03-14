pub mod commands;

use serde::{Deserialize, Deserializer, Serialize};

// ── Port deserializer ─────────────────────────────────────── //
fn deserialize_opt_ports<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum PortSpec { Int(u16), Str(String) }

    let opt: Option<Vec<PortSpec>> = Option::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default().into_iter().map(|p| match p {
        PortSpec::Int(n)  => format!("{n}:{n}"),
        PortSpec::Str(s)  => {
            let s = s.trim().to_string();
            if s.contains(':') { s } else { format!("{s}:{s}") }
        }
    }).collect())
}

// ── Source — how the tool is deployed ────────────────────── //
/// Exactly one of (image) or (compose_url / compose_file / compose_repo) should be set.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ToolSource {
    /// Container image name, e.g. "projectdiscovery/nuclei"
    pub image:    Option<String>,
    /// Registry prefix, e.g. "docker.io", "ghcr.io". Defaults to "docker.io".
    #[serde(default)]
    pub registry: Option<String>,
    /// Image tag / version. Defaults to "latest".
    #[serde(default)]
    pub version:  Option<String>,

    /// Remote compose file URL (single file, no sibling assets needed)
    pub compose_url:  Option<String>,
    /// Local compose file path (absolute)
    pub compose_file: Option<String>,
    /// GitHub/GitLab repo URL for compose stacks with sibling config files
    pub compose_repo: Option<String>,
    /// Tag/branch to download. Defaults to "main".
    #[serde(default)]
    pub compose_repo_tag: Option<String>,
    /// Subdirectory inside the repo that contains docker-compose.yml
    #[serde(default)]
    pub compose_subdir: Option<String>,

    /// Rewrite hardcoded ports in the compose file before deploying.
    /// Maps original host port → new host port.
    #[serde(default)]
    pub port_overrides: std::collections::HashMap<String, String>,

    /// Steps to run before the main compose up.
    #[serde(default)]
    pub pre_deploy: Vec<PreDeployStep>,
}

// ── Access — how to reach the running tool ───────────────── //
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ToolAccess {
    /// Web UI entrypoint, e.g. "https://localhost:{port}"
    #[serde(default)]
    pub entrypoint:   Option<String>,
    /// URL used by the health-check poller
    #[serde(default)]
    pub health_check: Option<String>,
    /// Host:container port mappings
    #[serde(default, deserialize_with = "deserialize_opt_ports")]
    pub ports:        Vec<String>,
}

// ── Top-level tool definition ─────────────────────────────── //
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolDefinition {
    pub id:          String,
    pub name:        String,
    pub category:    String,
    pub description: String,

    /// Deployment source (image or compose)
    pub source: ToolSource,

    /// Access details (ports, entrypoint, health check)
    #[serde(default)]
    pub access: ToolAccess,

    pub icon:      Option<String>,
    #[serde(default)]
    pub tags:      Vec<String>,
    #[serde(default)]
    pub cli_tool:  bool,

    /// Plain env vars — legacy, kept for user-defined tools backward compat.
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,

    /// Interactive env vars shown in Deploy Modal before deploying.
    #[serde(default)]
    pub env_vars: Vec<EnvVarDef>,
}

// ── Pre-deploy step ───────────────────────────────────────── //
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PreDeployStep {
    Compose {
        file: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Shell { cmd: String },
}

// ── Env var definition ────────────────────────────────────── //
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EnvVarDef {
    pub key:   String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub default:  String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub secret:   bool,
    #[serde(default)]
    pub auto_uuid: bool,
}

// ── Registry wrapper ──────────────────────────────────────── //
#[derive(Debug, Serialize, Deserialize)]
pub struct Registry {
    pub version: String,
    pub tools:   Vec<ToolDefinition>,
}
