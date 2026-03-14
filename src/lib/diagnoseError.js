// ── diagnoseError.js ─────────────────────────────────────────
// Maps well-known Podman / compose error strings to human-readable hints.
// Returns a hint string, or null if the line is not a recognised pattern.

export function diagnoseError(line) {
  if (/netavark.*veth|Operation not supported.*95|os error 95/i.test(line))
    return "Host kernel lacks NET_ADMIN / veth support. Try: sudo modprobe veth  — or run Podman outside a restricted VM/container.";

  if (/is not a valid restart policy/i.test(line))
    return "Compose file uses a restart value Podman doesn't support (e.g. 'False'). Edit the compose file and change restart to 'no', 'always', or 'on-failure'.";

  if (/received unexpected HTTP status: 500/i.test(line))
    return "Registry returned 500 — the remote image registry is temporarily unavailable. Try again later.";

  if (/is not a valid container.*dependency|no container with name or ID.*found/i.test(line))
    return "A dependency container failed to start (likely caused by a networking or registry error above).";

  if (/manifest unknown|not found.*manifest/i.test(line))
    return "Image tag not found on the registry — the image name or tag in the compose file may be wrong.";

  if (/permission denied.*socket|connect.*permission denied/i.test(line))
    return "Podman socket permission denied. Run: systemctl --user start podman.socket";

  if (/no space left on device/i.test(line))
    return "Disk is full. Free up space and try again.";

  if (/pull access denied|unauthorized.*authentication/i.test(line))
    return "Registry authentication required. Run: podman login <registry>";

  return null;
}
