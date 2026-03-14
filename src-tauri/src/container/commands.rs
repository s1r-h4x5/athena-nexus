#![allow(dead_code, unused_imports)]

use super::{CommandResult, ContainerRuntime};
use crate::AppState;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use tauri::State;

// ── HTTP transport ────────────────────────────────────────── //

/// Raw HTTP/1.1 over Unix socket — blocking, must be called via spawn_blocking.
///
/// Retries up to MAX_RETRIES times with a short delay between attempts.
/// This handles the systemd socket-activation window where the socket file
/// exists but the daemon hasn't finished starting yet.
const MAX_RETRIES: u32 = 8;
const RETRY_DELAY_MS: u64 = 500;

fn unix_http(socket: &str, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let mut last_err = String::new();

    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
        }

        match unix_http_once(socket, method, path, body) {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                if e.contains("0 bytes")
                    || e.contains("No HTTP header")
                    || e.contains("Connection refused")
                    || e.contains("os error 111")
                {
                    last_err = e;
                    continue;
                }
                return Err(e);
            }
        }
    }

    Err(format!("Runtime did not respond after {} attempts: {}", MAX_RETRIES, last_err))
}

fn unix_http_once(socket: &str, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let mut stream = UnixStream::connect(socket)
        .map_err(|e| format!("Cannot connect to socket {}: {}", socket, e))?;

    // Use a longer timeout for mutating operations (stop/restart/start can take 30s+
    // for heavy containers). GET requests keep the snappy 3s timeout.
    let timeout_secs = if method == "GET" { 3u64 } else { 60u64 };
    stream.set_read_timeout(Some(std::time::Duration::from_secs(timeout_secs)))
        .map_err(|e| format!("Failed to set timeout: {}", e))?;

    let body_str = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {len}\r\n\r\n{body_str}",
        method   = method,
        path     = path,
        len      = body_str.len(),
        body_str = body_str,
    );

    stream.write_all(request.as_bytes())
        .map_err(|e| format!("Failed to write request: {}", e))?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)
        .map_err(|e| format!("Failed to read response: {}", e))?;

    if raw.is_empty() {
        return Err("No HTTP header separator found. Raw response (0 bytes): daemon not ready yet".to_string());
    }

    let split = raw.windows(4).position(|w| w == b"\r\n\r\n");
    let (header_bytes, body_bytes) = match split {
        Some(pos) => (&raw[..pos], &raw[pos + 4..]),
        None => return Err(format!(
            "No HTTP header separator found. Raw response ({} bytes): {}",
            raw.len(),
            String::from_utf8_lossy(&raw[..raw.len().min(200)])
        )),
    };

    let headers = String::from_utf8_lossy(header_bytes);

    let status: u16 = headers
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let is_chunked = headers.to_lowercase().contains("transfer-encoding: chunked");
    let body_out = if is_chunked {
        decode_chunked(body_bytes)
    } else {
        String::from_utf8_lossy(body_bytes).to_string()
    };

    if status >= 400 {
        return Err(format!("HTTP {}: {}", status, body_out.trim()));
    }

    Ok(body_out)
}

fn decode_chunked(data: &[u8]) -> String {
    let mut result = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        if let Some(nl) = data[pos..].windows(2).position(|w| w == b"\r\n") {
            let size_line = String::from_utf8_lossy(&data[pos..pos + nl]);
            let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("0"), 16)
                .unwrap_or(0);
            if size == 0 { break; }
            pos += nl + 2;
            let end = (pos + size).min(data.len());
            result.extend_from_slice(&data[pos..end]);
            pos = end + 2;
        } else {
            break;
        }
    }
    String::from_utf8_lossy(&result).to_string()
}

