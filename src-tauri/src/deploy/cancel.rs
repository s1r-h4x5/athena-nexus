// ── deploy/cancel.rs ──────────────────────────────────────────
// Tracks the PID of the currently running deploy/pull process
// so it can be killed on user request.

use std::sync::atomic::{AtomicU32, Ordering};
use tauri::command;

/// PID of the active child process (0 = none)
pub(crate) static ACTIVE_PID: AtomicU32 = AtomicU32::new(0);

pub fn set_active_pid(pid: u32) {
    ACTIVE_PID.store(pid, Ordering::SeqCst);
}

pub fn clear_active_pid() {
    ACTIVE_PID.store(0, Ordering::SeqCst);
}

/// Kill the currently active deploy/pull process.
#[command]
pub fn cancel_deploy() -> bool {
    let pid = ACTIVE_PID.load(Ordering::SeqCst);
    if pid == 0 { return false; }
    // Send SIGTERM then SIGKILL
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
    clear_active_pid();
    true
}
