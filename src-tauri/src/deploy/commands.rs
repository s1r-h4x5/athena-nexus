// ═══════════════════════════════════════════════════════════
// deploy/commands.rs — Tauri commands for tool deployment
// ═══════════════════════════════════════════════════════════

#![allow(unused_imports, dead_code)]

use super::is_port_in_use;
use super::cancel::{set_active_pid, clear_active_pid};
use crate::container::CommandResult;
use std::process::Stdio;
use tauri::{Emitter, WebviewWindow as Window};
use tokio::io::BufReader;
use tokio::process::Command;

/// Strip ANSI escape sequences from a string before sending to the frontend
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip ESC [ ... <letter>
            if chars.peek() == Some(&'[') {
                chars.next();
                for ch in chars.by_ref() {
                    if ch.is_ascii_alphabetic() { break; }
                }
            }
        } else if c == '\r' {
            // Carriage return: Docker uses \r to overwrite the current line in a terminal.
            // Discard everything written so far on this line — the next chars are the update.
            result.clear();
        } else {
            result.push(c);
        }
    }
    result
}

/// Emit a progress line to the frontend deploy modal
macro_rules! emit_progress {
    ($window:expr, $msg:expr) => {
        let _ = $window.emit("deploy:progress", strip_ansi(&$msg));
    };
}

/// Check if a port is already in use on this host
#[tauri::command]
pub fn check_port_in_use(port: u16) -> bool {
    is_port_in_use(port)
}

/// Deploy a tool — pull its image and start it.
#[tauri::command]
pub async fn deploy_tool(
    window: Window,
    state: tauri::State<'_, crate::AppState>,
    tool_id: String,
    image: String,
    compose_url: Option<String>,
    compose_file: Option<String>,
    compose_repo: Option<String>,
    compose_repo_tag: Option<String>,
    compose_subdir: Option<String>,
    pre_deploy: Option<Vec<serde_json::Value>>,
    ports: Vec<String>,
    _entrypoint: Option<String>,
    cli_tool: Option<bool>,
    #[allow(clippy::used_underscore_binding)]
    env: Option<std::collections::HashMap<String, String>>,
    port_overrides: Option<std::collections::HashMap<String, String>>,
) -> Result<CommandResult, String> {
    // Release lock immediately before long-running deploy operations
    let runtime = { state.container.lock().await.runtime.clone() };
    let env = env.unwrap_or_default();
    let pre_deploy = pre_deploy.unwrap_or_default();
    let port_overrides = port_overrides.unwrap_or_default();

    if let Some(ref repo) = compose_repo {
        let tag    = compose_repo_tag.as_deref().unwrap_or("main");
        let subdir = compose_subdir.as_deref();
        deploy_compose_repo(&window, &runtime, &tool_id, repo, tag, subdir, &env, &pre_deploy).await
    } else if let Some(ref url) = compose_url {
        deploy_compose(&window, &runtime, &tool_id, url, None, &env, &pre_deploy, &port_overrides).await
    } else if let Some(ref path) = compose_file {
        deploy_compose(&window, &runtime, &tool_id, path, Some(path.as_str()), &env, &pre_deploy, &port_overrides).await
    } else {
        deploy_single_image(&window, &runtime, &image, &ports, cli_tool.unwrap_or(false), &env).await
    }
}

/// Normalise a port spec to a valid `podman run -p` argument.
/// "8080"       → "8080:8080"
/// "8081:8000"  → "8081:8000"  (pass through)
fn normalise_port_spec(spec: &str) -> String {
    let s = spec.trim();
    if s.contains(':') { s.to_string() } else { format!("{s}:{s}") }
}

/// Deploy a single container image
async fn deploy_single_image(
    window: &Window,
    runtime: &crate::container::ContainerRuntime,
    image: &str,
    ports: &[String],
    cli_tool: bool,
    env: &std::collections::HashMap<String, String>,
) -> Result<CommandResult, String> {
    let cli = runtime.cli();

    // ── Pull ────────────────────────────────────────────── //
    emit_progress!(window, format!("[{}] Pulling {}…", cli, image));
    let pull_status = run_command_streaming(window, cli, &["pull", image]).await?;
    if !pull_status {
        return Ok(CommandResult::err(format!("Failed to pull image: {}", image)));
    }
    emit_progress!(window, "Pull complete.".to_string());

    // ── Run ─────────────────────────────────────────────── //
    emit_progress!(window, "Starting container…".to_string());

    let restart_policy = if cli_tool { "no" } else { "unless-stopped" };
    let restart_flag = format!("--restart={}", restart_policy);
    let mut run_args = vec!["run", "-d", &restart_flag];

    let port_args: Vec<String> = ports.iter().map(|p| normalise_port_spec(p)).collect();
    let port_flags: Vec<&str> = port_args.iter()
        .flat_map(|p| vec!["-p", p.as_str()])
        .collect();

    // Build -e KEY=VALUE args for plain env vars
    let env_pairs: Vec<String> = env.iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect();
    let env_flags: Vec<&str> = env_pairs.iter()
        .flat_map(|kv| vec!["-e", kv.as_str()])
        .collect();

    if !env.is_empty() {
        emit_progress!(window, format!("Injecting {} environment variable(s).", env.len()));
    }

    let container_name = image
        .split('/').last().unwrap_or(image)
        .split(':').next().unwrap_or(image);

    emit_progress!(window, format!("Removing existing '{}' container if present…", container_name));
    let _ = tokio::process::Command::new(cli)
        .args(["rm", "-f", container_name])
        .output()
        .await;

    run_args.extend(port_flags.iter().copied());
    run_args.extend(env_flags.iter().copied());
    if cli_tool {
        // Override the image entrypoint entirely — otherwise "sleep infinity"
        // gets passed as arguments TO the tool (e.g. nuclei sleep infinity → runs a scan).
        run_args.extend(&["--entrypoint", "sleep"]);
        emit_progress!(window, "CLI tool: container will stay alive for exec sessions.".to_string());
    }

    run_args.extend(&["--name", container_name, image]);

    if cli_tool {
        run_args.push("infinity");
    }

    let run_status = run_command_streaming(window, cli, &run_args).await?;
    if run_status {
        emit_progress!(window, format!("Container '{}' started.", container_name));
        Ok(CommandResult::ok(format!("Deployed {}", image)))
    } else {
        Ok(CommandResult::err(format!("Failed to start container for {}", image)))
    }
}

