// ═══════════════════════════════════════════════════════════
// config/user_tools.rs — CRUD for user-defined tools
//
// User tools live in config.tool_definitions (config.json).
// Each is a UserToolConfig with user_defined: true.
// They are merged into the registry at runtime so they
// appear on the Dashboard alongside built-in tools.
// ═══════════════════════════════════════════════════════════

use super::commands::{load_config, write_config_to_disk};
use super::UserToolConfig;
use crate::audit;

// ── List all user-defined tools ───────────────────────────── //
#[tauri::command]
pub fn user_tools_list() -> Result<Vec<UserToolConfig>, String> {
    let config = load_config()?;
    Ok(config.tool_definitions.into_iter().filter(|t| t.user_defined).collect())
}

// ── Create a new user-defined tool ───────────────────────── //
#[tauri::command]
pub fn user_tools_create(
    id:          String,
    name:        String,
    category:    String,
    categories:  Option<Vec<String>>,
    description: String,
    registry:    Option<String>,
    image:       Option<String>,
    version:     Option<String>,
    compose_file:Option<String>,
    entrypoint:  Option<String>,
    ports:       Vec<String>,
    secret_refs: Vec<String>,
    env_vars:    Option<Vec<crate::registry::EnvVarDef>>,
    compose_repo:     Option<String>,
    compose_repo_tag: Option<String>,
    compose_subdir:   Option<String>,
    pre_deploy:       Option<Vec<serde_json::Value>>,
    cli_tool:    Option<bool>,
) -> Result<UserToolConfig, String> {
    let mut config = load_config()?;

    if config.tool_definitions.iter().any(|t| t.id == id) {
        return Err(format!("Tool with id '{}' already exists.", id));
    }

    // Normalise categories: use provided array, fall back to [category]
    let cats = categories.unwrap_or_else(|| vec![category.clone()]);

    let tool = UserToolConfig {
        id: id.clone(),
        name: name.clone(),
        category: cats.first().cloned().unwrap_or_else(|| "utilities".to_string()),
        categories: cats,
        description,
        registry:     registry.unwrap_or_else(|| "docker.io".to_string()),
        image,
        version:      version.unwrap_or_else(|| "latest".to_string()),
        compose_file,
        entrypoint,
        ports,
        secret_refs,
        env_vars: env_vars.unwrap_or_default(),
        env: std::collections::HashMap::new(),
        compose_repo,
        compose_repo_tag,
        compose_subdir,
        pre_deploy: pre_deploy.unwrap_or_default()
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect(),
        cli_tool:     cli_tool.unwrap_or(false),
        user_defined: true,
    };

    config.tool_definitions.push(tool.clone());
    write_config_to_disk(&config)?;

    let _ = audit::commands::audit_append(
        "config".into(), "create_tool".into(),
        id, name, "success".into(), "User-defined tool created".into(),
    );

    Ok(tool)
}

// ── Update an existing user-defined tool ─────────────────── //
#[tauri::command]
pub fn user_tools_update(
    id:          String,
    name:        Option<String>,
    category:    Option<String>,
    categories:  Option<Vec<String>>,
    description: Option<String>,
    registry:    Option<String>,
    image:       Option<String>,
    version:     Option<String>,
    compose_file:Option<String>,
    entrypoint:  Option<String>,
    ports:       Option<Vec<String>>,
    secret_refs: Option<Vec<String>>,
    env_vars:    Option<Vec<crate::registry::EnvVarDef>>,
    compose_repo:     Option<String>,
    compose_repo_tag: Option<String>,
    compose_subdir:   Option<String>,
    pre_deploy:       Option<Vec<serde_json::Value>>,
    cli_tool:    Option<bool>,
) -> Result<UserToolConfig, String> {
    let mut config = load_config()?;

    let tool = config.tool_definitions.iter_mut()
        .find(|t| t.id == id && t.user_defined)
        .ok_or_else(|| format!("User tool '{}' not found.", id))?;

    if let Some(v) = name        { tool.name        = v; }
    if let Some(v) = description { tool.description = v; }
    if let Some(v) = registry    { tool.registry    = v; }
    if let Some(v) = image       { tool.image       = Some(v); }
    if let Some(v) = version     { tool.version     = v; }
    if let Some(v) = compose_file{ tool.compose_file = Some(v); }
    if let Some(v) = entrypoint  { tool.entrypoint  = Some(v); }
    if let Some(v) = ports       { tool.ports       = v; }
    if let Some(v) = secret_refs { tool.secret_refs = v; }
    if let Some(v) = env_vars    { tool.env_vars    = v; }
    if let Some(v) = compose_repo     { tool.compose_repo     = Some(v); }
    if let Some(v) = compose_repo_tag { tool.compose_repo_tag = Some(v); }
    if let Some(v) = compose_subdir   { tool.compose_subdir   = Some(v); }
    if let Some(steps) = pre_deploy {
        tool.pre_deploy = steps.into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect();
    }
    if let Some(v) = cli_tool    { tool.cli_tool    = v; }

    // Update categories array — always prefer the array over the scalar
    if let Some(cats) = categories {
        tool.categories = cats.clone();
        tool.category   = cats.into_iter().next().unwrap_or_else(|| "utilities".to_string());
    } else if let Some(v) = category {
        // Fallback: scalar only — keep categories in sync
        tool.category   = v.clone();
        if tool.categories.is_empty() {
            tool.categories = vec![v];
        } else {
            tool.categories[0] = v;
        }
    }

    let updated = tool.clone();
    write_config_to_disk(&config)?;

    let _ = audit::commands::audit_append(
        "config".into(), "update_tool".into(),
        id.clone(), updated.name.clone(), "success".into(), "User-defined tool updated".into(),
    );

    Ok(updated)
}

// ── Delete a user-defined tool ────────────────────────────── //
#[tauri::command]
pub fn user_tools_delete(id: String) -> Result<(), String> {
    let mut config = load_config()?;
    let before = config.tool_definitions.len();
    config.tool_definitions.retain(|t| !(t.id == id && t.user_defined));

    if config.tool_definitions.len() == before {
        return Err(format!("User tool '{}' not found.", id));
    }

    write_config_to_disk(&config)?;

    let _ = audit::commands::audit_append(
        "config".into(), "delete_tool".into(),
        id, String::new(), "success".into(), "User-defined tool deleted".into(),
    );

    Ok(())
}

// ── Export user tools as a YAML snippet (for sharing) ─────── //
#[tauri::command]
pub fn user_tools_export_yaml(ids: Vec<String>) -> Result<String, String> {
    let config = load_config()?;
    let tools: Vec<&UserToolConfig> = config.tool_definitions
        .iter()
        .filter(|t| t.user_defined && (ids.is_empty() || ids.contains(&t.id)))
        .collect();

    // Serialize as JSON (valid YAML subset)
    serde_json::to_string_pretty(&tools).map_err(|e| e.to_string())
}
