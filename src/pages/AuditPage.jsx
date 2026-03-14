// ═══════════════════════════════════════════════════════════
// pages/AuditPage.jsx — M10: Audit Log
//
// Tamper-evident event timeline for all actions in Athena Nexus.
//
// Features:
//   - Virtualized infinite-scroll list (newest first)
//   - Filter by category, outcome, free-text search
//   - Chain integrity verification
//   - Export path display
//   - Clear with confirmation
// ═══════════════════════════════════════════════════════════

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  ClipboardList, RefreshCw, Search, ShieldCheck, ShieldAlert,
  AlertTriangle, CheckCircle, XCircle, Info, Trash2, Download,
  X, ChevronDown, ChevronUp, Circle,
  Play, Square, RotateCcw, Zap, Camera, Lock, Settings,
  Server, Package,
} from "lucide-react";
import TopBar from "../components/TopBar";
import ThemedSelect from "../components/ThemedSelect";
import { IS_TAURI } from "../lib/container";
import "./AuditPage.css";

// ── Tauri invoke bridge ───────────────────────────────────── //
async function invoke(cmd, args = {}) {
  if (IS_TAURI) {
    const { invoke: ti } = await import("@tauri-apps/api/core");
    return ti(cmd, args);
  }
  return mockAudit(cmd, args);
}

// Mutable in-memory store for mock mode — audit_append writes here,
// audit_list reads from here, so the page reflects real actions.
let mockEvents = (() => {
  const actions = [
    ["container", "start",   "openvas",  "Greenbone OpenVAS",  "success",  ""],
    ["container", "stop",    "wazuh",    "Wazuh SIEM",         "success",  ""],
    ["container", "restart", "misp",     "MISP",               "success",  ""],
    ["container", "update",  "openvas",  "Greenbone OpenVAS",  "success",  "Pulled greenbone/community-edition:latest"],
    ["container", "start",   "zeek",     "Zeek IDS",           "failure",  "Error: port 9092 already in use"],
    ["deploy",    "deploy",  "velociraptor", "Velociraptor",   "success",  "compose up completed"],
    ["deploy",    "undeploy","zeek",     "Zeek IDS",           "success",  ""],
    ["snapshot",  "create",  "snap-001", "Greenbone OpenVAS",  "success",  "Before feed update"],
    ["snapshot",  "export",  "snap-001", "snap-001",           "success",  "412 MB exported"],
    ["vault",     "create",  "wazuh-api-key", "Wazuh API Key", "success",  ""],
    ["vault",     "update",  "openvas-pass",  "OpenVAS Password","success",""],
    ["vault",     "delete",  "old-token",     "Old Token",      "success",  ""],
    ["system",    "connect", "podman",   "Podman Socket",      "success",  "/run/user/1000/podman/podman.sock"],
    ["system",    "preflight","system",  "System Checks",      "warning",  "1 warning: skopeo not found"],
    ["config",    "reload",  "registry", "Tool Registry",      "success",  "13 entries loaded"],
  ];

  return actions.map((a, i) => {
    const ts = new Date(Date.now() - (actions.length - i) * 3_600_000).toISOString();
    return {
      seq: i + 1,
      timestamp: ts,
      category:   a[0],
      action:     a[1],
      subject_id: a[2],
      subject:    a[3],
      outcome:    a[4],
      detail:     a[5],
      chain_hash: `mock${i.toString(16).padStart(15, "0")}`,
    };
  }).reverse();
})();

