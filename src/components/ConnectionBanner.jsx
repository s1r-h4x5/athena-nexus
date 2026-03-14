import React, { useState } from "react";
import { AlertTriangle, RefreshCw, Terminal } from "lucide-react";
import "./ConnectionBanner.css";

// Hint shown below the error message — differs by runtime
const RUNTIME_HINTS = {
  podman: {
    title:   "Podman socket unreachable",
    command: "systemctl --user enable --now podman.socket",
  },
  docker: {
    title:   "Docker socket unreachable",
    command: "sudo systemctl start docker",
  },
};

export default function ConnectionBanner({ error, onRetry, runtime = "podman" }) {
  const [retrying, setRetrying] = useState(false);

  async function handleRetry() {
    setRetrying(true);
    await onRetry?.();
    setTimeout(() => setRetrying(false), 1500);
  }

  const hint = RUNTIME_HINTS[runtime] ?? RUNTIME_HINTS.podman;

  return (
    <div className="conn-banner">
      <div className="conn-banner__icon">
        <AlertTriangle size={18} />
      </div>
      <div className="conn-banner__body">
        <span className="conn-banner__title">{hint.title}</span>
        <span className="conn-banner__msg">{error}</span>
        <div className="conn-banner__hint">
          <Terminal size={11} />
          <code>{hint.command}</code>
        </div>
      </div>
      <button
        className={`conn-banner__btn ${retrying ? "conn-banner__btn--spin" : ""}`}
        onClick={handleRetry}
        disabled={retrying}
        title="Retry connection"
      >
        <RefreshCw size={14} />
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