/// Deploy a compose stack from a Git repository tarball.
///
/// Downloads `<repo>/archive/refs/tags/<tag>.tar.gz` (GitHub/GitLab style),
/// extracts it to `/tmp/athena-nexus/<tool_id>/`, writes the `.env` file into
/// the compose subdirectory, then runs compose from there.
///
/// This handles tools like Wazuh whose compose file depends on sibling
/// `./config/` directories that only exist when the full repo is present.
async fn deploy_compose_repo(
    window: &Window,
    runtime: &crate::container::ContainerRuntime,
    tool_id: &str,
    repo_url: &str,
    tag: &str,
    subdir: Option<&str>,
    env: &std::collections::HashMap<String, String>,
    pre_deploy: &[serde_json::Value],
) -> Result<CommandResult, String> {
    let work_dir = format!("/tmp/athena-nexus/{}", tool_id);

    // ── Verify compose binary is available before doing any work ── //
    let (compose_program, _) = runtime.compose_cmd();
    if !check_command_exists(compose_program).await {
        emit_progress!(window, format!("✗ '{}' not found.", compose_program));
        return Ok(CommandResult::err(format!(
            "'{}' is not installed. Please install it and try again.", compose_program
        )));
    }

    // Remove any stale work directory from a previous deploy attempt.
    // Containers may leave dirs with restricted permissions (e.g. r-x------) that
    // prevent rm -rf from deleting files inside them.
    // Fix permissions first using container-based chmod (no host sudo needed),
    // then remove the directory.
    if std::path::Path::new(&work_dir).exists() {
        emit_progress!(window, format!("Cleaning up previous deploy directory: {}…", work_dir));
        // Fix any root-owned files via a throwaway container, then rm
        fix_work_dir_permissions(&window, &runtime, &work_dir).await;
        let rm_ok = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::process::Command::new("rm")
                .args(["-rf", &work_dir])
                .output()
        ).await.map(|r| r.map(|o| o.status.success()).unwrap_or(false)).unwrap_or(false);
        if !rm_ok {
            // Last resort: container-based rm (runs as root inside alpine)
            let mount = format!("{}:/mnt/del", work_dir);
            let cli = runtime.cli();
            let _ = tokio::process::Command::new(cli)
                .args(["run", "--rm", "-v", &mount, "alpine", "rm", "-rf", "/mnt/del"])
                .output().await;
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
        }
    }
    tokio::fs::create_dir_all(&work_dir).await.map_err(|e| e.to_string())?;

    // ── Build tarball URL ────────────────────────────────── //
    // Try in order:
    //   1. refs/tags/<tag>     — explicit version tag (e.g. v4.14.3)
    //   2. refs/heads/<tag>    — explicit branch name (e.g. "main" if set)
    //   3. refs/heads/main     — common default branch
    //   4. refs/heads/master   — legacy default branch
    let repo_url = repo_url.trim_end_matches('/');
    let tarball_path = format!("{}/repo.tar.gz", work_dir);

    let curl_args = |url: &str| -> Vec<String> {
        vec![
            "-fL".into(),
            "--progress-bar".into(),
            "--stderr".into(), "-".into(),  // redirect progress output to stdout so we can stream it
            "--connect-timeout".into(), "15".into(),
            "--max-time".into(), "120".into(),
            "-o".into(), tarball_path.clone(),
            url.to_string(),
        ]
    };

    // Build candidate URLs — deduplicated so we don't try "main" twice if tag=="main"
    let mut candidates: Vec<String> = vec![
        format!("{}/archive/refs/tags/{}.tar.gz", repo_url, tag),
        format!("{}/archive/refs/heads/{}.tar.gz", repo_url, tag),
    ];
    for branch in &["main", "master"] {
        let url = format!("{}/archive/refs/heads/{}.tar.gz", repo_url, branch);
        if !candidates.contains(&url) {
            candidates.push(url);
        }
    }

    let mut downloaded = false;
    for url in &candidates {
        emit_progress!(window, format!("Trying: {}…", url));
        let args_owned = curl_args(url);
        let args_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
        let ok = run_command_streaming(window, "curl", &args_refs).await?;
        if ok {
            emit_progress!(window, format!("Downloaded from {}", url));
            downloaded = true;
            break;
        }
    }

    if !downloaded {
        return Ok(CommandResult::err(format!(
            "Failed to download repository archive from {} (tried tag, branch, main, master)", repo_url
        )));
    }

    // ── Extract ──────────────────────────────────────────── //
    emit_progress!(window, format!("Extracting archive to {}…", work_dir));
    let extract_ok = run_command_streaming(
        window, "tar",
        &["-xzf", &tarball_path, "-C", &work_dir, "--strip-components=1"],
    ).await?;

    if !extract_ok {
        return Ok(CommandResult::err("Failed to extract repository archive.".to_string()));
    }

    // ── Locate compose file ──────────────────────────────── //
    let compose_dir = match subdir {
        Some(s) => format!("{}/{}", work_dir, s),
        None    => work_dir.clone(),
    };

    // Find the compose file — support both docker-compose.yml and compose.yaml
    let compose_path = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
        .iter()
        .map(|name| format!("{}/{}", compose_dir, name))
        .find(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| format!(
            "No compose file found in '{}'. Check compose_subdir in tools.json.", compose_dir
        ))?;

    emit_progress!(window, format!("Found compose file: {}", compose_path));

    // ── Write .env file ──────────────────────────────────── //
    if !env.is_empty() {
        let env_file = format!("{}/.env", compose_dir);
        let env_content = env.iter()
            .map(|(k, v)| {
                if v.chars().any(|c| c == ' ' || c == '"' || c == '\'') {
                    format!("{}=\"{}\"", k, v.replace('"', "\\\""))
                } else {
                    format!("{}={}", k, v)
                }
            })
            .collect::<Vec<_>>()
            .join("\n");

        tokio::fs::write(&env_file, format!("{}\n", env_content))
            .await
            .map_err(|e| format!("Failed to write .env file: {}", e))?;

        emit_progress!(window, format!("Wrote {} variable(s) to {}", env.len(), env_file));
    }

    // ── Pre-deploy steps ─────────────────────────────────── //
    if !pre_deploy.is_empty() {
        if let Err(e) = run_pre_deploy_steps(window, runtime, pre_deploy, &compose_dir).await {
            return Ok(CommandResult::err(format!("Pre-deploy step failed: {}", e)));
        }
    }

    // ── Fix permissions before compose up ──────────────────── //
    // Some compose stacks (e.g. Wazuh) run init containers as root that create
    // directories owned by root. On a re-deploy these cause "Permission denied".
    // Use container-based chmod — no host sudo required.
    fix_work_dir_permissions(&window, &runtime, &work_dir).await;

    // ── Run compose ──────────────────────────────────────── //
    let (program, leading) = runtime.compose_cmd();
    let mut args: Vec<&str> = leading.clone();
    args.extend(["-p", tool_id, "-f", &compose_path, "up", "-d"]);
    if matches!(runtime, crate::container::ContainerRuntime::Docker) {
        args.push("--pull");
        args.push("always");
    }

    emit_progress!(window, "Starting compose stack (this may take a while — pulling all images)…".to_string());
    emit_progress!(window, format!("▶ {}", format!("{} {}", program, args.join(" "))));

    // Run compose from within the compose directory so relative paths work
    let succeeded = run_command_streaming_in(window, program, &args, &compose_dir)
        .await
        .unwrap_or(false);

    if succeeded {
        emit_progress!(window, "Compose stack started.".to_string());
        Ok(CommandResult::ok(format!("Deployed compose stack for {}", tool_id)))
    } else {
        emit_progress!(window, format!("✗ Compose failed for {}", tool_id));
        Ok(CommandResult::err(format!("Failed to start compose stack for {}", tool_id)))
    }
}


