// ═══════════════════════════════════════════════════════════
// pages/VaultPage.jsx — M7: Secrets Vault
//
// OS-keyring-backed store for API keys, passwords, tokens.
// Secrets are NEVER stored on disk — values live only in
// libsecret/GNOME Keyring/KWallet (Linux) or Keychain (macOS).
//
// UI:
//   - List of all secrets (metadata only, value hidden)
//   - Add / Edit / Delete
//   - "Reveal" button to show value once via Tauri invoke
//   - Tool association picker
//   - Kind icons (api_key, password, token, cert, env, other)
// ═══════════════════════════════════════════════════════════

import React, {
  useCallback, useEffect, useRef, useState,
} from "react";
import {
  Plus, Eye, EyeOff, Trash2, Edit3, X, Check,
  Key, Lock, Shield, FileCode, Terminal, HelpCircle,
  RefreshCw, Copy, ChevronDown, ChevronUp, AlertTriangle,
  Layers,
} from "lucide-react";
import TopBar from "../components/TopBar";
import ThemedSelect from "../components/ThemedSelect";
import { useContainer } from "../context/ContainerContext";
import { IS_TAURI } from "../lib/container";
import "./VaultPage.css";

// ── Tauri invoke wrapper ──────────────────────────────────── //
async function invoke(cmd, args = {}) {
  if (IS_TAURI) {
    const { invoke: ti } = await import("@tauri-apps/api/core");
    return ti(cmd, args);
  }
  return mockVault(cmd, args);
}

// ── Mock vault for browser dev ────────────────────────────── //
let _mockSecrets = [
  { key: "openvas-admin-pass", name: "OpenVAS Admin Password", description: "Admin password for the Greenbone web UI", tool_ids: ["openvas"], kind: "password", env_var: "OPENVAS_ADMIN_PASS", created_at: "2024-03-01T10:00:00Z", updated_at: "2024-03-01T10:00:00Z", has_value: true },
  { key: "wazuh-api-key",      name: "Wazuh API Key",          description: "JWT token for the Wazuh REST API",          tool_ids: ["wazuh"],   kind: "api_key",  env_var: "WAZUH_API_KEY",      created_at: "2024-03-02T09:15:00Z", updated_at: "2024-03-05T14:22:00Z", has_value: true },
  { key: "misp-auth-key",      name: "MISP Auth Key",           description: "MISP user auth key for API access",         tool_ids: ["misp"],    kind: "token",    env_var: "MISP_AUTH_KEY",      created_at: "2024-03-03T11:30:00Z", updated_at: "2024-03-03T11:30:00Z", has_value: true },
];
let _mockCounter = 3;

async function mockVault(cmd, args) {
  await new Promise(r => setTimeout(r, 160)); // simulate latency
  switch (cmd) {
    case "vault_list":   return _mockSecrets.map(s => ({ ...s }));
    case "vault_create": {
      const rec = { ...args, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), has_value: !!args.value };
      delete rec.value;
      _mockSecrets.push(rec);
      return { ...rec };
    }
    case "vault_update": {
      _mockSecrets = _mockSecrets.map(s => s.key === args.key ? { ...s, ...args, value: undefined, updated_at: new Date().toISOString(), has_value: args.value ? true : s.has_value } : s);
      return _mockSecrets.find(s => s.key === args.key);
    }
    case "vault_delete": {
      _mockSecrets = _mockSecrets.filter(s => s.key !== args.key);
      return null;
    }
    case "vault_get_value": return `mock-secret-value-for-${args.key}`;
    default: return null;
  }
}

// ── Kind config ───────────────────────────────────────────── //
const KINDS = [
  { value: "api_key",  label: "API Key",    Icon: Key },
  { value: "password", label: "Password",   Icon: Lock },
  { value: "token",    label: "Token",      Icon: Shield },
  { value: "cert",     label: "Certificate",Icon: FileCode },
  { value: "env",      label: "Env Var",    Icon: Terminal },
  { value: "other",    label: "Other",      Icon: HelpCircle },
];

function KindIcon({ kind, size = 13 }) {
  const cfg = KINDS.find(k => k.value === kind) || KINDS[5];
  const { Icon } = cfg;
  return <Icon size={size} />;
}

