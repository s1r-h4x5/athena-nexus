import React from "react";
import "./PlaceholderPage.css";

export function VaultPage() {
  return (
    <div className="placeholder-page">
      <div className="placeholder-page__content">
        <span className="placeholder-page__tag">// MODULE 7</span>
        <h2 className="placeholder-page__title">Secrets Vault</h2>
        <p className="placeholder-page__desc">
          Encrypted local store backed by OS keyring (libsecret). Manage API keys,
          passwords, and TLS certificates. Secrets are injected as environment
          variables at container start — never stored in plain text.
        </p>
        <div className="placeholder-page__status">Pending implementation</div>
      </div>
    </div>
  );
}

export function AuditPage() {
  return (
    <div className="placeholder-page">
      <div className="placeholder-page__content">
        <span className="placeholder-page__tag">// MODULE 12</span>
        <h2 className="placeholder-page__title">Audit Log</h2>
        <p className="placeholder-page__desc">
          Append-only timestamped history of all infrastructure actions.
          Exportable as CSV or JSON for compliance and accountability.
        </p>
        <div className="placeholder-page__status">Pending implementation</div>
      </div>
    </div>
  );
}

// RegistryPage moved to src/pages/RegistryPage.jsx (Module 3)

export function SettingsPage() {
  return (
    <div className="placeholder-page">
      <div className="placeholder-page__content">
        <span className="placeholder-page__tag">// SETTINGS</span>
        <h2 className="placeholder-page__title">Settings</h2>
        <p className="placeholder-page__desc">
          Configure Podman socket path, resource limits, update intervals,
          notification preferences, and application behavior.
        </p>
        <div className="placeholder-page__status">Pending implementation</div>
      </div>
    </div>
  );
}