async fn deploy_compose(
    window: &Window,
    runtime: &crate::container::ContainerRuntime,
    tool_id: &str,
    source: &str,
    local_path: Option<&str>,
    env: &std::collections::HashMap<String, String>,
    pre_deploy: &[serde_json::Value],
    port_overrides: &std::collections::HashMap<String, String>,
) -> Result<CommandResult, String> {
    // ── Verify compose binary is available before doing any work ── //
    let (compose_program, _) = runtime.compose_cmd();
    if !check_command_exists(compose_program).await {
        emit_progress!(window, format!("✗ '{}' not found.", compose_program));
        return Ok(CommandResult::err(format!(
            "'{}' is not installed. Please install it and try again.", compose_program
        )));
    }

    let compose_path = if let Some(path) = local_path {
        emit_progress!(window, format!("Using local compose file: {}", path));
        path.to_string()
    } else {
        emit_progress!(window, format!("Downloading compose file from {}…", source));
        let compose_dir = format!("/tmp/athena-nexus/{}", tool_id);
        tokio::fs::create_dir_all(&compose_dir).await.map_err(|e| e.to_string())?;
        let dest = format!("{}/docker-compose.yml", compose_dir);
        emit_progress!(window, format!("▶ curl -fL --progress-bar --connect-timeout 15 --max-time 120 -o {} {}", dest, source));
        let dl_status = run_command_streaming(window, "curl", &["-fL", "--progress-bar", "--stderr", "-", "--connect-timeout", "15", "--max-time", "120", "-o", &dest, source]).await?;
        if !dl_status {
            return Ok(CommandResult::err(format!("Failed to download compose file from {}", source)));
        }
        emit_progress!(window, format!("Compose file saved to {}", dest));

        // Apply port overrides — rewrite "HOST:CONTAINER" lines in the compose file.
        if !port_overrides.is_empty() {
            let content = tokio::fs::read_to_string(&dest).await.map_err(|e| e.to_string())?;
            let mut patched = content.clone();
            for (original, new_host) in port_overrides {
                // Match both quoted and unquoted port specs: "80:80", '80:80', 80:80
                // Replace the host side only, keeping the container port intact.
                // Pattern handles: - "80:80"  - '80:80'  - - 80:80
                let patterns = [
                    format!("\"{}:", original),
                    format!("'{}:", original),
                    format!(" {}:", original),
                    format!("\t{}:", original),
                ];
                for pat in &patterns {
                    let replacement = pat.replace(&format!("{}:", original), &format!("{}:", new_host));
                    patched = patched.replace(pat.as_str(), &replacement);
                }
            }
            if patched != content {
                tokio::fs::write(&dest, &patched).await.map_err(|e| e.to_string())?;
                emit_progress!(window, format!("Applied {} port override(s) to compose file", port_overrides.len()));
            }
        }

        dest
    };

    // Resolve the compose directory once — used for .env, --env-file, and cwd.
    let compose_dir_str = std::path::Path::new(&compose_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/tmp".to_string());

    // Write .env file. Docker Compose only auto-reads .env from the working
    // directory, not the compose file directory, so we also pass --env-file.
    let env_file = format!("{}/.env", compose_dir_str);
    if !env.is_empty() {
        let env_content = env.iter()
            .map(|(k, v)| {
                if v.chars().any(|c| c == ' ' || c == '"' || c == '\'') {
                    format!("{}=\"{}\"", k, v.replace('"', "\\\""))
                } else {
                    format!("{}={}", k, v)
                }
            })
            .collect::<Vec<_>>()
            .join("\n");

        tokio::fs::write(&env_file, format!("{}\n", env_content))
            .await
            .map_err(|e| format!("Failed to write .env file: {}", e))?;

        emit_progress!(window, format!("Wrote {} variable(s) to {}", env.len(), env_file));
    }

    // ── Fix permissions before compose up ──────────────────── //
    // Some compose stacks run init containers as root on first deploy, leaving
    // root-owned files that block re-deploys. Fix without host sudo.
    fix_work_dir_permissions(&window, runtime, &compose_dir_str).await;

    // Build compose command.
    let (program, leading) = runtime.compose_cmd();
    let mut args: Vec<&str> = leading.clone();

    // ── Pre-deploy steps ─────────────────────────────────── //
    if !pre_deploy.is_empty() {
        if let Err(e) = run_pre_deploy_steps(window, runtime, pre_deploy, &compose_dir_str).await {
            return Ok(CommandResult::err(format!("Pre-deploy step failed: {}", e)));
        }
    }

    // Pass --env-file explicitly as belt-and-suspenders.
    if std::path::Path::new(&env_file).exists() {
        args.extend(["--env-file", &env_file]);
    }

    args.extend(["-p", tool_id, "-f", &compose_path, "up", "-d"]);
    if matches!(runtime, crate::container::ContainerRuntime::Docker) {
        args.push("--pull");
        args.push("always");
    }

    let cmd_display = format!("{} {}", program, args.join(" "));
    emit_progress!(window, "Starting compose stack (pulling images if needed)…".to_string());
    emit_progress!(window, format!("▶ {}", cmd_display));

    // Run with cwd = compose dir so relative volume paths and auto .env work.
    let succeeded = run_command_streaming_in(window, program, &args, &compose_dir_str).await.unwrap_or(false);

    if succeeded {
        emit_progress!(window, "Compose stack started.".to_string());
        Ok(CommandResult::ok(format!("Deployed compose stack for {}", tool_id)))
    } else {
        emit_progress!(window, format!("✗ Compose failed for {}", tool_id));
        Ok(CommandResult::err(format!("Failed to start compose stack for {}", tool_id)))
    }
}

/// Execute all pre-deploy steps in order from `cwd`.
/// Steps are passed as raw JSON values (from the frontend) to avoid
/// serde type issues across the Tauri command boundary.
///
/// Supported step shapes:
///   { "type": "compose", "file": "generate-certs.yml", "args": ["run","--rm","generator"] }
///   { "type": "shell",   "cmd": "bash ./setup.sh" }
async fn run_pre_deploy_steps(
    window: &Window,
    runtime: &crate::container::ContainerRuntime,
    steps: &[serde_json::Value],
    cwd: &str,
) -> Result<(), String> {
    for (i, step) in steps.iter().enumerate() {
        let step_type = step.get("type").and_then(|v| v.as_str()).unwrap_or("unknown");
        emit_progress!(window, format!("Pre-deploy step {}/{}: type={}", i + 1, steps.len(), step_type));

        match step_type {
            "compose" => {
                let file = step.get("file")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("Pre-deploy compose step {} missing 'file'", i + 1))?;

                let extra_args: Vec<String> = step.get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();

                let file_path = format!("{}/{}", cwd, file);
                let (program, leading) = runtime.compose_cmd();
                let mut args: Vec<&str> = leading.clone();
                args.extend(["-f", &file_path]);
                let extra_refs: Vec<&str> = extra_args.iter().map(|s| s.as_str()).collect();
                args.extend(extra_refs.iter().copied());

                emit_progress!(window, format!("▶ {} {}", program, args.join(" ")));
                let ok = run_command_streaming_in(window, program, &args, cwd).await?;
                if !ok {
                    return Err(format!("Pre-deploy compose step {} failed: {} -f {}", i + 1, program, file));
                }
            }
            "shell" => {
                let cmd = step.get("cmd")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("Pre-deploy shell step {} missing 'cmd'", i + 1))?;

                emit_progress!(window, format!("▶ sh -c \"{}\"", cmd));
                let ok = run_command_streaming_in(window, "sh", &["-c", cmd], cwd).await?;
                if !ok {
                    return Err(format!("Pre-deploy shell step {} failed: {}", i + 1, cmd));
                }
            }
            other => {
                return Err(format!("Unknown pre-deploy step type '{}' at step {}", other, i + 1));
            }
        }

        emit_progress!(window, format!("✓ Pre-deploy step {}/{} complete.", i + 1, steps.len()));
    }
    Ok(())
}