async function mockAudit(cmd, args) {
  await new Promise(r => setTimeout(r, 100));
  switch (cmd) {
    case "audit_append": {
      const event = {
        seq:        mockEvents.length + 1,
        timestamp:  new Date().toISOString(),
        category:   args.category   || "",
        action:     args.action     || "",
        subject_id: args.subject_id || "",
        subject:    args.subject    || "",
        outcome:    args.outcome    || "",
        detail:     args.detail     || "",
        chain_hash: `mock${mockEvents.length.toString(16).padStart(15, "0")}`,
      };
      mockEvents = [event, ...mockEvents].slice(0, 500);
      return event;
    }
    case "audit_list": {
      let ev = [...mockEvents];
      if (args.category && args.category !== "all") ev = ev.filter(e => e.category === args.category);
      if (args.outcome  && args.outcome  !== "all") ev = ev.filter(e => e.outcome  === args.outcome);
      if (args.search) {
        const q = args.search.toLowerCase();
        ev = ev.filter(e =>
          e.subject.toLowerCase().includes(q) ||
          e.action.toLowerCase().includes(q)  ||
          e.detail.toLowerCase().includes(q)
        );
      }
      return ev.slice(0, args.limit || 500);
    }
    case "audit_verify":
      return { total: mockEvents.length, intact: true, broken_at: null };
    case "audit_export_path":
      return "/home/user/.config/athena-nexus/audit.json";
    case "audit_clear":
      mockEvents = [];
      return null;
    default: return null;
  }
}

// ── Category config ───────────────────────────────────────── //
const CATEGORIES = [
  { id: "all",       label: "All",       Icon: ClipboardList },
  { id: "container", label: "Container", Icon: Server       },
  { id: "deploy",    label: "Deploy",    Icon: Package      },
  { id: "snapshot",  label: "Snapshot",  Icon: Camera       },
  { id: "vault",     label: "Vault",     Icon: Lock         },
  { id: "system",    label: "System",    Icon: Settings     },
  { id: "config",    label: "Config",    Icon: Settings     },
];

const OUTCOMES = [
  { id: "all",     label: "All outcomes" },
  { id: "success", label: "Success"      },
  { id: "failure", label: "Failure"      },
  { id: "warning", label: "Warning"      },
];

// ── Action icons ──────────────────────────────────────────── //
function ActionIcon({ category, action }) {
  const cls = "ae-action-icon";
  if (action === "start"   || action === "deploy")   return <Play        size={11} className={`${cls} ${cls}--green`}  />;
  if (action === "stop"    || action === "undeploy")  return <Square      size={11} className={`${cls} ${cls}--red`}    />;
  if (action === "restart")                           return <RotateCcw   size={11} className={`${cls} ${cls}--cyan`}   />;
  if (action === "update")                            return <Zap         size={11} className={`${cls} ${cls}--amber`}  />;
  if (action === "create"  || action === "connect")   return <CheckCircle size={11} className={`${cls} ${cls}--green`}  />;
  if (action === "delete"  || action === "clear")     return <Trash2      size={11} className={`${cls} ${cls}--red`}    />;
  if (action === "export"  || action === "reload")    return <Download    size={11} className={`${cls} ${cls}--cyan`}   />;
  if (action === "restore" || action === "preflight") return <ShieldCheck size={11} className={`${cls} ${cls}--cyan`}   />;
  return <Circle size={11} className={cls} />;
}

// ── Outcome icon ──────────────────────────────────────────── //
function OutcomeIcon({ outcome }) {
  if (outcome === "success") return <CheckCircle  size={13} className="ae-outcome ae-outcome--success" />;
  if (outcome === "failure") return <XCircle      size={13} className="ae-outcome ae-outcome--failure" />;
  if (outcome === "warning") return <AlertTriangle size={13} className="ae-outcome ae-outcome--warning" />;
  return <Info size={13} className="ae-outcome" />;
}