/// Run a blocking unix_http call safely from async context.
async fn run(socket: String, method: &'static str, path: String, body: Option<String>) -> Result<Value, String> {
    let result = tokio::task::spawn_blocking(move || {
        unix_http(&socket, method, &path, body.as_deref())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    if result.trim().is_empty() { return Ok(Value::Null); }
    serde_json::from_str(&result)
        .map_err(|e| format!("JSON error: {} | body: {}", e, &result[..result.len().min(400)]))
}

async fn get(socket: &str, path: &str) -> Result<Value, String> {
    run(socket.to_string(), "GET", path.to_string(), None).await
}

async fn post(socket: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    run(socket.to_string(), "POST", path.to_string(), body.map(|v| v.to_string())).await
}

async fn del(socket: &str, path: &str) -> Result<Value, String> {
    run(socket.to_string(), "DELETE", path.to_string(), None).await
}

// ── Connection / ping ─────────────────────────────────────── //

/// Ping Podman v5 via GET /v5.0.0/libpod/info.
/// Single attempt — callers handle retry timing.
fn ping_podman(socket: &str) -> Result<serde_json::Value, String> {
    let path = format!("/{}/libpod/info", super::LIBPOD_API);
    let raw  = unix_http_once(socket, "GET", &path, None)?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("JSON parse error: {}", e))
}

/// Ping Docker Engine via GET /_ping, then GET /v1.53/info for version data.
/// Single attempt — callers handle retry timing.
///
/// Returns a normalised shape the frontend already understands:
///   { version: { Version }, host: { remoteSocket: { path }, os, arch } }
fn ping_docker(socket: &str) -> Result<serde_json::Value, String> {
    // /_ping is the lightest health check — available since Docker 1.13, no auth required.
    unix_http(socket, "GET", "/_ping", None)?;

    let info_path    = format!("/{}/info",    super::DOCKER_API);
    let version_path = format!("/{}/version", super::DOCKER_API);

    let raw_info = unix_http(socket, "GET", &info_path, None)?;
    let info: serde_json::Value = serde_json::from_str(&raw_info)
        .map_err(|e| format!("JSON parse error: {}", e))?;

    // /version gives us ApiVersion alongside the engine version
    let raw_ver = unix_http(socket, "GET", &version_path, None).unwrap_or_default();
    let ver: serde_json::Value = serde_json::from_str(&raw_ver).unwrap_or(Value::Null);

    let engine_version = info.get("ServerVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let api_version = ver.get("ApiVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(serde_json::json!({
        "version": {
            "Version":    engine_version,
            "ApiVersion": api_version,
        },
        "host": {
            "remoteSocket": { "path": socket },
            "os":   info.get("OperatingSystem").cloned().unwrap_or(Value::Null),
            "arch": info.get("Architecture").cloned().unwrap_or(Value::Null),
        }
    }))
}

/// Resolve candidate Podman socket paths (rootless → rootful).
fn resolve_podman_sockets() -> Vec<String> {
    let uid = unsafe { libc::getuid() };
    let mut candidates = Vec::new();

    if let Ok(host) = std::env::var("DOCKER_HOST") {
        let path = host.trim_start_matches("unix://").trim_start_matches("unix:").to_string();
        if !path.is_empty() { return vec![path]; }
    }

    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        candidates.push(format!("{}/podman/podman.sock", xdg));
    }
    candidates.push(format!("/run/user/{}/podman/podman.sock", uid));
    candidates.push("/run/podman/podman.sock".to_string());
    candidates
}

/// Resolve candidate Docker socket paths.
fn resolve_docker_sockets() -> Vec<String> {
    let uid = unsafe { libc::getuid() };
    let mut candidates = Vec::new();

    if let Ok(host) = std::env::var("DOCKER_HOST") {
        let path = host.trim_start_matches("unix://").trim_start_matches("unix:").to_string();
        if !path.is_empty() { return vec![path]; }
    }

    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        candidates.push(format!("{}/docker.sock", xdg));
    }
    candidates.push(format!("/run/user/{}/docker.sock", uid));
    candidates.push("/var/run/docker.sock".to_string());
    candidates.push("/run/docker.sock".to_string());
    candidates
}

