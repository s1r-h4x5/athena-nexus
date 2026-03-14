// ═══════════════════════════════════════════════════════════
// snapshot/commands.rs — Tauri commands for Snapshot & Backup
// ═══════════════════════════════════════════════════════════

use super::{load_meta, save_meta, snapshots_dir, SnapshotRecord};
use crate::vault::now_iso;
use crate::AppState;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use tauri::State;

const API_VER: &str = "v4.0.0";

// ── Minimal HTTP helpers (same pattern as podman/commands.rs) ─ //

fn unix_get_bytes(socket: &str, path: &str) -> Result<Vec<u8>, String> {
    let mut stream = UnixStream::connect(socket)
        .map_err(|e| format!("Cannot connect to {}: {}", socket, e))?;
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        path
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(&stream);
    // Skip headers
    let mut header = String::new();
    loop {
        header.clear();
        reader.read_line(&mut header).map_err(|e| e.to_string())?;
        if header == "\r\n" || header.is_empty() { break; }
    }
    // Read body bytes
    let mut body = Vec::new();
    reader.read_to_end(&mut body).map_err(|e| e.to_string())?;
    Ok(body)
}

fn unix_post_json(socket: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let body_str = body.map(|b| b.to_string()).unwrap_or_default();
    let mut stream = UnixStream::connect(socket)
        .map_err(|e| format!("Cannot connect to {}: {}", socket, e))?;
    let req = format!(
        "POST {} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path, body_str.len(), body_str
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(&stream);
    let mut header = String::new();
    let mut status_code = 200u16;

    // Parse status line
    let mut status_line = String::new();
    reader.read_line(&mut status_line).map_err(|e| e.to_string())?;
    if let Some(code_str) = status_line.split_whitespace().nth(1) {
        status_code = code_str.parse().unwrap_or(200);
    }
    // Skip rest of headers
    loop {
        header.clear();
        reader.read_line(&mut header).map_err(|e| e.to_string())?;
        if header == "\r\n" || header.is_empty() { break; }
    }

    let mut body_raw = String::new();
    reader.read_to_string(&mut body_raw).map_err(|e| e.to_string())?;

    if status_code >= 400 {
        return Err(format!("HTTP {} — {}", status_code, body_raw.trim()));
    }

    if body_raw.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body_raw).map_err(|e| format!("JSON parse: {} (body: {})", e, &body_raw[..body_raw.len().min(200)]))
}