/// Run an external command, streaming each output line to the frontend.
/// Returns true if exit code == 0.
async fn run_command_streaming(
    window: &Window,
    program: &str,
    args: &[&str],
) -> Result<bool, String> {
    run_command_streaming_in(window, program, args, "").await
}

/// Like run_command_streaming but sets the working directory.
/// Pass an empty string to inherit the current working directory.
async fn run_command_streaming_in(
    window: &Window,
    program: &str,
    args: &[&str],
    cwd: &str,
) -> Result<bool, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", program, e))?;

    // Register PID so cancel_deploy() can kill this process
    if let Some(pid) = child.id() {
        set_active_pid(pid);
    }

    // Drain stdout — split on \n AND \r so Docker's carriage-return progress
    // updates each emit a separate event instead of buffering into one giant line.
    let stdout_handle = if let Some(stdout) = child.stdout.take() {
        let window_clone = window.clone();
        Some(tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                match reader.read(&mut byte).await {
                    Ok(0) | Err(_) => {
                        if !buf.is_empty() {
                            let line = String::from_utf8_lossy(&buf).to_string();
                            let clean = strip_ansi(&line);
                            if !clean.trim().is_empty() {
                                emit_progress!(window_clone, clean);
                            }
                        }
                        break;
                    }
                    Ok(_) => {
                        match byte[0] {
                            b'\n' | b'\r' => {
                                let line = String::from_utf8_lossy(&buf).to_string();
                                let clean = strip_ansi(&line);
                                if !clean.trim().is_empty() {
                                    emit_progress!(window_clone, clean);
                                }
                                buf.clear();
                            }
                            _ => buf.push(byte[0]),
                        }
                    }
                }
            }
        }))
    } else { None };

    // Drain stderr — same \r-aware logic, tag lines with "stderr: " prefix
    let stderr_handle = if let Some(stderr) = child.stderr.take() {
        let window_clone = window.clone();
        Some(tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                match reader.read(&mut byte).await {
                    Ok(0) | Err(_) => {
                        if !buf.is_empty() {
                            let line = String::from_utf8_lossy(&buf).to_string();
                            let clean = strip_ansi(&line);
                            if !clean.trim().is_empty() {
                                emit_progress!(window_clone, format!("stderr: {}", clean));
                            }
                        }
                        break;
                    }
                    Ok(_) => {
                        match byte[0] {
                            b'\n' | b'\r' => {
                                let line = String::from_utf8_lossy(&buf).to_string();
                                let clean = strip_ansi(&line);
                                if !clean.trim().is_empty() {
                                    emit_progress!(window_clone, format!("stderr: {}", clean));
                                }
                                buf.clear();
                            }
                            _ => buf.push(byte[0]),
                        }
                    }
                }
            }
        }))
    } else { None };

    let status = child.wait().await.map_err(|e| e.to_string())?;
    clear_active_pid();

    // Wait for both readers to finish flushing before returning
    if let Some(h) = stdout_handle { let _ = h.await; }
    if let Some(h) = stderr_handle { let _ = h.await; }

    Ok(status.success())
}