/// Check connectivity to the configured runtime.
/// - Podman: probes Podman v5 socket candidates with GET /v5.0.0/libpod/info
/// - Docker: probes Docker socket candidates with GET /_ping + GET /v1.53/info
#[tauri::command]
pub async fn check_connection(state: State<'_, AppState>) -> Result<CommandResult, String> {
    let (runtime, configured_socket) = {
        let client = state.container.lock().await;
        (client.runtime.clone(), client.socket_path.clone())
    };

    // Build candidate list: always try the currently-configured socket first,
    // then fall back to auto-detected candidates. De-duplicate in case the
    // configured path is already in the candidate list.
    let mut candidates = vec![configured_socket.clone()];
    let detected = match runtime {
        ContainerRuntime::Podman => resolve_podman_sockets(),
        ContainerRuntime::Docker => resolve_docker_sockets(),
    };
    for s in detected {
        if s != configured_socket {
            candidates.push(s);
        }
    }

    let mut last_err = String::new();

    for socket in &candidates {
        if !std::path::Path::new(socket).exists() {
            continue;
        }

        let socket_clone  = socket.clone();
        let runtime_clone = runtime.clone();

        let result = tokio::task::spawn_blocking(move || {
            match runtime_clone {
                ContainerRuntime::Podman => ping_podman(&socket_clone),
                ContainerRuntime::Docker => ping_docker(&socket_clone),
            }
        }).await;

        match result {
            Ok(Ok(info)) => {
                state.container.lock().await.socket_path = socket.clone();
                return Ok(CommandResult::ok_with_data("Connected", info));
            }
            Ok(Err(e)) => { last_err = e; }
            Err(e)     => { last_err = e.to_string(); }
        }
    }

    state.container.lock().await.refresh_socket();

    let hint = if last_err.to_lowercase().contains("permission denied")
                || last_err.to_lowercase().contains("eacces")
    {
        match runtime {
            ContainerRuntime::Podman =>
                "Permission denied on Podman socket. Try: sudo chmod 660 /run/podman/podman.sock".to_string(),
            ContainerRuntime::Docker =>
                "Permission denied on Docker socket. Add your user to the docker group: sudo usermod -aG docker $USER".to_string(),
        }
    } else {
        match runtime {
            ContainerRuntime::Podman =>
                "Podman socket not reachable. Run: systemctl --user enable --now podman.socket".to_string(),
            ContainerRuntime::Docker =>
                "Docker socket not reachable. Ensure Docker Engine is running: sudo systemctl start docker".to_string(),
        }
    };

    Ok(CommandResult::err(hint))
}

#[tauri::command]
pub async fn get_runtime_info(state: State<'_, AppState>) -> Result<Value, String> {
    let (socket, runtime) = {
        let client = state.container.lock().await;
        (client.socket_path.clone(), client.runtime.clone())
    };
    match runtime {
        crate::container::ContainerRuntime::Docker => {
            let info_path    = format!("/{}/info",    super::DOCKER_API);
            let version_path = format!("/{}/version", super::DOCKER_API);

            let (info_res, ver_res) = tokio::join!(
                get(&socket, &info_path),
                get(&socket, &version_path),
            );

            let mut merged: serde_json::Map<String, Value> = match info_res {
                Ok(Value::Object(m)) => m,
                _ => serde_json::Map::new(),
            };
            if let Ok(Value::Object(ver)) = ver_res {
                for (k, v) in ver {
                    merged.entry(k).or_insert(v);
                }
            }
            Ok(Value::Object(merged))
        }
        crate::container::ContainerRuntime::Podman => {
            get(&socket, "/libpod/info").await
        }
    }
}

// ── Container commands ────────────────────────────────────── //