fn delete_req(socket: &str, path: &str) -> Result<(), String> {
    let mut stream = UnixStream::connect(socket)
        .map_err(|e| format!("Cannot connect: {}", e))?;
    let req = format!(
        "DELETE {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n", path
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Generate snapshot ID ──────────────────────────────────── //
fn new_id() -> String {
    format!("snap-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis())
}

// ── List all snapshots ────────────────────────────────────── //
#[tauri::command]
pub fn snapshot_list() -> Result<Vec<SnapshotRecord>, String> {
    let mut records = load_meta()?;
    // Verify which exports still exist on disk
    for r in &mut records {
        if let Some(ref path) = r.tar_path {
            r.exported = std::path::Path::new(path).exists();
        }
    }
    // Newest first
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(records)
}

// ── Create a snapshot (commit containers → images) ────────── //
#[tauri::command]
pub async fn snapshot_create(
    _state: State<'_, AppState>,
    tool_id: String,
    tool_name: String,
    container_ids: Vec<String>,
    note: String,
) -> Result<SnapshotRecord, String> {
    let snap_id = new_id();
    let mut image_names = Vec::new();

    for (i, cid) in container_ids.iter().enumerate() {
        let image_tag = format!("athena-snapshot/{}-{}:{}", tool_id, i, snap_id);

        // Use `podman commit` CLI — more reliable across Podman 4 & 5 than the REST API commit endpoint
        let output = tokio::process::Command::new("podman")
            .args(["commit", "--pause=false", cid.as_str(), image_tag.as_str()])
            .output()
            .await
            .map_err(|e| format!("Failed to run podman commit: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "podman commit failed (exit {}): {} {}",
                output.status.code().unwrap_or(-1),
                stderr.trim(),
                stdout.trim()
            ));
        }

        image_names.push(image_tag);
    }

    let record = SnapshotRecord {
        id: snap_id,
        tool_id,
        tool_name,
        container_ids,
        image_names,
        tar_path: None,
        note,
        size_bytes: None,
        created_at: now_iso(),
        exported: false,
    };

    let mut records = load_meta()?;
    records.push(record.clone());
    save_meta(&records)?;
    Ok(record)
}

// ── Export snapshot images to a .tar file ─────────────────── //
#[tauri::command]
pub async fn snapshot_export(
    state: State<'_, AppState>,
    snapshot_id: String,
) -> Result<String, String> {
    let socket = state.container.lock().await.socket_path.clone();
    let mut records = load_meta()?;

    let record = records.iter().find(|r| r.id == snapshot_id)
        .ok_or_else(|| format!("Snapshot '{}' not found", snapshot_id))?
        .clone();

    // Build export dir
    let dir = snapshots_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tar_path = dir.join(format!("{}.tar", snapshot_id));

    // Use `podman save` endpoint — exports all image layers
    // For multi-image snapshots, export the first image (compose stacks
    // can be restored per-container)
    let first_image = record.image_names.first()
        .ok_or("No images in snapshot")?;
    let encoded = urlencoding::encode(first_image).to_string();
    let path = format!("/{}/libpod/images/{}/get?compress=true", API_VER, encoded);

    let bytes = tokio::task::spawn_blocking({
        let socket = socket.clone();
        move || unix_get_bytes(&socket, &path)
    }).await.map_err(|e| e.to_string())??;

    let size = bytes.len() as u64;
    std::fs::write(&tar_path, &bytes).map_err(|e| e.to_string())?;

    let tar_str = tar_path.to_string_lossy().to_string();

    // Update record
    for r in &mut records {
        if r.id == snapshot_id {
            r.tar_path   = Some(tar_str.clone());
            r.size_bytes = Some(size);
            r.exported   = true;
        }
    }
    save_meta(&records)?;
    Ok(tar_str)
}

// ── Restore snapshot (load image, start container) ────────── //
#[tauri::command]
pub async fn snapshot_restore(
    state: State<'_, AppState>,
    snapshot_id: String,
) -> Result<String, String> {
    let socket = state.container.lock().await.socket_path.clone();
    let records = load_meta()?;

    let record = records.iter().find(|r| r.id == snapshot_id)
        .ok_or_else(|| format!("Snapshot '{}' not found", snapshot_id))?
        .clone();

    // If the images still exist locally, we can start directly.
    // Otherwise load from .tar export if available.
    if let Some(ref tar) = record.tar_path {
        if !std::path::Path::new(tar).exists() {
            return Err(format!("Export file not found at {}", tar));
        }
        let tar_bytes = std::fs::read(tar).map_err(|e| e.to_string())?;
        let path = format!("/{}/libpod/images/load", API_VER);

        // POST raw tar body
        let mut stream = UnixStream::connect(&socket)
            .map_err(|e| format!("Cannot connect: {}", e))?;
        let req = format!(
            "POST {} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-tar\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            path, tar_bytes.len()
        );
        stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        stream.write_all(&tar_bytes).map_err(|e| e.to_string())?;
        stream.flush().map_err(|e| e.to_string())?;
    }

    // Start containers from snapshot images
    for (i, image) in record.image_names.iter().enumerate() {
        let body = serde_json::json!({
            "image": image,
            "name": format!("{}-restored-{}", record.tool_id, i),
        });
        let path = format!("/{}/libpod/containers/create", API_VER);
        let result = tokio::task::spawn_blocking({
            let socket = socket.clone();
            let path   = path.clone();
            let body   = body.clone();
            move || unix_post_json(&socket, &path, Some(body))
        }).await.map_err(|e| e.to_string())??;

        // Start the newly created container
        if let Some(cid) = result.get("Id").and_then(|v| v.as_str()) {
            let start_path = format!("/{}/libpod/containers/{}/start", API_VER, cid);
            let _ = tokio::task::spawn_blocking({
                let socket = socket.clone();
                move || unix_post_json(&socket, &start_path, None)
            }).await;
        }
    }

    Ok(format!("Restored {} from snapshot {}", record.tool_name, snapshot_id))
}

// ── Delete a snapshot (metadata + images + tar) ───────────── //
#[tauri::command]
pub async fn snapshot_delete(
    state: State<'_, AppState>,
    snapshot_id: String,
) -> Result<(), String> {
    let socket = state.container.lock().await.socket_path.clone();
    let mut records = load_meta()?;

    let record = records.iter().find(|r| r.id == snapshot_id)
        .ok_or_else(|| format!("Snapshot '{}' not found", snapshot_id))?
        .clone();

    // Delete committed images from Podman (best-effort)
    for image in &record.image_names {
        let encoded = urlencoding::encode(image).to_string();
        let path = format!("/{}/libpod/images/{}?force=true", API_VER, encoded);
        let _ = tokio::task::spawn_blocking({
            let socket = socket.clone();
            move || delete_req(&socket, &path)
        }).await;
    }

    // Delete .tar export if present
    if let Some(ref tar) = record.tar_path {
        let _ = std::fs::remove_file(tar);
    }

    records.retain(|r| r.id != snapshot_id);
    save_meta(&records)?;
    Ok(())
}

// ── Update snapshot note ──────────────────────────────────── //
#[tauri::command]
pub fn snapshot_update_note(snapshot_id: String, note: String) -> Result<(), String> {
    let mut records = load_meta()?;
    let rec = records.iter_mut().find(|r| r.id == snapshot_id)
        .ok_or_else(|| format!("Snapshot '{}' not found", snapshot_id))?;
    rec.note = note;
    save_meta(&records)
}