/// Remove a deployed tool's containers
/// Fix permissions on a work directory that may have root-owned files left by
/// previous container runs (e.g. Wazuh ssl_certs, Greenbone data dirs).
///
/// Strategy (no host sudo required):
///  1. Try plain `chmod -R a+rwX <dir>` — works if files are owned by the current user.
///  2. If that fails, spin up a tiny container (alpine) with the dir bind-mounted and
///     run chmod inside it as root. The container daemon already runs with the necessary
///     privileges, so this needs no host-level sudo at all.
async fn fix_work_dir_permissions(
    window: &Window,
    runtime: &crate::container::ContainerRuntime,
    work_dir: &str,
) {
    // Fast path: dir doesn't exist yet — nothing to fix
    if !std::path::Path::new(work_dir).exists() {
        return;
    }

    // 1. Plain chmod — succeeds when files are user-owned
    let chmod_ok = tokio::process::Command::new("chmod")
        .args(["-R", "a+rwX", work_dir])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    if chmod_ok {
        return;
    }

    // 2. Container-based chmod — runs as root inside a throwaway alpine container,
    //    no host sudo required. The bind-mount makes the host directory writable.
    emit_progress!(window, "⚙ Fixing root-owned file permissions via container (no sudo needed)…".to_string());
    let cli = runtime.cli();
    let mount = format!("{}:/mnt/work", work_dir);
    let _ = tokio::process::Command::new(cli)
        .args(["run", "--rm", "-v", &mount, "alpine", "chmod", "-R", "a+rwX", "/mnt/work"])
        .output()
        .await;
}

