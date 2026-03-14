// ═══════════════════════════════════════════════════════════
// deploy/mod.rs — Tool deployment logic
//
// Handles:
//   - Single image: podman pull + podman run
//   - Compose stack: download compose file + podman-compose up
//   - Port availability checks
//   - Progress events streamed to the frontend
// ═══════════════════════════════════════════════════════════

pub mod commands;
pub mod cancel;

use std::net::TcpListener;

/// Check if a TCP port is already in use on localhost.
/// Returns true only if the port is genuinely occupied (EADDRINUSE).
/// EACCES on privileged ports (<1024) means the port is free but requires
/// root to bind — this is NOT the same as "in use".
pub fn is_port_in_use(port: u16) -> bool {
    match TcpListener::bind(("0.0.0.0", port)) {
        Ok(_) => false,  // Successfully bound → definitely free
        Err(e) => match e.kind() {
            // Permission denied: privileged port, but nothing is listening
            std::io::ErrorKind::PermissionDenied => false,
            // Address already in use: something is genuinely listening
            std::io::ErrorKind::AddrInUse => true,
            // Any other error: be conservative and assume free
            _ => false,
        },
    }
}