// ── Secret row ────────────────────────────────────────────── //
function SecretRow({ secret, tools, onEdit, onDelete, onReveal }) {
  const [revealed,  setRevealed]  = useState(false);
  const [value,     setValue]     = useState(null);
  const [revealing, setRevealing] = useState(false);
  const [copied,    setCopied]    = useState(false);
  const [expanded,  setExpanded]  = useState(false);

  async function handleReveal() {
    if (revealed) { setRevealed(false); setValue(null); return; }
    setRevealing(true);
    try {
      const v = await onReveal(secret.key);
      setValue(v);
      setRevealed(true);
    } finally {
      setRevealing(false);
    }
  }

  async function handleCopy() {
    try {
      const v = value || await onReveal(secret.key);
      await navigator.clipboard.writeText(v);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* silent */ }
  }

  const linkedTools = tools.filter(t => secret.tool_ids?.includes(t.id));

  return (
    <div className={`vault-row ${expanded ? "vault-row--expanded" : ""}`}>
      <div className="vault-row__main" onClick={() => setExpanded(e => !e)}>
        {/* Kind icon */}
        <div className={`vault-row__kind vault-row__kind--${secret.kind}`}>
          <KindIcon kind={secret.kind} />
        </div>

        {/* Name + meta */}
        <div className="vault-row__info">
          <div className="vault-row__name">{secret.name}</div>
          <div className="vault-row__meta">
            <span className="vault-row__key">{secret.key}</span>
            {secret.env_var && (
              <span className="vault-row__env">${secret.env_var}</span>
            )}
            {!secret.has_value && (
              <span className="vault-row__no-value">
                <AlertTriangle size={10} /> no value stored
              </span>
            )}
          </div>
        </div>

        {/* Tool badges */}
        <div className="vault-row__tools">
          {linkedTools.slice(0, 3).map(t => (
            <span key={t.id} className="vault-row__tool-badge">{t.name}</span>
          ))}
          {linkedTools.length > 3 && (
            <span className="vault-row__tool-badge">+{linkedTools.length - 3}</span>
          )}
        </div>

        {/* Expand chevron */}
        <div className="vault-row__chevron">
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="vault-row__detail">
          {secret.description && (
            <p className="vault-row__desc">{secret.description}</p>
          )}

          {/* Value reveal row */}
          <div className="vault-row__value-row">
            <span className="vault-row__value-label">VALUE</span>
            <div className="vault-row__value-field">
              <span className="vault-row__value-text">
                {revealed && value ? value : "••••••••••••••••"}
              </span>
            </div>
            <button
              className="vault-icon-btn"
              onClick={handleReveal}
              disabled={revealing}
              title={revealed ? "Hide value" : "Reveal value"}
            >
              {revealing
                ? <RefreshCw size={12} className="spin" />
                : revealed ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button
              className="vault-icon-btn"
              onClick={handleCopy}
              title="Copy to clipboard"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>

          <div className="vault-row__timestamps">
            <span>Created {secret.created_at?.slice(0, 10)}</span>
            {secret.updated_at !== secret.created_at && (
              <span>· Updated {secret.updated_at?.slice(0, 10)}</span>
            )}
          </div>

          {/* Actions */}
          <div className="vault-row__actions">
            <button className="vault-btn vault-btn--edit" onClick={() => onEdit(secret)}>
              <Edit3 size={12} /> Edit
            </button>
            <button className="vault-btn vault-btn--delete" onClick={() => onDelete(secret.key)}>
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Secret form modal ─────────────────────────────────────── //
const EMPTY_FORM = { key: "", name: "", description: "", kind: "api_key", env_var: "", value: "", tool_ids: [] };

function SecretForm({ initial, tools, onSave, onClose, loading }) {
  const isEdit = !!initial?.key;
  const [form, setForm] = useState(initial ? { ...EMPTY_FORM, ...initial, value: "" } : { ...EMPTY_FORM });
  const [showVal, setShowVal] = useState(false);
  const [errors, setErrors] = useState({});

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
    if (errors[field]) setErrors(e => ({ ...e, [field]: null }));
  }

  function autoEnvVar(key) {
    return key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  }

  function handleKeyChange(v) {
    set("key", v);
    if (!isEdit && !form.env_var) {
      set("env_var", autoEnvVar(v));
    }
  }

  function validate() {
    const e = {};
    if (!form.key.trim())   e.key   = "Key is required.";
    if (!form.name.trim())  e.name  = "Name is required.";
    if (!isEdit && !form.value.trim()) e.value = "Value is required for new secrets.";
    if (form.key && !/^[a-z0-9-_]+$/.test(form.key)) e.key = "Key must be lowercase letters, numbers, hyphens or underscores.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit() {
    if (validate()) onSave(form);
  }

  function toggleTool(id) {
    set("tool_ids", form.tool_ids.includes(id)
      ? form.tool_ids.filter(t => t !== id)
      : [...form.tool_ids, id]
    );
  }

  return (
    <div className="vault-modal-backdrop" onClick={onClose}>
      <div className="vault-modal" onClick={e => e.stopPropagation()}>
        <div className="vault-modal__header">
          <span className="vault-modal__title">
            {isEdit ? "Edit Secret" : "Add Secret"}
          </span>
          <button className="vault-icon-btn" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="vault-modal__body">
          {/* Key */}
          <div className="vault-field">
            <label className="vault-field__label">KEY <span className="vault-field__req">*</span></label>
            <input
              className={`vault-field__input${errors.key ? " vault-field__input--error" : ""}`}
              placeholder="e.g. openvas-admin-pass"
              value={form.key}
              onChange={e => handleKeyChange(e.target.value)}
              disabled={isEdit}
            />
            {errors.key && <span className="vault-field__error">{errors.key}</span>}
          </div>

          {/* Name */}
          <div className="vault-field">
            <label className="vault-field__label">DISPLAY NAME <span className="vault-field__req">*</span></label>
            <input
              className={`vault-field__input${errors.name ? " vault-field__input--error" : ""}`}
              placeholder="e.g. OpenVAS Admin Password"
              value={form.name}
              onChange={e => set("name", e.target.value)}
            />
            {errors.name && <span className="vault-field__error">{errors.name}</span>}
          </div>

          {/* Kind + Env Var on same row */}
          <div className="vault-field-row">
            <div className="vault-field vault-field--half">
              <label className="vault-field__label">KIND</label>
              <ThemedSelect
                value={form.kind}
                options={KINDS.map(k => ({ value: k.value, label: k.label }))}
                onChange={v => set("kind", v)}
              />
            </div>
            <div className="vault-field vault-field--half">
              <label className="vault-field__label">ENV VAR NAME</label>
              <input
                className="vault-field__input"
                placeholder="e.g. OPENVAS_ADMIN_PASS"
                value={form.env_var}
                onChange={e => set("env_var", e.target.value.toUpperCase().replace(/\s/g, "_"))}
              />
            </div>
          </div>

          {/* Value */}
          <div className="vault-field">
            <label className="vault-field__label">
              VALUE {!isEdit && <span className="vault-field__req">*</span>}
              {isEdit && <span className="vault-field__hint"> (leave blank to keep existing)</span>}
            </label>
            <div className="vault-field__value-wrap">
              <input
                className={`vault-field__input vault-field__input--mono${errors.value ? " vault-field__input--error" : ""}`}
                type={showVal ? "text" : "password"}
                placeholder={isEdit ? "Leave blank to keep existing value" : "Enter secret value"}
                value={form.value}
                onChange={e => set("value", e.target.value)}
                autoComplete="new-password"
              />
              <button
                className="vault-field__eye"
                onClick={() => setShowVal(v => !v)}
                type="button"
                tabIndex={-1}
              >
                {showVal ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            {errors.value && <span className="vault-field__error">{errors.value}</span>}
          </div>

          {/* Description */}
          <div className="vault-field">
            <label className="vault-field__label">DESCRIPTION</label>
            <textarea
              className="vault-field__textarea"
              placeholder="What is this secret used for?"
              value={form.description}
              onChange={e => set("description", e.target.value)}
              rows={2}
            />
          </div>

          {/* Tool associations */}
          <div className="vault-field">
            <label className="vault-field__label">INJECT INTO TOOLS</label>
            <div className="vault-tool-picker">
              {tools.length === 0
                ? <span className="vault-field__hint">No tools available yet.</span>
                : tools.map(t => (
                  <button
                    key={t.id}
                    className={`vault-tool-chip ${form.tool_ids.includes(t.id) ? "vault-tool-chip--active" : ""}`}
                    onClick={() => toggleTool(t.id)}
                    type="button"
                  >
                    {t.compose && <Layers size={9} />}
                    {t.name}
                  </button>
                ))
              }
            </div>
          </div>
        </div>

        <div className="vault-modal__footer">
          <button className="vault-btn vault-btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="vault-btn vault-btn--primary"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading
              ? <><RefreshCw size={12} className="spin" /> Saving…</>
              : <><Check size={12} /> {isEdit ? "Update Secret" : "Add Secret"}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main vault page ───────────────────────────────────────── //
export default function VaultPage() {
  const { tools } = useContainer();

  const [secrets,    setSecrets]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [formOpen,   setFormOpen]   = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState(null);
  const [search,     setSearch]     = useState("");
  const [deleteKey,  setDeleteKey]  = useState(null); // confirm dialog

  // ── Load ─────────────────────────────────────────────── //
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke("vault_list");
      setSecrets(list || []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Save (create or update) ───────────────────────────── //
  async function handleSave(form) {
    setSaving(true);
    setError(null);
    try {
      if (editTarget) {
        await invoke("vault_update", {
          key:         form.key,
          name:        form.name,
          description: form.description,
          kind:        form.kind,
          envVar:      form.env_var,
          value:       form.value || null,
          toolIds:     form.tool_ids,
        });
      } else {
        await invoke("vault_create", {
          key:         form.key,
          name:        form.name,
          description: form.description,
          kind:        form.kind,
          envVar:      form.env_var,
          value:       form.value || null,
          toolIds:     form.tool_ids,
        });
      }
      setFormOpen(false);
      setEditTarget(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // ── Delete ────────────────────────────────────────────── //
  async function handleDelete(key) {
    setDeleteKey(null);
    setError(null);
    try {
      await invoke("vault_delete", { key });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Reveal ────────────────────────────────────────────── //
  async function handleReveal(key) {
    return invoke("vault_get_value", { key });
  }

  const filtered = secrets.filter(s =>
    !search.trim() ||
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.key.toLowerCase().includes(search.toLowerCase()) ||
    s.env_var?.toLowerCase().includes(search.toLowerCase())
  );

  const runningCount = secrets.filter(s => s.tool_ids?.length > 0).length;

  return (
    <div className="vault-page">
      <TopBar
        title="Secrets Vault"
        titleIcon="Lock"
        onRefresh={load}
      />

      {/* Stats + toolbar */}
      <div className="vault-toolbar">
        <div className="vault-stats">
          <div className="vault-stat">
            <span className="vault-stat__val">{secrets.length}</span>
            <span className="vault-stat__lbl">SECRETS</span>
          </div>
          <div className="vault-stat vault-stat--cyan">
            <span className="vault-stat__val">{runningCount}</span>
            <span className="vault-stat__lbl">LINKED</span>
          </div>
        </div>

        <div className="vault-search">
          <input
            className="vault-search__input"
            placeholder="Search secrets…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <button
          className="vault-btn vault-btn--primary"
          onClick={() => { setEditTarget(null); setFormOpen(true); }}
        >
          <Plus size={13} /> Add Secret
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="vault-error">
          <AlertTriangle size={13} /> {error}
          <button onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Content */}
      <div className="vault-content">
        {loading ? (
          <div className="vault-loading">
            <RefreshCw size={20} className="spin" />
            <span>Loading vault…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="vault-empty">
            <Lock size={36} />
            <p>{search ? "No secrets match your search." : "No secrets stored yet."}</p>
            {!search && (
              <button
                className="vault-btn vault-btn--primary"
                onClick={() => { setEditTarget(null); setFormOpen(true); }}
              >
                <Plus size={13} /> Add your first secret
              </button>
            )}
          </div>
        ) : (
          <div className="vault-list">
            {filtered.map(s => (
              <SecretRow
                key={s.key}
                secret={s}
                tools={tools}
                onEdit={s => { setEditTarget(s); setFormOpen(true); }}
                onDelete={key => setDeleteKey(key)}
                onReveal={handleReveal}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit modal */}
      {formOpen && (
        <SecretForm
          initial={editTarget}
          tools={tools}
          onSave={handleSave}
          onClose={() => { setFormOpen(false); setEditTarget(null); }}
          loading={saving}
        />
      )}

      {/* Delete confirm */}
      {deleteKey && (
        <div className="vault-modal-backdrop" onClick={() => setDeleteKey(null)}>
          <div className="vault-confirm" onClick={e => e.stopPropagation()}>
            <div className="vault-confirm__icon"><AlertTriangle size={22} /></div>
            <p>Delete secret <strong>{deleteKey}</strong>?</p>
            <p className="vault-confirm__sub">This will remove the value from your OS keyring. This cannot be undone.</p>
            <div className="vault-confirm__actions">
              <button className="vault-btn vault-btn--ghost" onClick={() => setDeleteKey(null)}>Cancel</button>
              <button className="vault-btn vault-btn--danger" onClick={() => handleDelete(deleteKey)}>
                <Trash2 size={12} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