#[tauri::command]
pub async fn undeploy_tool(
    window: Window,
    state: tauri::State<'_, crate::AppState>,
    tool_id: String,
    container_ids: Vec<String>,
    compose_url: Option<String>,
    compose_file: Option<String>,
    compose_repo: Option<String>,
    compose_repo_tag: Option<String>,
    compose_subdir: Option<String>,
) -> Result<CommandResult, String> {
    // Release lock immediately — compose down can take minutes, must not hold mutex
    let runtime = { state.container.lock().await.runtime.clone() };
    emit_progress!(window, format!("Stopping {}…", tool_id));

    // A tool is compose-based if any compose source is provided
    let is_compose = compose_url.is_some() || compose_file.is_some() || compose_repo.is_some();
    // For compose_url tools, the file was downloaded to the work dir during deploy
    let effective_compose_file = compose_file.or_else(|| {
        if compose_url.is_some() {
            let work_dir = format!("/tmp/athena-nexus/{}", tool_id);
            find_compose_file_in(&work_dir)
        } else {
            None
        }
    });

    if is_compose {
        let (program, leading) = runtime.compose_cmd();

        // ── Verify compose binary is available ── //
        if !check_command_exists(program).await {
            emit_progress!(window, format!(
                "⚠ '{}' not found — falling back to removing containers individually.", program
            ));
            let cli = runtime.cli();
            for id in &container_ids {
                let _ = run_command_streaming(&window, cli, &["rm", "-f", id]).await;
            }
            emit_progress!(window, format!("{} removed (without compose).", tool_id));
            return Ok(CommandResult::ok(format!("Removed {}", tool_id)));
        }

        // For compose_repo tools (e.g. Wazuh), we need the actual compose file
        // path so Docker can find the correct networks/volumes to tear down.
        // Re-use the existing work dir, or re-download if it was cleaned up.
        let compose_path: Option<String> = if let Some(ref repo) = compose_repo {
            let work_dir = format!("/tmp/athena-nexus/{}", tool_id);
            let tag = compose_repo_tag.as_deref().unwrap_or("main");
            let subdir = compose_subdir.as_deref();

            // Determine expected compose file path
            let compose_dir = match subdir {
                Some(s) => format!("{}/{}", work_dir, s),
                None    => work_dir.clone(),
            };
            let expected = find_compose_file_in(&compose_dir);

            if expected.is_some() {
                emit_progress!(window, format!("Using existing work dir: {}", compose_dir));
                expected
            } else {
                // Work dir was cleaned up — re-download the repo so we have the compose file
                emit_progress!(window, format!("Re-downloading repo for compose down…"));
                std::fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
                let repo_url = repo.trim_end_matches('/');
                let tarball = format!("{}/repo.tar.gz", work_dir);
                let mut dl_candidates: Vec<String> = vec![
                    format!("{}/archive/refs/tags/{}.tar.gz", repo_url, tag),
                    format!("{}/archive/refs/heads/{}.tar.gz", repo_url, tag),
                ];
                for branch in &["main", "master"] {
                    let u = format!("{}/archive/refs/heads/{}.tar.gz", repo_url, branch);
                    if !dl_candidates.contains(&u) { dl_candidates.push(u); }
                }
                let mut dl_ok = false;
                for url in &dl_candidates {
                    let ok = run_command_streaming_in(
                        &window, "curl",
                        &["-fL", "--progress-bar", "--stderr", "-", "--connect-timeout", "15", "--max-time", "120", "-o", &tarball, url],
                        "",
                    ).await.unwrap_or(false);
                    if ok { dl_ok = true; break; }
                }
                if dl_ok {
                    run_command_streaming_in(
                        &window, "tar",
                        &["-xzf", &tarball, "-C", &work_dir, "--strip-components=1"],
                        "",
                    ).await.unwrap_or(false);
                }

                run_command_streaming_in(
                    &window, "tar",
                    &["-xzf", &tarball, "-C", &work_dir, "--strip-components=1"],
                    "",
                ).await.unwrap_or(false);

                find_compose_file_in(&compose_dir)
            }
        } else {
            // compose_file — use the work dir path
            let work_dir = format!("/tmp/athena-nexus/{}", tool_id);
            find_compose_file_in(&work_dir)
                .or_else(|| effective_compose_file.clone())
        };

        let mut args: Vec<&str> = leading.clone();
        args.extend(["-p", &tool_id]);
        if let Some(ref path) = compose_path {
            args.extend(["-f", path.as_str()]);
        }
        args.extend(["down", "--remove-orphans", "--volumes"]);

        let full_cmd = format!("{} {}", program, args.join(" "));
        emit_progress!(window, format!("▶ {}", full_cmd));
        emit_progress!(window, "Stopping and removing containers, networks, and volumes…".to_string());
        emit_progress!(window, "(This may take 30–120s for stacks with large volumes)".to_string());

        // Determine cwd: compose dir so relative paths in compose file resolve
        let cwd = compose_path.as_ref()
            .and_then(|p| std::path::Path::new(p).parent())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        // Run with a generous timeout — large stacks (Wazuh, Greenbone) can take 2–3 min
        // to gracefully stop services and flush volumes.
        let compose_timeout = std::time::Duration::from_secs(300);
        match tokio::time::timeout(
            compose_timeout,
            run_command_streaming_in(&window, program, &args, &cwd),
        ).await {
            Ok(Ok(true))  => {},
            Ok(Ok(false)) => {
                emit_progress!(window, format!("✗ Command exited with non-zero status: {}", full_cmd));
                return Ok(CommandResult::err(format!("compose down failed for {}", tool_id)));
            }
            Ok(Err(e)) => {
                emit_progress!(window, format!("✗ Failed to run command: {}", e));
                emit_progress!(window, format!("  Command was: {}", full_cmd));
                return Ok(CommandResult::err(e));
            }
            Err(_) => {
                emit_progress!(window, format!("✗ Command timed out after {}s", compose_timeout.as_secs()));
                emit_progress!(window, format!("  Command was: {}", full_cmd));
                return Ok(CommandResult::err(format!("compose down timed out for {}", tool_id)));
            }
        }
    } else {
        let cli = runtime.cli();
        for id in &container_ids {
            let short = &id[..id.len().min(12)];
            emit_progress!(window, format!("▶ {} stop {}", cli, short));
            let _ = run_command_streaming(&window, cli, &["stop", "-t", "10", id]).await;
            emit_progress!(window, format!("▶ {} rm -f {}", cli, short));
            let _ = run_command_streaming(&window, cli, &["rm", "-f", id]).await;
            emit_progress!(window, format!("✓ Container {} removed.", short));
        }
    }

    emit_progress!(window, format!("✓ {} removed.", tool_id));
    Ok(CommandResult::ok(format!("Removed {}", tool_id)))
}

