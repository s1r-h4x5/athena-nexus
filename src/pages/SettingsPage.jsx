// ═══════════════════════════════════════════════════════════
// pages/SettingsPage.jsx — M11: Settings + Config Import/Export
//
// Three tabs:
//   General   — Podman socket, poll intervals, notifications
//   Export    — export full config bundle to JSON
//   Import    — load + preview a bundle before applying
// ═══════════════════════════════════════════════════════════

import React, {
  useCallback, useEffect, useRef, useState,
} from "react";
import {
  Settings, Download, Upload, RefreshCw, Check, X, RotateCcw,
  AlertTriangle, CheckCircle, Save, FolderOpen,
  Eye, EyeOff, ChevronRight, FileJson, Lock,
  Camera, ClipboardList, Wrench, Info,
} from "lucide-react";
import TopBar from "../components/TopBar";
import { IS_TAURI } from "../lib/container";
import "./SettingsPage.css";

// ── Tauri invoke bridge ───────────────────────────────────── //
async function invoke(cmd, args = {}) {
  if (IS_TAURI) {
    const { invoke: ti } = await import("@tauri-apps/api/core");
    return ti(cmd, args);
  }
  return mockSettings(cmd, args);
}

// ── Mock ──────────────────────────────────────────────────── //
const _mockConfig = {
  version: "1",
  podman_socket: "/run/user/1000/podman/podman.sock",
  docker_socket: "/var/run/docker.sock",
  container_runtime: "podman",
  categories: [],
  tool_definitions: [],
  network_assignments: {},
  settings: {
    theme: "dark",
    poll_interval_secs: 5,
    log_tail_lines: 200,
    notifications_enabled: true,
    auto_update_check: false,
  },
};

async function mockSettings(cmd, args) {
  await new Promise(r => setTimeout(r, 120));
  switch (cmd) {
    case "load_config":  return { ..._mockConfig };
    case "save_config":  Object.assign(_mockConfig, args.config); return null;
    case "detect_runtimes": return [
      { runtime: "podman", socket_path: "/run/user/1000/podman/podman.sock", available: true,  default_socket: "/run/user/1000/podman/podman.sock" },
      { runtime: "docker", socket_path: "/var/run/docker.sock",              available: false, default_socket: "/var/run/docker.sock" },
    ];
    case "config_default_export_dir": return "/home/user";
    case "config_export":
      return `/home/user/athena-nexus-config-${new Date().toISOString().slice(0,10)}.json`;
    case "config_import_preview":
      return {
        export_version: "1",
        exported_at: "2024-03-01T10:00:00Z",
        app_config: _mockConfig,
        vault_keys: [
          { key: "openvas-pass", name: "OpenVAS Password", kind: "password", env_var: "OPENVAS_ADMIN_PASS", tool_ids: ["openvas"], description: "", created_at: "", updated_at: "" },
          { key: "wazuh-api-key", name: "Wazuh API Key",   kind: "api_key",  env_var: "WAZUH_API_KEY",     tool_ids: ["wazuh"],   description: "", created_at: "", updated_at: "" },
        ],
        snapshots: [
          { id: "snap-001", tool_id: "openvas", tool_name: "Greenbone OpenVAS", container_ids: ["abc"], image_names: [], tar_path: null, note: "Before upgrade", size_bytes: null, created_at: "2024-03-01T09:00:00Z", exported: false },
        ],
      };
    case "config_import_apply": return null;
    default: return null;
  }
}

// ── Tabs ──────────────────────────────────────────────────── //
const TABS = [
  { id: "general", label: "General",         Icon: Settings  },
  { id: "export",  label: "Export Config",   Icon: Download  },
  { id: "import",  label: "Import Config",   Icon: Upload    },
];