// ── Format timestamp ──────────────────────────────────────── //
function fmtTs(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ── Single event row ──────────────────────────────────────── //
function EventRow({ event, expanded, onToggle }) {
  return (
    <div
      className={`ae-row ae-row--${event.outcome} ${expanded ? "ae-row--expanded" : ""}`}
      onClick={onToggle}
    >
      <div className="ae-row__main">
        {/* Seq */}
        <span className="ae-row__seq">#{event.seq}</span>

        {/* Outcome icon */}
        <OutcomeIcon outcome={event.outcome} />

        {/* Action icon */}
        <ActionIcon category={event.category} action={event.action} />

        {/* Summary */}
        <div className="ae-row__summary">
          <span className="ae-row__action">{event.action}</span>
          <span className="ae-row__subject">{event.subject}</span>
          {event.detail && !expanded && (
            <span className="ae-row__detail-preview">— {event.detail}</span>
          )}
        </div>

        {/* Category pill */}
        <span className={`ae-row__cat ae-row__cat--${event.category}`}>
          {event.category}
        </span>

        {/* Timestamp */}
        <span className="ae-row__ts">{fmtTs(event.timestamp)}</span>

        {/* Expand */}
        <span className="ae-row__chevron">
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </span>
      </div>

      {expanded && (
        <div className="ae-row__detail">
          <div className="ae-row__detail-grid">
            <span className="ae-detail-key">SUBJECT ID</span>
            <span className="ae-detail-val">{event.subject_id}</span>
            <span className="ae-detail-key">TIMESTAMP</span>
            <span className="ae-detail-val">{event.timestamp}</span>
            {event.detail && (
              <>
                <span className="ae-detail-key">DETAIL</span>
                <span className="ae-detail-val">{event.detail}</span>
              </>
            )}
            <span className="ae-detail-key">CHAIN HASH</span>
            <span className="ae-detail-val ae-detail-val--hash">{event.chain_hash}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────── //
export default function AuditPage() {
  const [events,      setEvents]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [category,    setCategory]    = useState("all");
  const [outcome,     setOutcome]     = useState("all");
  const [search,      setSearch]      = useState("");
  const [expandedSeq, setExpandedSeq] = useState(null);
  const [integrity,   setIntegrity]   = useState(null);
  const [exportPath,  setExportPath]  = useState(null);
  const [clearConfirm,setClearConfirm]= useState(false);
  const [error,       setError]       = useState(null);

  // ── Load events ──────────────────────────────────────────── //
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke("audit_list", {
        category: category === "all" ? null : category,
        outcome:  outcome  === "all" ? null : outcome,
        search:   search   || null,
        limit:    500,
      });
      setEvents(list || []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [category, outcome, search]);

  useEffect(() => { load(); }, [load]);

  // In mock/browser mode: listen for audit events dispatched by PodmanContext
  // actions and re-load the list so new entries appear immediately.
  useEffect(() => {
    if (IS_TAURI) return;
    function onMockAudit(e) {
      mockAudit("audit_append", e.detail);
      load();
    }
    window.addEventListener("athena:mock-audit", onMockAudit);
    return () => window.removeEventListener("athena:mock-audit", onMockAudit);
  }, [load]);

  // In Tauri mode: re-load whenever any part of the app writes a new audit entry
  useEffect(() => {
    if (!IS_TAURI) return;
    function onAuditWritten() { load(); }
    window.addEventListener("athena:audit-written", onAuditWritten);
    return () => window.removeEventListener("athena:audit-written", onAuditWritten);
  }, [load]);

  // ── Verify integrity ─────────────────────────────────────── //
  async function handleVerify() {
    try {
      const result = await invoke("audit_verify");
      setIntegrity(result);
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Export path ───────────────────────────────────────────── //
  async function handleShowExport() {
    try {
      const path = await invoke("audit_export_path");
      setExportPath(path);
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Clear ─────────────────────────────────────────────────── //
  async function handleClear() {
    setClearConfirm(false);
    try {
      await invoke("audit_clear");
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Stats ─────────────────────────────────────────────────── //
  const total    = events.length;
  const failures = events.filter(e => e.outcome === "failure").length;
  const warnings = events.filter(e => e.outcome === "warning").length;

  return (
    <div className="ae-page">
      <TopBar title="Audit Log"
        titleIcon="ClipboardList" onRefresh={load} />

      {/* Toolbar */}
      <div className="ae-toolbar">
        {/* Stats */}
        <div className="ae-stats">
          <div className="ae-stat">
            <span className="ae-stat__val">{total}</span>
            <span className="ae-stat__lbl">EVENTS</span>
          </div>
          <div className="ae-stat ae-stat--red">
            <span className="ae-stat__val">{failures}</span>
            <span className="ae-stat__lbl">FAILURES</span>
          </div>
          <div className="ae-stat ae-stat--amber">
            <span className="ae-stat__val">{warnings}</span>
            <span className="ae-stat__lbl">WARNINGS</span>
          </div>
        </div>

        {/* Search */}
        <div className="ae-search">
          <Search size={11} className="ae-search__icon" />
          <input
            className="ae-search__input"
            placeholder="Search events…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="ae-search__clear" onClick={() => setSearch("")}>
              <X size={10} />
            </button>
          )}
        </div>

        {/* Outcome filter */}
        <ThemedSelect
          value={outcome}
          options={OUTCOMES.map(o => ({ value: o.id, label: o.label }))}
          onChange={setOutcome}
        />

        {/* Actions */}
        <div className="ae-actions">
          <button className="ae-icon-btn" onClick={handleVerify} title="Verify chain integrity">
            <ShieldCheck size={13} />
          </button>
          <button className="ae-icon-btn" onClick={handleShowExport} title="Show export path">
            <Download size={13} />
          </button>
          <button className="ae-icon-btn ae-icon-btn--danger" onClick={() => setClearConfirm(true)} title="Clear log">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Category pills */}
      <div className="ae-cats">
        {CATEGORIES.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`ae-cat ${category === id ? "ae-cat--active" : ""}`}
            onClick={() => setCategory(id)}
          >
            <Icon size={10} />
            {label}
          </button>
        ))}
      </div>

      {/* Integrity banner */}
      {integrity && (
        <div className={`ae-integrity ${integrity.intact ? "ae-integrity--ok" : "ae-integrity--fail"}`}>
          {integrity.intact
            ? <><ShieldCheck size={13} /> Chain integrity verified — {integrity.total} events, all hashes valid.</>
            : <><ShieldAlert size={13} /> Chain integrity broken at event #{integrity.broken_at}. Log may have been tampered.</>}
          <button onClick={() => setIntegrity(null)}><X size={11} /></button>
        </div>
      )}

      {/* Export path banner */}
      {exportPath && (
        <div className="ae-export-banner">
          <Download size={12} />
          <span>Audit log stored at: <code>{exportPath}</code></span>
          <button onClick={() => setExportPath(null)}><X size={11} /></button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="ae-error">
          <AlertTriangle size={13} /> {error}
          <button onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Event list */}
      <div className="ae-list">
        {loading ? (
          <div className="ae-empty">
            <RefreshCw size={20} className="spin" />
            <span>Loading events…</span>
          </div>
        ) : events.length === 0 ? (
          <div className="ae-empty">
            <ClipboardList size={36} />
            <p>No audit events yet.</p>
            <small>Actions like start, stop, deploy, and vault changes are logged here.</small>
          </div>
        ) : (
          events.map(ev => (
            <EventRow
              key={ev.seq}
              event={ev}
              expanded={expandedSeq === ev.seq}
              onToggle={() => setExpandedSeq(s => s === ev.seq ? null : ev.seq)}
            />
          ))
        )}
      </div>

      {/* Clear confirm */}
      {clearConfirm && (
        <div className="ae-modal-backdrop" onClick={() => setClearConfirm(false)}>
          <div className="ae-confirm" onClick={e => e.stopPropagation()}>
            <AlertTriangle size={24} className="ae-confirm__icon" />
            <p>Clear the entire audit log?</p>
            <p className="ae-confirm__sub">A "clear" event will be recorded before wiping. This cannot be undone.</p>
            <div className="ae-confirm__actions">
              <button className="ae-btn ae-btn--ghost" onClick={() => setClearConfirm(false)}>Cancel</button>
              <button className="ae-btn ae-btn--danger" onClick={handleClear}>
                <Trash2 size={12} /> Clear Log
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
