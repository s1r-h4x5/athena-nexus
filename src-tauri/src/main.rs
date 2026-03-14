#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod container;
mod config;
mod registry;
mod deploy;
mod vault;
mod snapshot;
mod audit;
mod health;

use container::ContainerClient;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

pub struct AppState {
    pub container: Arc<Mutex<ContainerClient>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            registry::commands::seed_registry_if_missing();

            let mut client = ContainerClient::new();

            if let Ok(cfg) = config::commands::load_config() {
                client.apply_config(
                    &cfg.container_runtime,
                    cfg.podman_socket.as_deref(),
                    cfg.docker_socket.as_deref(),
                );
            }

            if !std::path::Path::new(&client.socket_path).exists() {
                log::warn!(
                    "{} socket not found at {}",
                    client.runtime.as_str(),
                    client.socket_path
                );
            } else {
                log::info!("{} socket found at {}", client.runtime.as_str(), client.socket_path);
            }

            app.manage(AppState {
                container: Arc::new(Mutex::new(client)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            container::commands::check_connection,
            container::commands::get_runtime_info,
            container::commands::list_containers,
            container::commands::start_container,
            container::commands::stop_container,
            container::commands::restart_container,
            container::commands::remove_container,
            container::commands::get_container_stats,
            container::commands::get_container_logs,
            container::commands::exec_container,
            container::commands::pull_image,
            container::commands::list_images,
            container::commands::remove_image,
            container::commands::list_networks,
            container::commands::inspect_network,
            container::commands::create_network,
            container::commands::check_data_dir_writable,
            container::commands::get_disk_free_mb,
            container::commands::check_tool_available,
            config::commands::load_config,
            config::commands::save_config,
            config::commands::detect_runtimes,
            config::commands::config_export,
            config::commands::config_import_preview,
            config::commands::config_import_apply,
            config::commands::config_default_export_dir,
            config::user_tools::user_tools_list,
            config::user_tools::user_tools_create,
            config::user_tools::user_tools_update,
            config::user_tools::user_tools_delete,
            config::user_tools::user_tools_export_yaml,
            registry::commands::load_registry,
            registry::commands::registry_file_path,
            registry::commands::set_registry_path,
            deploy::commands::deploy_tool,
            deploy::commands::undeploy_tool,
            deploy::commands::stop_compose_tool,
            deploy::commands::pull_image_streaming,
            deploy::cancel::cancel_deploy,
            health::commands::check_health,
            deploy::commands::check_port_in_use,
            vault::commands::vault_list,
            vault::commands::vault_create,
            vault::commands::vault_update,
            vault::commands::vault_delete,
            vault::commands::vault_get_value,
            vault::commands::vault_get_env_vars,
            snapshot::commands::snapshot_list,
            snapshot::commands::snapshot_create,
            snapshot::commands::snapshot_export,
            snapshot::commands::snapshot_restore,
            snapshot::commands::snapshot_delete,
            snapshot::commands::snapshot_update_note,
            audit::commands::audit_append,
            audit::commands::audit_list,
            audit::commands::audit_verify,
            audit::commands::audit_export_path,
            audit::commands::audit_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Athena Nexus");
}

fn main() {
    run();
}