/// Find docker-compose.yml (any variant) in a directory
fn find_compose_file_in(dir: &str) -> Option<String> {
    for name in &["docker-compose.yml","docker-compose.yaml","compose.yml","compose.yaml"] {
        let path = format!("{}/{}", dir, name);
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    None
}

/// Stop a compose stack without removing containers or volumes.
///
/// Uses `compose -p <project> stop -t 15` exclusively.
/// If the compose file is found on disk, it's also passed via -f for accuracy.
/// No fallback to individual container stops — compose must work.
#[tauri::command]
pub async fn stop_compose_tool(
    window: Window,
    state: tauri::State<'_, crate::AppState>,
    tool_id: String,
    compose_file: Option<String>,
    compose_repo: Option<String>,
    _compose_repo_tag: Option<String>,
    compose_subdir: Option<String>,
    container_ids: Option<Vec<String>>,
) -> Result<CommandResult, String> {
    // Release lock immediately — compose stop can take minutes, must not hold mutex
    let runtime = { state.container.lock().await.runtime.clone() };
    let (program, leading) = runtime.compose_cmd();

    emit_progress!(window, format!("Stopping compose stack '{}'…", tool_id));

    // ── Check compose binary exists ──────────────────────── //
    if !check_command_exists(program).await {
        let hint = match runtime {
            crate::container::ContainerRuntime::Podman =>
                "Install it with: pip install podman-compose  (or use Docker runtime instead)",
            crate::container::ContainerRuntime::Docker =>
                "Docker Compose is bundled with Docker Desktop, or install the docker-compose-plugin package",
        };
        emit_progress!(window, format!("✗ '{}' command not found.", program));
        emit_progress!(window, format!("  ↳ {}", hint));
        return Ok(CommandResult::err(format!(
            "'{}' not found. {}", program, hint
        )));
    }
    emit_progress!(window, format!("Using compose binary: {}", program));

    // ── Resolve compose file on disk ─────────────────────── //
    let work_dir = format!("/tmp/athena-nexus/{}", tool_id);

    let compose_path: Option<String> = if let Some(ref path_or_url) = compose_file {
        if std::path::Path::new(path_or_url).exists() {
            emit_progress!(window, format!("Compose file: {} (local path)", path_or_url));
            Some(path_or_url.clone())
        } else {
            let found = find_compose_file_in(&work_dir);
            if let Some(ref p) = found {
                emit_progress!(window, format!("Compose file: {} (from work dir)", p));
            } else {
                emit_progress!(window, format!("Compose file not found on disk (source was: {})", path_or_url));
            }
            found
        }
    } else if compose_repo.is_some() {
        let subdir = compose_subdir.as_deref();
        let compose_dir = match subdir {
            Some(s) => format!("{}/{}", work_dir, s),
            None    => work_dir.clone(),
        };
        let found = find_compose_file_in(&compose_dir);
        if let Some(ref p) = found {
            emit_progress!(window, format!("Compose file: {} (from repo work dir)", p));
        } else {
            emit_progress!(window, format!("Compose file not found in {}", compose_dir));
        }
        found
    } else {
        let found = find_compose_file_in(&work_dir);
        if let Some(ref p) = found {
            emit_progress!(window, format!("Compose file: {}", p));
        } else {
            emit_progress!(window, "No compose file found — will use project name only.".to_string());
        }
        found
    };

    let cwd = compose_path.as_ref()
        .and_then(|p| std::path::Path::new(p).parent())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // Log container count for visibility
    let id_count = container_ids.as_ref().map(|v| v.len()).unwrap_or(0);
    emit_progress!(window, format!("Project: {}  |  Containers: {}", tool_id, id_count));

    // ── Build and run compose stop ───────────────────────── //
    let mut args: Vec<&str> = leading.clone();
    args.extend(["-p", &tool_id]);
    if let Some(ref path) = compose_path {
        args.extend(["-f", path.as_str()]);
    }
    args.extend(["stop", "-t", "15"]);

    let full_cmd = format!("{} {}", program, args.join(" "));
    emit_progress!(window, format!("▶ {}", full_cmd));

    let compose_timeout = std::time::Duration::from_secs(120);

    let result = tokio::time::timeout(
        compose_timeout,
        run_command_streaming_in(&window, program, &args, &cwd),
    ).await;

    match result {
        Ok(Ok(true)) => {
            emit_progress!(window, format!("✓ Compose stack '{}' stopped.", tool_id));
            Ok(CommandResult::ok(format!("Stopped compose stack {}", tool_id)))
        }
        Ok(Ok(false)) => {
            emit_progress!(window, format!("✗ Command exited with non-zero status: {}", full_cmd));
            Ok(CommandResult::err(format!("compose stop failed for {}", tool_id)))
        }
        Ok(Err(e)) => {
            emit_progress!(window, format!("✗ Failed to run command: {}", e));
            emit_progress!(window, format!("  Command was: {}", full_cmd));
            Ok(CommandResult::err(format!("compose stop error: {}", e)))
        }
        Err(_) => {
            emit_progress!(window, format!("✗ Command timed out after {}s", compose_timeout.as_secs()));
            emit_progress!(window, format!("  Command was: {}", full_cmd));
            let _ = cancel_active_process();
            Ok(CommandResult::err(format!("compose stop timed out for {}", tool_id)))
        }
    }
}

/// Check if a command exists on the system by trying to run it.
/// Returns true if the command is found and executable.
async fn check_command_exists(cmd: &str) -> bool {
    tokio::process::Command::new("which")
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Kill the currently active child process (used internally for timeouts).
/// Returns true if a process was killed.
fn cancel_active_process() -> bool {
    use super::cancel::{ACTIVE_PID, clear_active_pid};
    use std::sync::atomic::Ordering;
    let pid = ACTIVE_PID.load(Ordering::SeqCst);
    if pid == 0 { return false; }
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
    clear_active_pid();
    true
}

/// Pull an image with streamed progress — emits deploy:progress events line by line.
#[tauri::command]
pub async fn pull_image_streaming(
    window: Window,
    state: tauri::State<'_, crate::AppState>,
    image: String,
) -> Result<CommandResult, String> {
    let cli = state.container.lock().await.runtime.cli();
    emit_progress!(window, format!("[{}] Pulling {}…", cli, image));
    let ok = run_command_streaming(&window, cli, &["pull", &image]).await?;
    if ok {
        emit_progress!(window, format!("Pull complete: {}", image));
        Ok(CommandResult::ok(format!("Pulled {}", image)))
    } else {
        Ok(CommandResult::err(format!("Failed to pull {}", image)))
    }
}