// ── Field row ─────────────────────────────────────────────── //
function FieldRow({ label, hint, children }) {
  return (
    <div className="sf-field">
      <div className="sf-field__left">
        <div className="sf-field__label">{label}</div>
        {hint && <div className="sf-field__hint">{hint}</div>}
      </div>
      <div className="sf-field__right">{children}</div>
    </div>
  );
}

// ── Registry path section ─────────────────────────────────── //
function RegistryPathSection() {
  const defaultPath = "~/.config/athena-nexus/tools.json";
  const [activePath, setActivePath] = useState(null);
  const [editPath,   setEditPath]   = useState("");
  const [editing,    setEditing]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState(null);
  const [saved,      setSaved]      = useState(false);

  useEffect(() => {
    invoke("registry_file_path").then(p => {
      setActivePath(p);
      setEditPath(p);
    }).catch(() => {});
  }, []);

  async function handleBrowse() {
    if (!IS_TAURI) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "Select tools.json registry file",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (picked) { setEditPath(picked); setEditing(true); }
    } catch (_) {}
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const newPath = await invoke("set_registry_path", { path: editPath });
      setActivePath(newPath);
      setEditPath(newPath);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setEditPath("");
    setSaving(true);
    setError(null);
    try {
      const newPath = await invoke("set_registry_path", { path: "" });
      setActivePath(newPath);
      setEditPath(newPath);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!activePath) return null;

  const isCustom = activePath !== defaultPath && !activePath.endsWith("/.config/athena-nexus/tools.json");
  const isDirty  = editing && editPath !== activePath;

  return (
    <div className="sf-section">
      <div className="sf-section__heading">TOOL REGISTRY</div>

      <div className="sf-field-block">
        <div className="sf-field-block__label">Registry File</div>
        <div className="sf-field-block__hint">
          Path to the <code>tools.json</code> file. Edit it to add, remove or customise tools.
          Changes take effect on next app launch.
        </div>

        <div className="sf-registry-row">
          <input
            className={`sf-input sf-registry-input ${error ? "sf-input--error" : ""}`}
            value={editPath}
            onChange={e => { setEditPath(e.target.value); setEditing(true); setError(null); }}
            spellCheck={false}
          />
          <button className="sf-btn sf-btn--icon" onClick={handleBrowse} title="Browse…">
            <FolderOpen size={14} />
          </button>
        </div>

        {error && <div className="sf-registry-error"><AlertTriangle size={11} /> {error}</div>}

        <div className="sf-registry-actions">
          {isCustom && (
            <button className="sf-btn sf-btn--ghost sf-btn--sm" onClick={handleReset} disabled={saving}>
              <RotateCcw size={11} /> Reset to default
            </button>
          )}
          <button
            className="sf-btn sf-btn--primary sf-btn--sm"
            onClick={handleSave}
            disabled={saving || (!isDirty && !error)}
          >
            {saving ? <><RefreshCw size={11} className="spin" /> Saving…</>
            : saved  ? <><Check size={11} /> Saved</>
            : <><Check size={11} /> Apply</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Runtime selector section ──────────────────────────────── //
function RuntimeSection({ config, onChange }) {
  const [runtimes, setRuntimes]   = useState([]);
  const [detecting, setDetecting] = useState(false);

  function detect() {
    setDetecting(true);
    invoke("detect_runtimes").then(r => {
      setRuntimes(r || []);
    }).catch(() => {}).finally(() => setDetecting(false));
  }

  useEffect(() => {
    detect();
    // Re-probe every 3 s so the availability dot updates when a daemon starts or stops
    const timer = setInterval(detect, 3000);
    return () => clearInterval(timer);
  }, []);

  const current = config.container_runtime || "podman";
  const currentRuntime = runtimes.find(r => r.runtime === current);

  function selectRuntime(rt) {
    const info = runtimes.find(r => r.runtime === rt);
    onChange({
      ...config,
      container_runtime: rt,
      // Auto-fill the socket field with the detected default if user hasn't set one
      ...(rt === "docker" && !config.docker_socket && info
        ? { docker_socket: info.default_socket }
        : {}),
      ...(rt === "podman" && !config.podman_socket && info
        ? { podman_socket: info.default_socket }
        : {}),
    });
  }

  return (
    <div className="sf-section">
      <div className="sf-section__heading">CONTAINER RUNTIME</div>

      <div className="sf-runtime-cards">
        {["docker", "podman"].map(rt => {
          const info    = runtimes.find(r => r.runtime === rt);
          const active  = current === rt;
          const avail   = info?.available ?? false;
          return (
            <button
              key={rt}
              className={`sf-runtime-card ${active ? "sf-runtime-card--active" : ""} ${!avail ? "sf-runtime-card--unavailable" : ""}`}
              onClick={() => selectRuntime(rt)}
              title={info?.socket_path || ""}
            >
              <div className="sf-runtime-card__header">
                <span className="sf-runtime-card__name">{rt === "podman" ? "Podman" : "Docker"}</span>
                <div className="sf-runtime-card__right">
                  {active && <span className="sf-runtime-card__active-label">ACTIVE</span>}
                  <span className={`sf-runtime-card__dot ${avail ? "sf-runtime-card__dot--on" : "sf-runtime-card__dot--off"}`} />
                </div>
              </div>
              <div className="sf-runtime-card__socket mono">
                {detecting ? "detecting…" : (info?.socket_path || "not found")}
              </div>
              {!avail && <div className="sf-runtime-card__warn">socket not found</div>}
            </button>
          );
        })}
      </div>

      {/* Socket override for active runtime */}
      <div className="sf-field-block" style={{ marginTop: 12 }}>
        <div className="sf-field-block__label">
          {current === "docker" ? "Docker" : "Podman"} Socket Path
        </div>
        <div className="sf-field-block__hint">
          Override the auto-detected socket path. Leave blank to use the detected default.
        </div>
        <input
          className="sf-input sf-input--mono"
          value={current === "docker" ? (config.docker_socket || "") : (config.podman_socket || "")}
          onChange={e => onChange({
            ...config,
            ...(current === "docker"
              ? { docker_socket: e.target.value }
              : { podman_socket: e.target.value }),
          })}
          placeholder={currentRuntime?.default_socket || ""}
        />
      </div>

      {current === "docker" && (
        <div className="sf-runtime-note">
          <span>ℹ</span>
          Docker Compose stacks use <code>docker compose</code>. Ensure the Docker Engine
          is running and your user is in the <code>docker</code> group.
        </div>
      )}
      {current === "podman" && (
        <div className="sf-runtime-note">
          <span>ℹ</span>
          Compose stacks use <code>podman-compose</code>. Rootless mode is recommended.
          Enable the socket with: <code>systemctl --user enable --now podman.socket</code>
        </div>
      )}
    </div>
  );
}

// ── General settings tab ──────────────────────────────────── //
function GeneralTab({ config, onChange, onSave, saving, saved }) {
  if (!config) return <div className="sf-loading"><RefreshCw size={16} className="spin" /> Loading…</div>;

  const s = config.settings;

  return (
    <div className="sf-section-list">
      <RuntimeSection config={config} onChange={onChange} />

      <div className="sf-section">
        <div className="sf-section__heading">POLLING</div>

        <FieldRow label="Container Poll Interval" hint="How often to refresh the container list">
          <div className="sf-input-unit">
            <input
              className="sf-input sf-input--short"
              type="number" min="1" max="60"
              value={s.poll_interval_secs}
              onChange={e => onChange({ ...config, settings: { ...s, poll_interval_secs: parseInt(e.target.value) || 5 } })}
            />
            <span className="sf-unit">seconds</span>
          </div>
        </FieldRow>

        <FieldRow label="Log Tail Lines" hint="Number of log lines fetched per container">
          <div className="sf-input-unit">
            <input
              className="sf-input sf-input--short"
              type="number" min="50" max="5000" step="50"
              value={s.log_tail_lines}
              onChange={e => onChange({ ...config, settings: { ...s, log_tail_lines: parseInt(e.target.value) || 200 } })}
            />
            <span className="sf-unit">lines</span>
          </div>
        </FieldRow>
      </div>

      <div className="sf-section">
        <div className="sf-section__heading">BEHAVIOUR</div>

        <FieldRow label="Desktop Notifications" hint="Show system notifications for container state changes">
          <button
            className={`sf-toggle ${s.notifications_enabled ? "sf-toggle--on" : ""}`}
            onClick={() => onChange({ ...config, settings: { ...s, notifications_enabled: !s.notifications_enabled } })}
          >
            <span className="sf-toggle__knob" />
          </button>
        </FieldRow>

        <FieldRow label="Auto-check for Updates" hint="Periodically check if newer tool images are available">
          <button
            className={`sf-toggle ${s.auto_update_check ? "sf-toggle--on" : ""}`}
            onClick={() => onChange({ ...config, settings: { ...s, auto_update_check: !s.auto_update_check } })}
          >
            <span className="sf-toggle__knob" />
          </button>
        </FieldRow>
      </div>

      <RegistryPathSection />

      <div className="sf-save-row">
        <button className="sf-btn sf-btn--primary" onClick={onSave} disabled={saving}>
          {saving  ? <><RefreshCw size={12} className="spin" /> Saving…</>
          : saved  ? <><Check size={12} /> Saved</>
          : <><Save size={12} /> Save Settings</>}
        </button>
      </div>
    </div>
  );
}

// ── Export tab ────────────────────────────────────────────── //
function ExportTab() {
  const [destPath, setDestPath] = useState("");
  const [exporting, setExporting] = useState(false);
  const [result,    setResult]    = useState(null);
  const [error,     setError]     = useState(null);

  useEffect(() => {
    invoke("config_default_export_dir").then(d => setDestPath(d || ""));
  }, []);

  async function handleBrowseExport() {
    if (!IS_TAURI) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({
        title: "Export Athena Nexus Config",
        defaultPath: destPath || "athena-nexus-config.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (picked) setDestPath(picked);
    } catch (_) {}
  }

  async function handleExport() {
    setExporting(true);
    setError(null);
    setResult(null);
    try {
      const path = await invoke("config_export", { destPath: destPath });
      setResult(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="sf-section-list">
      <div className="sf-section">
        <div className="sf-section__heading">EXPORT CONFIGURATION BUNDLE</div>
        <p className="sf-section__desc">
          Exports your full Athena Nexus configuration to a portable JSON file. Includes app settings,
          tool definitions, network assignments, vault key metadata (not values), and snapshot records.
        </p>

        <div className="sf-bundle-contents">
          <div className="sf-bundle-item"><Settings size={12} /> App settings &amp; Podman socket</div>
          <div className="sf-bundle-item"><Wrench   size={12} /> User-defined tool definitions</div>
          <div className="sf-bundle-item"><Lock     size={12} /> Vault key metadata (keys/names/env vars only — no secret values)</div>
          <div className="sf-bundle-item"><Camera   size={12} /> Snapshot records (metadata only — no .tar files)</div>
          <div className="sf-bundle-item sf-bundle-item--excluded">
            <X size={12} /> Secret values are never exported
          </div>
        </div>

        <FieldRow label="Destination" hint="Directory or full file path for the export">
          <div className="sf-path-row">
            <input
              className="sf-input sf-input--path"
              value={destPath}
              onChange={e => setDestPath(e.target.value)}
              placeholder="/home/user/athena-nexus-config.json"
            />
            {IS_TAURI && (
              <button className="sf-btn sf-btn--browse" onClick={handleBrowseExport} title="Browse">
                Browse
              </button>
            )}
          </div>
        </FieldRow>

        {result && (
          <div className="sf-banner sf-banner--success">
            <CheckCircle size={13} />
            <div>
              <strong>Exported successfully</strong>
              <code>{result}</code>
            </div>
            <button onClick={() => setResult(null)}><X size={11} /></button>
          </div>
        )}
        {error && (
          <div className="sf-banner sf-banner--error">
            <AlertTriangle size={13} /> {error}
            <button onClick={() => setError(null)}><X size={11} /></button>
          </div>
        )}

        <div className="sf-save-row">
          <button className="sf-btn sf-btn--primary" onClick={handleExport} disabled={exporting || !destPath}>
            {exporting
              ? <><RefreshCw size={12} className="spin" /> Exporting…</>
              : <><Download size={12} /> Export Bundle</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Import tab ────────────────────────────────────────────── //
function ImportTab() {
  const [srcPath,   setSrcPath]   = useState("");
  const [previewing,setPreviewing]= useState(false);
  const [applying,  setApplying]  = useState(false);
  const [preview,   setPreview]   = useState(null);
  const [applied,   setApplied]   = useState(false);
  const [error,     setError]     = useState(null);

  async function handleBrowseImport() {
    if (!IS_TAURI) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "Select Athena Nexus Config Bundle",
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (picked) { setSrcPath(picked); setPreview(null); setApplied(false); }
    } catch (_) {}
  }

  async function handlePreview() {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    setApplied(false);
    try {
      const bundle = await invoke("config_import_preview", { srcPath: srcPath });
      setPreview(bundle);
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleApply() {
    if (!preview) return;
    setApplying(true);
    setError(null);
    try {
      await invoke("config_import_apply", { bundle: preview });
      setApplied(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="sf-section-list">
      <div className="sf-section">
        <div className="sf-section__heading">IMPORT CONFIGURATION BUNDLE</div>
        <p className="sf-section__desc">
          Load a previously exported bundle. Settings will be replaced; vault keys and snapshots are
          merged (existing records are never overwritten).
        </p>

        <FieldRow label="Bundle File" hint="Path to an athena-nexus-config-*.json file">
          <div className="sf-path-row">
            <input
              className="sf-input sf-input--path"
              value={srcPath}
              onChange={e => { setSrcPath(e.target.value); setPreview(null); setApplied(false); }}
              placeholder="/home/user/athena-nexus-config-2024-03-01.json"
            />
            {IS_TAURI && (
              <button className="sf-btn sf-btn--browse" onClick={handleBrowseImport} title="Browse">
                Browse
              </button>
            )}
          </div>
        </FieldRow>

        {error && (
          <div className="sf-banner sf-banner--error">
            <AlertTriangle size={13} /> {error}
            <button onClick={() => setError(null)}><X size={11} /></button>
          </div>
        )}
        {applied && (
          <div className="sf-banner sf-banner--success">
            <CheckCircle size={13} />
            <div><strong>Import applied.</strong> Restart the app to reload all settings.</div>
          </div>
        )}

        <div className="sf-save-row" style={{ gap: 8 }}>
          <button
            className="sf-btn sf-btn--ghost"
            onClick={handlePreview}
            disabled={previewing || !srcPath}
          >
            {previewing
              ? <><RefreshCw size={12} className="spin" /> Loading…</>
              : <><Eye size={12} /> Preview Bundle</>}
          </button>
          {preview && !applied && (
            <button className="sf-btn sf-btn--primary" onClick={handleApply} disabled={applying}>
              {applying
                ? <><RefreshCw size={12} className="spin" /> Applying…</>
                : <><Upload size={12} /> Apply Import</>}
            </button>
          )}
        </div>
      </div>

      {/* Preview panel */}
      {preview && (
        <div className="sf-preview">
          <div className="sf-section__heading">BUNDLE PREVIEW</div>
          <div className="sf-preview__meta">
            <span>Exported {preview.exported_at?.slice(0, 10)}</span>
            <span>·</span>
            <span>Bundle v{preview.export_version}</span>
          </div>

          <div className="sf-preview-grid">
            {/* Settings summary */}
            <div className="sf-preview-card">
              <div className="sf-preview-card__heading"><Settings size={11} /> Settings</div>
              <div className="sf-preview-row">
                <span>Socket</span>
                <code>{preview.app_config.podman_socket || "default"}</code>
              </div>
              <div className="sf-preview-row">
                <span>Poll interval</span>
                <code>{preview.app_config.settings.poll_interval_secs}s</code>
              </div>
              <div className="sf-preview-row">
                <span>Log lines</span>
                <code>{preview.app_config.settings.log_tail_lines}</code>
              </div>
              <div className="sf-preview-row">
                <span>Notifications</span>
                <code>{preview.app_config.settings.notifications_enabled ? "on" : "off"}</code>
              </div>
            </div>

            {/* Tool definitions */}
            <div className="sf-preview-card">
              <div className="sf-preview-card__heading"><Wrench size={11} /> Tool Definitions</div>
              {preview.app_config.tool_definitions.length === 0
                ? <div className="sf-preview-empty">None</div>
                : preview.app_config.tool_definitions.map(t => (
                  <div key={t.id} className="sf-preview-row">
                    <span>{t.name}</span>
                    <code>{t.id}</code>
                  </div>
                ))}
            </div>

            {/* Vault keys */}
            <div className="sf-preview-card">
              <div className="sf-preview-card__heading"><Lock size={11} /> Vault Keys ({preview.vault_keys.length})</div>
              {preview.vault_keys.length === 0
                ? <div className="sf-preview-empty">None</div>
                : preview.vault_keys.map(k => (
                  <div key={k.key} className="sf-preview-row">
                    <span>{k.name}</span>
                    <code>${k.env_var}</code>
                  </div>
                ))}
            </div>

            {/* Snapshots */}
            <div className="sf-preview-card">
              <div className="sf-preview-card__heading"><Camera size={11} /> Snapshots ({preview.snapshots.length})</div>
              {preview.snapshots.length === 0
                ? <div className="sf-preview-empty">None</div>
                : preview.snapshots.map(s => (
                  <div key={s.id} className="sf-preview-row">
                    <span>{s.tool_name}</span>
                    <code>{s.created_at?.slice(0, 10)}</code>
                  </div>
                ))}
            </div>
          </div>

          <div className="sf-import-warning">
            <Info size={12} />
            Applying will replace your current settings. Vault keys and snapshots will be merged
            (existing entries are never overwritten). Secret values are not included in bundles —
            you will need to re-enter them in the Vault after import.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────── //
export default function SettingsPage({ initialTab, onTabChange }) {
  const [tab, setTab] = useState(initialTab || "general");

  // Sync when parent changes initialTab (e.g. TopBar Export/Import clicked while already on Settings)
  useEffect(() => {
    if (initialTab && initialTab !== tab) {
      setTab(initialTab);
    }
  }, [initialTab]);
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState(null);
  const savedTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const cfg = await invoke("load_config");
      setConfig(cfg);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("save_config", { config });
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sf-page">
      <TopBar title="Settings"
        titleIcon="Settings" onRefresh={load} />

      {/* Tab bar */}
      <div className="sf-tabs">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`sf-tab ${tab === id ? "sf-tab--active" : ""}`}
            onClick={() => setTab(id)}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="sf-banner sf-banner--error" style={{ margin: "0 20px" }}>
          <AlertTriangle size={13} /> {error}
          <button onClick={() => setError(null)}><X size={11} /></button>
        </div>
      )}

      {/* Tab content */}
      <div className="sf-body">
        {tab === "general" && (
          <GeneralTab
            config={config}
            onChange={setConfig}
            onSave={handleSave}
            saving={saving}
            saved={saved}
          />
        )}
        {tab === "export" && <ExportTab />}
        {tab === "import" && <ImportTab />}
      </div>
    </div>
  );
}