#[tauri::command]
pub async fn list_containers(state: State<'_, AppState>, all: Option<bool>) -> Result<Vec<Value>, String> {
    let (socket_path, path) = {
        let client  = state.container.lock().await;
        let all_val = all.unwrap_or(true);
        // Podman: /libpod/containers/json?all=true  → native libpod response shape
        // Docker: /containers/json?all=1            → Moby shape (same fields we use)
        let path = client.runtime.api_path(
            &format!("/libpod/containers/json?all={}", all_val),
            &format!("/containers/json?all={}", if all_val { 1 } else { 0 }),
        );
        (client.socket_path.clone(), path)
    }; // lock released here — HTTP call runs without holding it
    match get(&socket_path, &path).await {
        Ok(Value::Array(arr)) => Ok(arr),
        Ok(_)  => Ok(vec![]),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn start_container(state: State<'_, AppState>, container_id: String) -> Result<CommandResult, String> {
    let (socket_path, path) = {
        let client = state.container.lock().await;
        let path = client.runtime.api_path(
            &format!("/libpod/containers/{}/start", container_id),
            &format!("/containers/{}/start", container_id),
        );
        (client.socket_path.clone(), path)
    }; // lock released here — HTTP call runs without holding it
    match post(&socket_path, &path, None).await {
        Ok(_)  => Ok(CommandResult::ok(format!("Started {}", container_id))),
        Err(e) => Ok(CommandResult::err(e)),
    }
}

#[tauri::command]
pub async fn stop_container(state: State<'_, AppState>, container_id: String, timeout: Option<u32>) -> Result<CommandResult, String> {
    let (socket_path, path) = {
        let client = state.container.lock().await;
        let t = timeout.unwrap_or(10);
        let path = client.runtime.api_path(
            &format!("/libpod/containers/{}/stop?t={}", container_id, t),
            &format!("/containers/{}/stop?t={}", container_id, t),
        );
        (client.socket_path.clone(), path)
    }; // lock released here — HTTP call runs without holding it
    match post(&socket_path, &path, None).await {
        Ok(_)  => Ok(CommandResult::ok(format!("Stopped {}", container_id))),
        Err(e) => Ok(CommandResult::err(e)),
    }
}

#[tauri::command]
pub async fn restart_container(state: State<'_, AppState>, container_id: String) -> Result<CommandResult, String> {
    let (socket_path, path) = {
        let client = state.container.lock().await;
        let path = client.runtime.api_path(
            &format!("/libpod/containers/{}/restart", container_id),
            &format!("/containers/{}/restart", container_id),
        );
        (client.socket_path.clone(), path)
    }; // lock released here — HTTP call runs without holding it
    match post(&socket_path, &path, None).await {
        Ok(_)  => Ok(CommandResult::ok(format!("Restarted {}", container_id))),
        Err(e) => Ok(CommandResult::err(e)),
    }
}

#[tauri::command]
pub async fn remove_container(state: State<'_, AppState>, container_id: String, force: Option<bool>) -> Result<CommandResult, String> {
    let (socket_path, path) = {
        let client    = state.container.lock().await;
        let force_val = force.unwrap_or(false);
        let path      = client.runtime.api_path(
            &format!("/libpod/containers/{}?force={}", container_id, force_val),
            &format!("/containers/{}?force={}", container_id, force_val),
        );
        (client.socket_path.clone(), path)
    }; // lock released before HTTP call
    match del(&socket_path, &path).await {
        Ok(_)  => Ok(CommandResult::ok(format!("Removed {}", container_id))),
        Err(e) => Ok(CommandResult::err(e)),
    }
}

#[tauri::command]
pub async fn get_container_stats(state: State<'_, AppState>, container_id: String) -> Result<Value, String> {
    let (socket_path, path) = {
        let client = state.container.lock().await;
        let path = client.runtime.api_path(
            &format!("/libpod/containers/{}/stats?stream=false", container_id),
            &format!("/containers/{}/stats?stream=false", container_id),
        );
        (client.socket_path.clone(), path)
    };
    get(&socket_path, &path).await
}

#[tauri::command]
pub async fn get_container_logs(state: State<'_, AppState>, container_id: String, tail: Option<u32>, since: Option<i64>) -> Result<String, String> {
    let client    = state.container.lock().await;
    let tail_val  = tail.unwrap_or(100);
    let since_val = since.unwrap_or(0);
    let since_param = if since_val > 0 { format!("&since={}", since_val) } else { String::new() };
    let path = client.runtime.api_path(
        &format!("/libpod/containers/{}/logs?stdout=true&stderr=true&tail={}{}", container_id, tail_val, since_param),
        &format!("/containers/{}/logs?stdout=true&stderr=true&tail={}{}", container_id, tail_val, since_param),
    );
    let socket = client.socket_path.clone();
    drop(client); // release the lock before the blocking call

    let raw = tokio::task::spawn_blocking(move || unix_http(&socket, "GET", &path, None))
        .await
        .map_err(|e| e.to_string())??;

    // Both Podman and Docker return a multiplexed stream with an 8-byte frame header:
    //   [stream_type u8][0][0][0][size u32be][payload…]
    let bytes = raw.as_bytes();
    let mut output = String::new();
    let mut i = 0;
    while i + 8 <= bytes.len() {
        let size = u32::from_be_bytes([bytes[i+4], bytes[i+5], bytes[i+6], bytes[i+7]]) as usize;
        i += 8;
        if i + size <= bytes.len() {
            if let Ok(s) = std::str::from_utf8(&bytes[i..i+size]) { output.push_str(s); }
            i += size;
        } else { break; }
    }
    if output.is_empty() { output = raw; }
    Ok(output)
}

// ── Image commands ────────────────────────────────────────── //

#[tauri::command]
pub async fn pull_image(state: State<'_, AppState>, image: String) -> Result<CommandResult, String> {
    let client  = state.container.lock().await;
    let encoded = urlencoding::encode(&image).to_string();

    // Podman v5:    POST /v5.0.0/libpod/images/pull?reference=<image>
    // Docker v1.53: POST /v1.53/images/create?fromImage=<n>&tag=<tag>
    let path = match client.runtime {
        ContainerRuntime::Podman => {
            format!("/{}/libpod/images/pull?reference={}", super::LIBPOD_API, encoded)
        }
        ContainerRuntime::Docker => {
            let (from_image, tag) = split_image_tag(&image);
            let from_enc = urlencoding::encode(from_image).to_string();
            let tag_enc  = urlencoding::encode(tag).to_string();
            format!("/{}/images/create?fromImage={}&tag={}", super::DOCKER_API, from_enc, tag_enc)
        }
    };
    let socket = client.socket_path.clone();
    drop(client);

    let raw = tokio::task::spawn_blocking(move || {
        unix_http_once(&socket, "POST", &path, None)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(err_msg) = obj.get("error").and_then(|e| e.as_str()) {
                if !err_msg.trim().is_empty() {
                    return Ok(CommandResult::err(format!("Pull failed: {}", err_msg.trim())));
                }
            }
        }
    }

    Ok(CommandResult::ok(format!("Pulled {}", image)))
}

/// Split "registry/name:tag" into (name_without_tag, tag).
/// Handles registry ports like "localhost:5000/image" correctly.
fn split_image_tag(image: &str) -> (&str, &str) {
    if let Some(colon) = image.rfind(':') {
        let candidate_tag = &image[colon + 1..];
        if !candidate_tag.contains('/') {
            return (&image[..colon], candidate_tag);
        }
    }
    (image, "latest")
}

#[tauri::command]
pub async fn list_images(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let (socket_path, path) = {
        let client = state.container.lock().await;
        (client.socket_path.clone(), client.runtime.api_path("/libpod/images/json", "/images/json"))
    };
    match get(&socket_path, &path).await {
        Ok(Value::Array(arr)) => Ok(arr),
        Ok(_)  => Ok(vec![]),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn remove_image(state: State<'_, AppState>, reference: String) -> Result<CommandResult, String> {
    let (socket_path, path) = {
        let client  = state.container.lock().await;
        let encoded = urlencoding::encode(&reference).to_string();
        let path = client.runtime.api_path(
            &format!("/libpod/images/{}?force=true", encoded),
            &format!("/images/{}?force=true", encoded),
        );
        (client.socket_path.clone(), path)
    };
    match del(&socket_path, &path).await {
        Ok(_)  => Ok(CommandResult::ok(format!("Removed image {}", reference))),
        Err(e) => Ok(CommandResult::err(e)),
    }
}

// ── Network commands ──────────────────────────────────────── //

#[tauri::command]
pub async fn list_networks(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let (socket_path, path) = {
        let client = state.container.lock().await;
        // Podman v5:    /libpod/networks/json
        // Docker v1.53: /networks
        (client.socket_path.clone(), client.runtime.api_path("/libpod/networks/json", "/networks"))
    };
    match get(&socket_path, &path).await {
        Ok(Value::Array(arr)) => Ok(arr),
        Ok(_)  => Ok(vec![]),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn inspect_network(state: State<'_, AppState>, network_name: String) -> Result<Value, String> {
    let client = state.container.lock().await;
    let path = client.runtime.api_path(
        &format!("/libpod/networks/{}/json", network_name),
        &format!("/networks/{}", network_name),
    );
    match get(&client.socket_path, &path).await {
        Ok(v) => Ok(v),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn create_network(
    state: State<'_, AppState>,
    name: String,
    driver: Option<String>,
    internal: Option<bool>,
    dns_enabled: Option<bool>,
) -> Result<CommandResult, String> {
    let client = state.container.lock().await;

    let body = serde_json::json!({
        "Name":        name,
        "Driver":      driver.unwrap_or_else(|| "bridge".to_string()),
        "Internal":    internal.unwrap_or(false),
        "dns_enabled": dns_enabled.unwrap_or(true),
    });

    // Podman v5:    POST /libpod/networks/create
    // Docker v1.53: POST /networks/create
    let path = client.runtime.api_path("/libpod/networks/create", "/networks/create");
    match post(&client.socket_path, &path, Some(body)).await {
        Ok(r)  => Ok(CommandResult::ok_with_data(format!("Created {}", name), r)),
        Err(e) => Ok(CommandResult::err(e)),
    }
}

// ── System / health commands ──────────────────────────────── //

#[tauri::command]
pub fn check_data_dir_writable() -> Result<bool, String> {
    let data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("athena-nexus");

    if !data_dir.exists() {
        if std::fs::create_dir_all(&data_dir).is_err() {
            return Ok(false);
        }
    }

    let probe = data_dir.join(".write_probe");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => { let _ = std::fs::remove_file(probe); Ok(true) }
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub fn get_disk_free_mb() -> Result<u64, String> {
    let output = std::process::Command::new("df")
        .args(["-m", "--output=avail", "/"])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mb = stdout.lines().nth(1)
        .and_then(|l| l.trim().parse::<u64>().ok())
        .unwrap_or(0);

    Ok(mb)
}

/// Run a command inside a container via `<runtime> exec`.
#[tauri::command]
pub async fn exec_container(
    state: State<'_, AppState>,
    container_id: String,
    command: String,
) -> Result<String, String> {
    let cli = state.container.lock().await.runtime.cli();

    let args: Vec<&str> = command.split_whitespace().collect();
    if args.is_empty() { return Ok(String::new()); }

    let mut cmd_args = vec!["exec", &container_id];
    cmd_args.extend(args.iter().copied());

    let output = tokio::process::Command::new(cli)
        .args(&cmd_args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{}{}", stdout, stderr)
    })
}

/// Run a binary with given args and return its stdout (first line).
/// Used by preflight to check tool availability and get version strings.
#[tauri::command]
pub async fn check_tool_available(cmd: String, args: Vec<String>) -> Result<String, String> {
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = std::process::Command::new(&cmd)
        .args(&args_ref)
        .output()
        .map_err(|e| format!("{cmd} not found: {e}"))?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{cmd} exited with status {}", output.status)
        } else {
            stderr
        })
    }
}
