pub mod commands;

use serde::{Deserialize, Serialize};

// ── API version strings ───────────────────────────────────── //

/// Podman REST API v5 — libpod path prefix
pub const LIBPOD_API: &str = "v5.0.0";
/// Docker Engine API
pub const DOCKER_API: &str = "v1.53";

// ── Runtime enum ─────────────────────────────────────────── //

#[derive(Debug, Clone, PartialEq)]
pub enum ContainerRuntime {
    Podman,
    Docker,
}

impl ContainerRuntime {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "docker" => ContainerRuntime::Docker,
            _        => ContainerRuntime::Podman,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ContainerRuntime::Podman => "podman",
            ContainerRuntime::Docker => "docker",
        }
    }

    /// CLI binary for single-container operations
    pub fn cli(&self) -> &'static str {
        match self {
            ContainerRuntime::Podman => "podman",
            ContainerRuntime::Docker => "docker",
        }
    }

    /// Returns (program, leading_args) for compose commands.
    /// podman-compose: ("podman-compose", [])
    /// docker compose: ("docker",         ["compose"])
    pub fn compose_cmd(&self) -> (&'static str, Vec<&'static str>) {
        match self {
            ContainerRuntime::Podman => ("podman-compose", vec![]),
            ContainerRuntime::Docker => ("docker",         vec!["compose"]),
        }
    }

    /// Build a versioned API path for the active runtime.
    ///
    /// Podman v5 uses:    /v5.0.0/libpod/<libpod_suffix>
    /// Docker v1.53 uses: /v1.53/<docker_suffix>
    ///
    /// Example:
    ///   runtime.api_path("/libpod/containers/json", "/containers/json")
    ///   → Podman: "/v5.0.0/libpod/containers/json"
    ///   → Docker: "/v1.53/containers/json"
    pub fn api_path(&self, libpod_suffix: &str, docker_suffix: &str) -> String {
        match self {
            ContainerRuntime::Podman => format!("/{}{}", LIBPOD_API, libpod_suffix),
            ContainerRuntime::Docker => format!("/{}{}", DOCKER_API, docker_suffix),
        }
    }
}

// ── Client ───────────────────────────────────────────────── //

pub struct ContainerClient {
    pub socket_path: String,
    pub runtime: ContainerRuntime,
}

impl ContainerClient {
    pub fn new() -> Self {
        Self {
            socket_path: detect_podman_socket(),
            runtime: ContainerRuntime::Podman,
        }
    }

    /// Re-initialise using the persisted config (called after save_config).
    pub fn apply_config(&mut self, runtime: &str, podman_socket: Option<&str>, docker_socket: Option<&str>) {
        self.runtime = ContainerRuntime::from_str(runtime);
        self.socket_path = match self.runtime {
            ContainerRuntime::Docker => {
                docker_socket
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(detect_docker_socket)
            }
            ContainerRuntime::Podman => {
                podman_socket
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(detect_podman_socket)
            }
        };
    }

    pub fn refresh_socket(&mut self) {
        self.socket_path = match self.runtime {
            ContainerRuntime::Docker => detect_docker_socket(),
            ContainerRuntime::Podman => detect_podman_socket(),
        };
    }

    pub fn is_connected(&self) -> bool {
        std::path::Path::new(&self.socket_path).exists()
    }
}

// ── Socket detection ─────────────────────────────────────── //

fn detect_podman_socket() -> String {
    let uid = unsafe { libc::getuid() };
    let candidates = vec![
        std::env::var("XDG_RUNTIME_DIR")
            .map(|d| format!("{}/podman/podman.sock", d))
            .unwrap_or_default(),
        format!("/run/user/{}/podman/podman.sock", uid),
        "/run/podman/podman.sock".to_string(),
        format!("/tmp/podman-run-{}/podman/podman.sock", uid),
    ];
    for path in &candidates {
        if !path.is_empty() && std::path::Path::new(path).exists() {
            return path.clone();
        }
    }
    candidates[1].clone()
}

fn detect_docker_socket() -> String {
    let uid = unsafe { libc::getuid() };
    let candidates = vec![
        std::env::var("XDG_RUNTIME_DIR")
            .map(|d| format!("{}/docker.sock", d))
            .unwrap_or_default(),
        format!("/run/user/{}/docker.sock", uid),
        "/var/run/docker.sock".to_string(),
        "/run/docker.sock".to_string(),
    ];
    for path in &candidates {
        if !path.is_empty() && std::path::Path::new(path).exists() {
            return path.clone();
        }
    }
    "/var/run/docker.sock".to_string()
}

// ── Runtime detection (exposed to frontend) ──────────────── //

#[derive(Debug, Serialize, Clone)]
pub struct RuntimeInfo {
    pub runtime:        String,
    pub socket_path:    String,
    pub available:      bool,
    pub default_socket: String,
}

/// Try to open a Unix socket connection and send a minimal HTTP request.
/// Returns true only if the daemon actually responds (not just the file existing).
/// Uses a 1-second timeout so the Settings page poll stays snappy.
fn probe_socket(path: &str) -> bool {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    if !std::path::Path::new(path).exists() {
        return false;
    }

    let mut stream = match UnixStream::connect(path) {
        Ok(s)  => s,
        Err(_) => return false,
    };

    if stream.set_read_timeout(Some(std::time::Duration::from_secs(1))).is_err() {
        return false;
    }

    // Lightest possible request — works on both Podman and Docker
    let req = "GET /_ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }

    let mut buf = [0u8; 64];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            // Accept any HTTP response — even 404 means the daemon is alive
            buf[..n].starts_with(b"HTTP/")
        }
        _ => false,
    }
}

pub fn detect_available_runtimes() -> Vec<RuntimeInfo> {
    let podman_sock = detect_podman_socket();
    let docker_sock = detect_docker_socket();
    vec![
        RuntimeInfo {
            runtime:        "podman".to_string(),
            socket_path:    podman_sock.clone(),
            available:      probe_socket(&podman_sock),
            default_socket: podman_sock,
        },
        RuntimeInfo {
            runtime:        "docker".to_string(),
            socket_path:    docker_sock.clone(),
            available:      probe_socket(&docker_sock),
            default_socket: docker_sock,
        },
    ]
}

// ── Shared types ─────────────────────────────────────────── //

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl CommandResult {
    pub fn ok(msg: impl Into<String>) -> Self {
        Self { success: true, message: msg.into(), data: None }
    }
    pub fn ok_with_data(msg: impl Into<String>, data: serde_json::Value) -> Self {
        Self { success: true, message: msg.into(), data: Some(data) }
    }
    pub fn err(msg: impl Into<String>) -> Self {
        Self { success: false, message: msg.into(), data: None }
    }
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerSummary {
    #[serde(rename = "Id")]     pub id: String,
    #[serde(rename = "Names")]  pub names: Vec<String>,
    #[serde(rename = "Image")]  pub image: String,
    #[serde(rename = "State")]  pub state: String,
    #[serde(rename = "Status")] pub status: String,
}
