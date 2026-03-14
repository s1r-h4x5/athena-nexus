// ═══════════════════════════════════════════════════════════
// pages/UserToolsPage.jsx — M12: User-Defined Tools
//
// Full CRUD editor for custom container tools that appear
// alongside the built-in registry on the Dashboard.
//
// Each tool can define:
//   - Container image OR compose file path
//   - Exposed ports
//   - Web entrypoint URL
//   - Secret references (from the Vault)
//   - Category
//
// User tools are persisted in config.tool_definitions
// and merged into the registry at startup.
// ═══════════════════════════════════════════════════════════

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  Plus, Wrench, Edit3, Trash2, Check, X,
  RefreshCw, AlertTriangle, Copy, Package,
  ChevronRight, Lock, Globe, Server, Code,
  Save, Eye, EyeOff, Info, Download, Terminal, Wand2,
} from "lucide-react";
import TopBar from "../components/TopBar";
import ThemedSelect from "../components/ThemedSelect";
import { useContainer, buildEnvFromVars } from "../context/ContainerContext";
import { IS_TAURI } from "../lib/container";
import { MOCK_CATEGORIES } from "../lib/mockData";
import { displayImage } from "../lib/imageUtils";
import "./UserToolsPage.css";

// ── Tauri invoke bridge ───────────────────────────────────── //
async function invoke(cmd, args = {}) {
  if (IS_TAURI) {
    const { invoke: ti } = await import("@tauri-apps/api/core");
    return ti(cmd, args);
  }
  return mockUserTools(cmd, args);
}

// ── Mock ──────────────────────────────────────────────────── //
let _mockTools = [
  {
    id: "custom-mitmproxy",
    name: "mitmproxy",
    category: "network",
    description: "Interactive TLS-capable intercepting proxy for HTTP and HTTPS.",
    registry: "docker.io",
    image: "mitmproxy/mitmproxy",
    version: "latest",
    compose_file: null,
    entrypoint: "http://localhost:8081",
    ports: [8080, 8081],
    secret_refs: [],
    user_defined: true,
  },
  {
    id: "custom-maltego",
    name: "Maltego CE",
    category: "threat-intel",
    description: "Open-source intelligence and graphical link analysis tool.",
    registry: "docker.io",
    image: null,
    version: "latest",
    compose_file: "/home/user/compose/maltego-compose.yml",
    entrypoint: null,
    ports: [],
    secret_refs: ["maltego-api-key"],
    user_defined: true,
  },
];

async function mockUserTools(cmd, args) {
  await new Promise(r => setTimeout(r, 130));
  // Normalize camelCase Tauri params to snake_case for mock storage
  function normalize(a) {
    return {
      ...a,
      cli_tool:    a.cliTool    ?? a.cli_tool    ?? false,
      secret_refs: a.secretRefs ?? a.secret_refs ?? [],
      env_vars:    a.env_vars   ?? [],
      categories:  a.categories || (a.category ? [a.category] : ["utilities"]),
    };
  }
  switch (cmd) {
    case "user_tools_list": return [..._mockTools];
    case "user_tools_create": {
      const t = { ...normalize(args), user_defined: true };
      _mockTools.push(t);
      return t;
    }
    case "user_tools_update": {
      _mockTools = _mockTools.map(t => t.id === args.id ? { ...t, ...normalize(args) } : t);
      return _mockTools.find(t => t.id === args.id);
    }
    case "user_tools_delete":
      _mockTools = _mockTools.filter(t => t.id !== args.id);
      return null;
    case "user_tools_export_yaml":
      return JSON.stringify(_mockTools.filter(t => !args.ids?.length || args.ids.includes(t.id)), null, 2);
    default: return null;
  }
}

// ── Category options ──────────────────────────────────────── //
const CATEGORIES = MOCK_CATEGORIES.filter(c => c.id !== "all");

// ── Empty form ────────────────────────────────────────────── //
const EMPTY_FORM = {
  id: "", name: "", categories: ["utilities"], description: "",
  registry: "docker.io", image: "", version: "latest",
  compose_file: "", entrypoint: "",
  ports: [], secret_refs: [], env_vars: [],
  cli_tool: false,
  _source: "image", // "image" | "compose"
};

// ── Environment variables editor ──────────────────────────── //
function EnvVarsEditor({ value, onChange }) {
  const EMPTY_DEF = { key: "", label: "", description: "", default: "", required: false, secret: false, auto_uuid: false };
  const [draft, setDraft]       = useState(EMPTY_DEF);
  const [err, setErr]           = useState("");
  const [editIdx, setEditIdx]   = useState(null);
  const [showVals, setShowVals] = useState({});

  function setDraftField(f, v) { setDraft(d => ({ ...d, [f]: v })); setErr(""); }

  function add() {
    const k = draft.key.trim();
    if (!k) { setErr("Key is required."); return; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { setErr("Key must be a valid env var name (letters, digits, _)."); return; }
    if (value.some(d => d.key === k)) { setErr(`${k} already defined.`); return; }
    onChange([...value, { ...draft, key: k, label: draft.label.trim() || k }]);
    setDraft(EMPTY_DEF); setErr("");
  }

  function remove(idx) { onChange(value.filter((_, i) => i !== idx)); }
  function update(idx, field, val) { onChange(value.map((d, i) => i === idx ? { ...d, [field]: val } : d)); }

  return (
    <div className="ut-envvars-editor">
      {value.length > 0 && (
        <div className="ut-envvars-list">
          {value.map((def, idx) => (
            <div key={def.key} className="ut-envvar-row">
              <div className="ut-envvar-row__main">
                <span className="ut-envvar-key mono">{def.key}</span>
                {def.required  && <span className="ut-envvar-badge ut-envvar-badge--required">required</span>}
                {def.secret    && <span className="ut-envvar-badge ut-envvar-badge--secret">secret</span>}
                {def.auto_uuid && <span className="ut-envvar-badge ut-envvar-badge--uuid">uuid</span>}
                {def.label && def.label !== def.key && <span className="ut-envvar-label-text">{def.label}</span>}
                <div className="ut-envvar-row__actions">
                  <button className="ut-envvar-btn" onClick={() => setEditIdx(editIdx === idx ? null : idx)} title="Edit"><Edit3 size={11} /></button>
                  <button className="ut-envvar-btn ut-envvar-btn--remove" onClick={() => remove(idx)} title="Remove"><X size={11} /></button>
                </div>
              </div>
              {editIdx === idx && (
                <div className="ut-envvar-expand">
                  <div className="ut-envvar-expand-row">
                    <label>Label</label>
                    <input className="ut-env-input" value={def.label} onChange={e => update(idx, "label", e.target.value)} placeholder="Human-readable name" />
                  </div>
                  <div className="ut-envvar-expand-row">
                    <label>Description</label>
                    <input className="ut-env-input" value={def.description} onChange={e => update(idx, "description", e.target.value)} placeholder="Helper text shown in deploy modal" />
                  </div>
                  <div className="ut-envvar-expand-row">
                    <label>Default value</label>
                    <div className="ut-env-input-wrap">
                      <input
                        className="ut-env-input"
                        type={def.secret && !showVals[def.key] ? "password" : "text"}
                        value={def.default}
                        onChange={e => update(idx, "default", e.target.value)}
                        placeholder={def.auto_uuid ? "auto-generate UUID" : ""}
                      />
                      {def.secret && (
                        <button className="ut-env-eye" type="button" onClick={() => setShowVals(s => ({ ...s, [def.key]: !s[def.key] }))}>
                          {showVals[def.key] ? <EyeOff size={11} /> : <Eye size={11} />}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="ut-envvar-expand-row ut-envvar-expand-row--flags">
                    <label className="ut-envvar-flag"><input type="checkbox" checked={def.required} onChange={e => update(idx, "required", e.target.checked)} /> Required</label>
                    <label className="ut-envvar-flag"><input type="checkbox" checked={def.secret} onChange={e => update(idx, "secret", e.target.checked)} /> Secret</label>
                    <label className="ut-envvar-flag"><input type="checkbox" checked={def.auto_uuid} onChange={e => update(idx, "auto_uuid", e.target.checked)} /> Auto UUID</label>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="ut-envvar-add">
        <div className="ut-envvar-add-row">
          <input className="ut-env-input mono" placeholder="KEY_NAME" value={draft.key}
            onChange={e => setDraftField("key", e.target.value)} onKeyDown={e => e.key === "Enter" && add()} />
          <input className="ut-env-input" placeholder="Label (optional)" value={draft.label}
            onChange={e => setDraftField("label", e.target.value)} onKeyDown={e => e.key === "Enter" && add()} />
          <input className="ut-env-input" placeholder="Default value" value={draft.default}
            onChange={e => setDraftField("default", e.target.value)} onKeyDown={e => e.key === "Enter" && add()} />
        </div>
        <div className="ut-envvar-add-flags">
          <label className="ut-envvar-flag"><input type="checkbox" checked={draft.required} onChange={e => setDraftField("required", e.target.checked)} /> Required</label>
          <label className="ut-envvar-flag"><input type="checkbox" checked={draft.secret} onChange={e => setDraftField("secret", e.target.checked)} /> Secret</label>
          <label className="ut-envvar-flag"><input type="checkbox" checked={draft.auto_uuid} onChange={e => setDraftField("auto_uuid", e.target.checked)} /> Auto UUID</label>
          <button className="ut-env-btn" onClick={add}><Plus size={12} /> Add</button>
        </div>
        {err && <div className="ut-field-error">{err}</div>}
      </div>
      <div className="ut-env-hint">
        Variables appear as a config form in the Deploy Modal.
        Mark <strong>Required</strong> to block deploy until filled, <strong>Secret</strong> to mask the value, <strong>Auto UUID</strong> to generate a UUID if left blank.
      </div>
    </div>
  );
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── Port tag input ────────────────────────────────────────── //
function PortsInput({ value, onChange }) {
  const [draft, setDraft] = useState("");

  function add() {
    const p = parseInt(draft.trim(), 10);
    if (!isNaN(p) && p > 0 && p <= 65535 && !value.includes(p)) {
      onChange([...value, p]);
    }
    setDraft("");
  }

  return (
    <div className="ut-ports">
      <div className="ut-ports__tags">
        {value.map(p => (
          <span key={p} className="ut-port-tag">
            :{p}
            <button onClick={() => onChange(value.filter(x => x !== p))}><X size={9} /></button>
          </span>
        ))}
      </div>
      <div className="ut-ports__add">
        <input
          className="ut-input ut-input--short"
          type="number"
          placeholder="Port…"
          value={draft}
          min="1" max="65535"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
        />
        <button className="ut-icon-btn" onClick={add} title="Add port"><Plus size={11} /></button>
      </div>
    </div>
  );
}

// ── Secret ref picker ─────────────────────────────────────── //
function SecretPicker({ value, onChange, vaultKeys }) {
  return (
    <div className="ut-secret-picker">
      {vaultKeys.length === 0 ? (
        <span className="ut-hint">No vault secrets yet — add some in the Vault page.</span>
      ) : vaultKeys.map(k => (
        <button
          key={k}
          className={`ut-secret-chip ${value.includes(k) ? "ut-secret-chip--active" : ""}`}
          onClick={() => onChange(
            value.includes(k) ? value.filter(x => x !== k) : [...value, k]
          )}
        >
          <Lock size={9} />
          {k}
        </button>
      ))}
    </div>
  );
}

// ── Tool form ─────────────────────────────────────────────── //
function ToolForm({ initial, vaultKeys, categories: catProp, onSave, onClose, saving }) {
  const FORM_CATEGORIES = catProp || MOCK_CATEGORIES.filter(c => c.id !== "all");
  const isEdit = !!initial?.id;
  const [form, setForm] = useState(() => {
    if (!initial) return { ...EMPTY_FORM };
    const validIds = new Set(FORM_CATEGORIES.map(c => c.id));
    const rawCats  = initial.categories || (initial.category ? [initial.category] : ["utilities"]);
    const cleanCats = rawCats.filter(id => validIds.has(id));
    return {
      ...EMPTY_FORM,
      ...initial,
      registry:     initial.registry     || "docker.io",
      image:        initial.image        || "",
      version:      initial.version      || "latest",
      entrypoint:   initial.entrypoint   || "",   // ensure never null
      ports:        initial.ports        || [],
      secret_refs:  initial.secret_refs  || [],
      env_vars:     initial.env_vars     || [],
      cli_tool:     initial.cli_tool     || false,
      // Only keep categories that still exist; fall back to utilities if all gone
      categories:   cleanCats.length ? cleanCats : ["utilities"],
      _source: initial.compose_file ? "compose" : "image",
    };
  });
  const [errors, setErrors] = useState({});

  function set(field, val) {
    setForm(f => ({ ...f, [field]: val }));
    if (errors[field]) setErrors(e => ({ ...e, [field]: null }));
  }

  function handleNameChange(v) {
    set("name", v);
    if (!isEdit && !form.id) set("id", `custom-${slugify(v)}`);
  }

  function validate() {
    const e = {};
    if (!form.name.trim())          e.name = "Name is required.";
    if (!form.id.trim())            e.id   = "ID is required.";
    if (!/^[a-z0-9-]+$/.test(form.id)) e.id = "ID must be lowercase letters, numbers and hyphens.";
    if (form._source === "image"  && !form.image.trim())        e.image       = "Image is required.";
    if (form._source === "compose" && !form.compose_file.trim()) e.compose_file = "Compose file path is required.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit() {
    if (!validate()) return;
    // Keep only categories that still exist in the current category list
    const validIds = new Set(FORM_CATEGORIES.map(c => c.id));
    const cleanCats = form.categories.filter(id => validIds.has(id));
    // Fallback to utilities if all selected categories were deleted
    const finalCats = cleanCats.length ? cleanCats : ["utilities"];
    const payload = {
      id:          form.id.trim(),
      name:        form.name.trim(),
      category:    finalCats[0],
      categories:  finalCats,
      description: form.description.trim(),
      registry:    form._source === "image" ? (form.registry.trim() || "docker.io") : "docker.io",
      image:       form._source === "image" ? form.image.trim() || null : null,
      version:     form._source === "image" ? (form.version.trim() || "latest") : "latest",
      compose_file:form._source === "compose" ? form.compose_file.trim() || null : null,
      entrypoint:  (form.entrypoint || "").trim() || null,
      ports:       form.ports,
      secretRefs:  form.secret_refs,
      env_vars:    form.env_vars,
      cliTool:     form.cli_tool,
    };
    onSave(payload);
  }

  return (
    <div className="ut-form-backdrop" onClick={onClose}>
      <div className="ut-form" onClick={e => e.stopPropagation()}>
        <div className="ut-form__header">
          <span className="ut-form__title">{isEdit ? "Edit Tool" : "Add User-Defined Tool"}</span>
          <button className="ut-icon-btn" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="ut-form__body">
          {/* Name + ID row */}
          <div className="ut-field-row">
            <div className="ut-field ut-field--half">
              <label className="ut-label">NAME <span className="ut-req">*</span></label>
              <input
                className={`ut-input ${errors.name ? "ut-input--error" : ""}`}
                placeholder="e.g. mitmproxy"
                value={form.name}
                onChange={e => handleNameChange(e.target.value)}
              />
              {errors.name && <span className="ut-error">{errors.name}</span>}
            </div>
            <div className="ut-field ut-field--half">
              <label className="ut-label">ID <span className="ut-req">*</span></label>
              <input
                className={`ut-input ut-input--mono ${errors.id ? "ut-input--error" : ""}`}
                placeholder="e.g. custom-mitmproxy"
                value={form.id}
                onChange={e => set("id", e.target.value)}
                disabled={isEdit}
              />
              {errors.id && <span className="ut-error">{errors.id}</span>}
            </div>
          </div>

          {/* Categories — multi-select */}
          <div className="ut-field">
            <label className="ut-label">CATEGORIES <span className="ut-label-hint">(select one or more)</span></label>
            <div className="ut-cat-grid">
              {FORM_CATEGORIES.map(c => {
                const checked = form.categories.includes(c.id);
                return (
                  <label key={c.id} className={`ut-cat-chip${checked ? " ut-cat-chip--on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? form.categories.filter(x => x !== c.id)
                          : [...form.categories, c.id];
                        set("categories", next.length ? next : [c.id]); // keep at least one
                      }}
                    />
                    {c.label}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Description */}
          <div className="ut-field">
            <label className="ut-label">DESCRIPTION</label>
            <textarea
              className="ut-textarea"
              placeholder="What does this tool do?"
              value={form.description}
              onChange={e => set("description", e.target.value)}
              rows={2}
            />
          </div>

          {/* Source toggle */}
          <div className="ut-field">
            <label className="ut-label">SOURCE</label>
            <div className="ut-source-toggle">
              <button
                className={`ut-source-btn ${form._source === "image" ? "ut-source-btn--active" : ""}`}
                onClick={() => set("_source", "image")}
              >
                <Package size={11} /> Container Image
              </button>
              <button
                className={`ut-source-btn ${form._source === "compose" ? "ut-source-btn--active" : ""}`}
                onClick={() => set("_source", "compose")}
              >
                <Code size={11} /> Compose File
              </button>
            </div>
          </div>

          {/* Image or compose path */}
          {form._source === "image" ? (
            <>
              {/* Registry */}
              <div className="ut-field">
                <label className="ut-label">REGISTRY</label>
                <input
                  className="ut-input ut-input--mono"
                  placeholder="docker.io"
                  value={form.registry}
                  onChange={e => set("registry", e.target.value)}
                />
                <span className="ut-hint">e.g. docker.io · ghcr.io · registry.gitlab.com</span>
              </div>

              {/* Image name */}
              <div className="ut-field">
                <label className="ut-label">IMAGE <span className="ut-req">*</span></label>
                <input
                  className={`ut-input ut-input--mono ${errors.image ? "ut-input--error" : ""}`}
                  placeholder="e.g. mitmproxy/mitmproxy"
                  value={form.image}
                  onChange={e => set("image", e.target.value)}
                />
                {errors.image && <span className="ut-error">{errors.image}</span>}
                <span className="ut-hint">Image name without registry prefix or tag</span>
              </div>

              {/* Version / tag */}
              <div className="ut-field">
                <label className="ut-label">VERSION / TAG</label>
                <input
                  className="ut-input ut-input--mono"
                  placeholder="latest"
                  value={form.version}
                  onChange={e => set("version", e.target.value)}
                />
                <span className="ut-hint">
                  Pull ref: <code className="ut-code">
                    {(form.registry || "docker.io")}/{form.image || "<image>"}:{form.version || "latest"}
                  </code>
                </span>
              </div>
            </>
          ) : (
            <div className="ut-field">
              <label className="ut-label">COMPOSE FILE PATH <span className="ut-req">*</span></label>
              <input
                className={`ut-input ut-input--mono ${errors.compose_file ? "ut-input--error" : ""}`}
                placeholder="/home/user/compose/tool-compose.yml"
                value={form.compose_file}
                onChange={e => set("compose_file", e.target.value)}
              />
              {errors.compose_file && <span className="ut-error">{errors.compose_file}</span>}
            </div>
          )}

          {/* Entrypoint */}
          <div className="ut-field">
            <label className="ut-label">WEB ENTRYPOINT</label>
            <input
              className="ut-input"
              placeholder="e.g. http://localhost:8081"
              value={form.entrypoint}
              onChange={e => set("entrypoint", e.target.value)}
            />
          </div>

          {/* Ports */}
          <div className="ut-field">
            <label className="ut-label">EXPOSED PORTS</label>
            <PortsInput value={form.ports} onChange={v => set("ports", v)} />
          </div>

          {/* Secret refs */}
          <div className="ut-field">
            <label className="ut-label">ENVIRONMENT VARIABLES</label>
            <EnvVarsEditor value={form.env_vars} onChange={v => set("env_vars", v)} />
          </div>

          {/* Vault secrets */}
          <div className="ut-field">
            <label className="ut-label">VAULT SECRETS TO INJECT</label>
            <SecretPicker value={form.secret_refs} onChange={v => set("secret_refs", v)} vaultKeys={vaultKeys} />
          </div>

          {/* CLI section */}
          <div className="ut-section-divider">
            <span>COMMAND-LINE INTERFACE</span>
          </div>
          <div className="ut-field ut-cli-row">
            <div className="ut-cli-info">
              <span className="ut-cli-title">CLI Tool</span>
              <span className="ut-cli-desc">No web UI — accessed by exec-ing into the container. The container will use <code>sleep infinity</code> to stay alive.</span>
            </div>
            <button
              type="button"
              className={`ut-slider ${form.cli_tool ? "ut-slider--on" : ""}`}
              onClick={() => set("cli_tool", !form.cli_tool)}
              aria-pressed={form.cli_tool}
              title="Toggle CLI mode"
            >
              <span className="ut-slider__thumb" />
            </button>
          </div>
        </div>

        <div className="ut-form__footer">
          <button className="ut-btn ut-btn--ghost" onClick={onClose}>Cancel</button>
          <button className="ut-btn ut-btn--primary" onClick={handleSubmit} disabled={saving}>
            {saving
              ? <><RefreshCw size={12} className="spin" /> Saving…</>
              : <><Check size={12} /> {isEdit ? "Update Tool" : "Add Tool"}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tool card ─────────────────────────────────────────────── //
function ToolCard({ tool, liveStatus, onEdit, onDelete, onExport, allCategories }) {
  const [confirmDel, setConfirmDel] = useState(false);

  const catIds = tool.categories || (tool.category ? [tool.category] : []);
  const catList = allCategories || CATEGORIES;
  const catLabels = catIds.map(id => catList.find(c => c.id === id)?.label || id);

  return (
    <div className="ut-card">
      <div className="ut-card__header">
        <div className="ut-card__icon">
          {tool.compose_file ? <Code size={14} /> : <Package size={14} />}
        </div>
        <div className="ut-card__info">
          <div className="ut-card__name">
            {tool.name}
            <span className="ut-user-badge">USER</span>
          </div>
          <div className="ut-card__id">{tool.id}</div>
        </div>
        <div className="ut-card__actions">
          <button className="ut-icon-btn" onClick={() => onExport(tool.id)} title="Export as JSON"><Download size={12} /></button>
          <button className="ut-icon-btn" onClick={() => onEdit(tool)} title="Edit tool"><Edit3 size={12} /></button>
          {!confirmDel
            ? <button className="ut-icon-btn ut-icon-btn--danger" onClick={() => setConfirmDel(true)} title="Delete tool"><Trash2 size={12} /></button>
            : <>
                <button className="ut-icon-btn ut-icon-btn--confirm" onClick={() => onDelete(tool.id)}><Check size={12} /></button>
                <button className="ut-icon-btn" onClick={() => setConfirmDel(false)}><X size={12} /></button>
              </>}
        </div>
      </div>

      <div className="ut-card__body">
        <p className="ut-card__desc">{tool.description || <em>No description</em>}</p>

        <div className="ut-card__meta">
          <div className="ut-card__cats">
            {catLabels.map(lbl => (
              <span key={lbl} className="ut-cat-badge">{lbl}</span>
            ))}
          </div>

          {liveStatus && (
            <span className={`ut-live-status ut-live-status--${liveStatus}`}>
              <span className="ut-live-status__dot" />
              {liveStatus}
            </span>
          )}

          {tool.cli_tool && (
            <span className="ut-meta-chip ut-meta-chip--cli"><Terminal size={9} /> CLI</span>
          )}
          {tool.image && (
            <span className="ut-meta-chip"><Package size={9} /> {displayImage(tool)}</span>
          )}
          {tool.compose_file && (
            <span className="ut-meta-chip"><Code size={9} /> compose</span>
          )}
          {tool.ports?.length > 0 && (
            <span className="ut-meta-chip"><Server size={9} /> {tool.ports.map(p => `:${p}`).join(" ")}</span>
          )}
          {tool.entrypoint && (
            <a className="ut-meta-chip ut-meta-chip--link" href={tool.entrypoint} target="_blank" rel="noopener noreferrer">
              <Globe size={9} /> {tool.entrypoint}
            </a>
          )}
          {tool.secret_refs?.length > 0 && (
            <span className="ut-meta-chip"><Lock size={9} /> {tool.secret_refs.length} secret{tool.secret_refs.length > 1 ? "s" : ""}</span>
          )}
          {tool.env && Object.keys(tool.env).length > 0 && (
            <span className="ut-meta-chip"><Code size={9} /> {Object.keys(tool.env).length} env var{Object.keys(tool.env).length > 1 ? "s" : ""}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Export modal ──────────────────────────────────────────── //
function ExportModal({ yaml, onClose }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="ut-form-backdrop" onClick={onClose}>
      <div className="ut-export-modal" onClick={e => e.stopPropagation()}>
        <div className="ut-form__header">
          <span className="ut-form__title">Export Tool Definition</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="ut-icon-btn" onClick={copy} title="Copy">
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <button className="ut-icon-btn" onClick={onClose}><X size={14} /></button>
          </div>
        </div>
        <pre className="ut-export-pre">{yaml}</pre>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────── //
export default function UserToolsPage({ categories: propCategories, onToolSaved }) {
  const { tools: liveTools } = useContainer();
  // Use dynamic categories if passed, fall back to MOCK_CATEGORIES
  const allCategories = propCategories || MOCK_CATEGORIES;
  const CATEGORIES = allCategories.filter(c => c.id !== "all");

  const [tools,     setTools]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [formOpen,  setFormOpen]  = useState(false);
  const [editTarget,setEditTarget]= useState(null);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState(null);
  const [exportYaml,setExportYaml]= useState(null);
  const [search,    setSearch]    = useState("");

  // Vault keys for secret picker (loaded from context tools → secret_refs)
  const [vaultKeys, setVaultKeys] = useState([]);
  useEffect(() => {
    if (IS_TAURI) {
      import("@tauri-apps/api/core")
        .then(({ invoke: ti }) => ti("vault_list"))
        .then(list => setVaultKeys((list || []).map(s => s.key)))
        .catch(() => {});
    }
  }, []);

  // ── Load ─────────────────────────────────────────────────── //
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke("user_tools_list");
      setTools(list || []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Save (create or update) ───────────────────────────────── //
  async function handleSave(form) {
    setSaving(true);
    setError(null);
    try {
      if (editTarget) {
        await invoke("user_tools_update", form);
      } else {
        await invoke("user_tools_create", form);
      }
      setFormOpen(false);
      setEditTarget(null);
      await load();
      // Notify parent (App) to refresh useRegistry so Dashboard + RegistryPage see the new tool
      onToolSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // ── Delete ────────────────────────────────────────────────── //
  async function handleDelete(id) {
    try {
      await invoke("user_tools_delete", { id });
      await load();
      onToolSaved?.(); // refresh registry
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Export ────────────────────────────────────────────────── //
  async function handleExport(id) {
    try {
      const yaml = await invoke("user_tools_export_yaml", { ids: [id] });
      setExportYaml(yaml);
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Filter ────────────────────────────────────────────────── //
  const filtered = useMemo(() => {
    if (!search.trim()) return tools;
    const q = search.toLowerCase();
    return tools.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q) ||
      t.description?.toLowerCase().includes(q) ||
      (t.categories || [t.category]).some(c => c?.toLowerCase().includes(q))
    );
  }, [tools, search]);

  // Match live tool status
  function getLiveStatus(tool) {
    return liveTools.find(t => t.id === tool.id)?.status;
  }

  return (
    <div className="ut-page">
      <TopBar title="User-Defined Tools"
        titleIcon="Wrench" onRefresh={load} />

      {/* Toolbar */}
      <div className="ut-toolbar">
        <div className="ut-stats">
          <div className="ut-stat">
            <span className="ut-stat__val">{tools.length}</span>
            <span className="ut-stat__lbl">CUSTOM TOOLS</span>
          </div>
          <div className="ut-stat ut-stat--green">
            <span className="ut-stat__val">
              {tools.filter(t => liveTools.find(l => l.id === t.id)?.status === "running").length}
            </span>
            <span className="ut-stat__lbl">RUNNING</span>
          </div>
        </div>

        <div className="ut-search">
          <input
            className="ut-search__input"
            placeholder="Search tools…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <button
          className="ut-btn ut-btn--primary"
          onClick={() => { setEditTarget(null); setFormOpen(true); }}
        >
          <Plus size={13} /> Add Tool
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="ut-error-banner">
          <AlertTriangle size={13} /> {error}
          <button onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Info callout (shown when empty) */}
      {!loading && tools.length === 0 && (
        <div className="ut-callout">
          <Info size={14} />
          <div>
            <strong>Define your own tools</strong>
            <p>
              Add any container image or compose stack. User-defined tools appear on the Dashboard
              alongside the built-in registry and support full lifecycle management (start, stop,
              restart, logs, snapshots, vault secrets).
            </p>
          </div>
        </div>
      )}

      {/* Tool list */}
      <div className="ut-content">
        {loading ? (
          <div className="ut-loading"><RefreshCw size={18} className="spin" /> Loading…</div>
        ) : filtered.length === 0 && search ? (
          <div className="ut-empty">
            <Wrench size={36} />
            <p>No tools match "{search}"</p>
          </div>
        ) : (
          <div className="ut-grid">
            {filtered.map(t => (
              <ToolCard
                key={t.id}
                tool={t}
                liveStatus={getLiveStatus(t)}
                onEdit={t => { setEditTarget(t); setFormOpen(true); }}
                onDelete={handleDelete}
                onExport={handleExport}
                allCategories={CATEGORIES}
              />
            ))}
          </div>
        )}
      </div>

      {/* Form modal */}
      {formOpen && (
        <ToolForm
          initial={editTarget}
          vaultKeys={vaultKeys}
          categories={CATEGORIES}
          onSave={handleSave}
          onClose={() => { setFormOpen(false); setEditTarget(null); }}
          saving={saving}
        />
      )}

      {/* Export modal */}
      {exportYaml && (
        <ExportModal yaml={exportYaml} onClose={() => setExportYaml(null)} />
      )}
    </div>
  );
}
