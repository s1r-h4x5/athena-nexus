// ═══════════════════════════════════════════════════════════
// pages/SnapshotPage.jsx — M9: Snapshot & Backup
//
// Commit running containers to images, export as tarballs,
// restore from a snapshot, delete snapshots.
//
// Layout:
//   Left  — list of all snapshots (newest first)
//   Right — create-snapshot panel (tool picker + note)
//
// Snapshot lifecycle:
//   COMMITTED → (export) → EXPORTED → (restore) → running
// ═══════════════════════════════════════════════════════════

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  Camera, Download, Upload, Trash2, RefreshCw, Plus,
  CheckCircle, Clock, Archive, HardDrive, Package,
  ChevronDown, ChevronUp, AlertTriangle, Edit3, Check,
  X, Play, Layers, Circle,
} from "lucide-react";
import TopBar from "../components/TopBar";
import { useContainer } from "../context/ContainerContext";
import { IS_TAURI } from "../lib/container";
import "./SnapshotPage.css";

// ── Tauri invoke bridge ───────────────────────────────────── //
async function invoke(cmd, args = {}) {
  if (IS_TAURI) {
    const { invoke: ti } = await import("@tauri-apps/api/core");
    return ti(cmd, args);
  }
  return mockSnapshot(cmd, args);
}

// ── Mock state ────────────────────────────────────────────── //
let _mockSnaps = [
  {
    id: "snap-1709500800000",
    tool_id: "openvas",
    tool_name: "Greenbone OpenVAS",
    container_ids: ["abc123"],
    image_names: ["athena-snapshot/openvas-0:snap-1709500800000"],
    tar_path: "/home/user/.local/share/athena-nexus/snapshots/snap-1709500800000.tar",
    note: "Before feed update v24.3",
    size_bytes: 412_000_000,
    created_at: "2024-03-04T08:00:00Z",
    exported: true,
  },
  {
    id: "snap-1709587200000",
    tool_id: "wazuh",
    tool_name: "Wazuh SIEM",
    container_ids: ["def456", "ghi789"],
    image_names: [
      "athena-snapshot/wazuh-0:snap-1709587200000",
      "athena-snapshot/wazuh-1:snap-1709587200000",
    ],
    tar_path: null,
    note: "Stable config after onboarding",
    size_bytes: null,
    created_at: "2024-03-05T08:00:00Z",
    exported: false,
  },
];

async function mockSnapshot(cmd, args) {
  await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
  switch (cmd) {
    case "snapshot_list":
      return [..._mockSnaps].sort((a, b) => b.created_at.localeCompare(a.created_at));
    case "snapshot_create": {
      const snap = {
        id: `snap-${Date.now()}`,
        tool_id: args.toolId,
        tool_name: args.toolName,
        container_ids: args.containerIds,
        image_names: (args.containerIds || []).map((_, i) =>
          `athena-snapshot/${args.toolId}-${i}:snap-${Date.now()}`),
        tar_path: null,
        note: args.note,
        size_bytes: null,
        created_at: new Date().toISOString(),
        exported: false,
      };
      _mockSnaps.push(snap);
      return snap;
    }
    case "snapshot_export": {
      const s = _mockSnaps.find(s => s.id === args.snapshot_id);
      if (s) {
        s.tar_path = `/home/user/.local/share/athena-nexus/snapshots/${args.snapshot_id}.tar`;
        s.size_bytes = 280_000_000 + Math.random() * 400_000_000;
        s.exported = true;
      }
      return s?.tar_path;
    }
    case "snapshot_restore":
      return `Restored from ${args.snapshot_id}`;
    case "snapshot_delete":
      _mockSnaps = _mockSnaps.filter(s => s.id !== args.snapshot_id);
      return null;
    case "snapshot_update_note": {
      const s = _mockSnaps.find(s => s.id === args.snapshot_id);
      if (s) s.note = args.note;
      return null;
    }
    default: return null;
  }
}

// ── Helpers ───────────────────────────────────────────────── //
function fmtBytes(bytes) {
  if (!bytes) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Status badge ──────────────────────────────────────────── //
function SnapStatus({ snap }) {
  if (snap.exported) {
    return <span className="snap-badge snap-badge--exported"><Archive size={9} /> Exported</span>;
  }
  return <span className="snap-badge snap-badge--committed"><Camera size={9} /> Committed</span>;
}

// ── Snapshot card ─────────────────────────────────────────── //
function SnapCard({ snap, onExport, onRestore, onDelete, onNoteEdit, exporting, restoring }) {
  const [expanded,  setExpanded]  = useState(false);
  const [editNote,  setEditNote]  = useState(false);
  const [noteVal,   setNoteVal]   = useState(snap.note || "");
  const [confirmDel,setConfirmDel]= useState(false);

  function handleNoteSave() {
    onNoteEdit(snap.id, noteVal);
    setEditNote(false);
  }

  return (
    <div className={`snap-card ${expanded ? "snap-card--expanded" : ""}`}>
      {/* Header row */}
      <div className="snap-card__main" onClick={() => setExpanded(e => !e)}>
        <div className="snap-card__icon">
          {snap.container_ids.length > 1
            ? <Layers size={14} />
            : <Package size={14} />}
        </div>

        <div className="snap-card__info">
          <div className="snap-card__name">{snap.tool_name}</div>
          <div className="snap-card__meta">
            <span>{fmtDate(snap.created_at)}</span>
            {snap.note && <span className="snap-card__note-preview">· {snap.note}</span>}
          </div>
        </div>

        <div className="snap-card__right">
          <SnapStatus snap={snap} />
          {snap.size_bytes && (
            <span className="snap-card__size">{fmtBytes(snap.size_bytes)}</span>
          )}
          {snap.container_ids.length > 1 && (
            <span className="snap-card__containers">{snap.container_ids.length} containers</span>
          )}
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="snap-card__detail">
          {/* Images */}
          <div className="snap-card__section">
            <div className="snap-card__section-label">COMMITTED IMAGES</div>
            {snap.image_names.map((img, i) => (
              <div key={i} className="snap-card__image">{img}</div>
            ))}
          </div>

          {/* Export path */}
          {snap.tar_path && (
            <div className="snap-card__section">
              <div className="snap-card__section-label">EXPORT PATH</div>
              <div className="snap-card__path">{snap.tar_path}</div>
            </div>
          )}

          {/* Note */}
          <div className="snap-card__section">
            <div className="snap-card__section-label">
              NOTE
              {!editNote && (
                <button className="snap-icon-btn" onClick={() => setEditNote(true)}>
                  <Edit3 size={10} />
                </button>
              )}
            </div>
            {editNote ? (
              <div className="snap-note-edit">
                <input
                  className="snap-note-input"
                  value={noteVal}
                  onChange={e => setNoteVal(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleNoteSave()}
                  autoFocus
                />
                <button className="snap-icon-btn snap-icon-btn--green" onClick={handleNoteSave}><Check size={11} /></button>
                <button className="snap-icon-btn" onClick={() => setEditNote(false)}><X size={11} /></button>
              </div>
            ) : (
              <div className="snap-card__note-text">{snap.note || <em>No note</em>}</div>
            )}
          </div>

          {/* Actions */}
          <div className="snap-card__actions">
            {!snap.exported && (
              <button
                className="snap-btn snap-btn--export"
                onClick={() => onExport(snap.id)}
                disabled={exporting === snap.id}
              >
                {exporting === snap.id
                  ? <><RefreshCw size={11} className="spin" /> Exporting…</>
                  : <><Download size={11} /> Export .tar</>}
              </button>
            )}

            <button
              className="snap-btn snap-btn--restore"
              onClick={() => onRestore(snap.id)}
              disabled={restoring === snap.id}
            >
              {restoring === snap.id
                ? <><RefreshCw size={11} className="spin" /> Restoring…</>
                : <><Upload size={11} /> Restore</>}
            </button>

            {!confirmDel ? (
              <button className="snap-btn snap-btn--delete" onClick={() => setConfirmDel(true)}>
                <Trash2 size={11} /> Delete
              </button>
            ) : (
              <>
                <span className="snap-confirm-label">Confirm delete?</span>
                <button className="snap-btn snap-btn--danger" onClick={() => onDelete(snap.id)}>
                  <Check size={11} /> Yes
                </button>
                <button className="snap-btn snap-btn--ghost" onClick={() => setConfirmDel(false)}>
                  <X size={11} /> No
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Create snapshot panel ─────────────────────────────────── //
function CreatePanel({ tools, onCreate, creating }) {
  const [selectedTool, setSelectedTool] = useState(null);
  const [note, setNote] = useState("");
  const deployedTools = tools.filter(t => t.containerIds?.length > 0);

  function handleCreate() {
    if (!selectedTool) return;
    onCreate({
      toolId:       selectedTool.id,
      toolName:     selectedTool.name,
      containerIds: selectedTool.containerIds,
      note,
    });
    setNote("");
  }

  return (
    <div className="snap-create">
      <div className="snap-create__heading">
        <Camera size={13} /> CREATE SNAPSHOT
      </div>

      <div className="snap-create__body">
        <div className="snap-field">
          <label className="snap-field__label">SELECT TOOL</label>
          {deployedTools.length === 0 ? (
            <p className="snap-field__hint">No deployed tools found. Start a tool from the Dashboard first.</p>
          ) : (
            <div className="snap-tool-list">
              {deployedTools.map(t => (
                <button
                  key={t.id}
                  className={`snap-tool-item ${selectedTool?.id === t.id ? "snap-tool-item--active" : ""}`}
                  onClick={() => setSelectedTool(t)}
                >
                  <div className="snap-tool-item__left">
                    {t.compose ? <Layers size={12} /> : <Package size={12} />}
                    <div>
                      <div className="snap-tool-item__name">{t.name}</div>
                      <div className="snap-tool-item__meta">
                        {t.containerIds.length} container{t.containerIds.length !== 1 ? "s" : ""}
                        {" · "}
                        <span className={`snap-tool-item__status snap-tool-item__status--${t.status}`}>
                          {t.status}
                        </span>
                      </div>
                    </div>
                  </div>
                  {selectedTool?.id === t.id && <Check size={12} />}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="snap-field">
          <label className="snap-field__label">NOTE (OPTIONAL)</label>
          <input
            className="snap-field__input"
            placeholder="e.g. Before v2.1 upgrade"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>

        {selectedTool && (
          <div className="snap-create__preview">
            <div className="snap-create__preview-label">WILL COMMIT</div>
            {selectedTool.containerIds.map((id, i) => (
              <div key={id} className="snap-create__preview-image">
                athena-snapshot/{selectedTool.id}-{i}:snap-&lt;timestamp&gt;
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="snap-create__footer">
        <button
          className="snap-btn snap-btn--primary"
          onClick={handleCreate}
          disabled={!selectedTool || creating}
        >
          {creating
            ? <><RefreshCw size={12} className="spin" /> Committing…</>
            : <><Camera size={12} /> Take Snapshot</>}
        </button>
      </div>

      {/* Info callout */}
      <div className="snap-info">
        <AlertTriangle size={11} />
        <p>Snapshots commit the <strong>current container filesystem</strong> to a local image. Export to .tar for off-machine backup.</p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────── //
export default function SnapshotPage() {
  const { tools } = useContainer();

  const [snaps,     setSnaps]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [creating,  setCreating]  = useState(false);
  const [exporting, setExporting] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [error,     setError]     = useState(null);
  const [filter,    setFilter]    = useState("all");

  // ── Load ─────────────────────────────────────────────── //
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke("snapshot_list");
      setSnaps(list || []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Create ────────────────────────────────────────────── //
  async function handleCreate(args) {
    setCreating(true);
    setError(null);
    try {
      await invoke("snapshot_create", args);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  // ── Export ────────────────────────────────────────────── //
  async function handleExport(id) {
    setExporting(id);
    setError(null);
    try {
      await invoke("snapshot_export", { snapshotId: id });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(null);
    }
  }

  // ── Restore ───────────────────────────────────────────── //
  async function handleRestore(id) {
    setRestoring(id);
    setError(null);
    try {
      await invoke("snapshot_restore", { snapshotId: id });
    } catch (e) {
      setError(String(e));
    } finally {
      setRestoring(null);
    }
  }

  // ── Delete ────────────────────────────────────────────── //
  async function handleDelete(id) {
    setError(null);
    try {
      await invoke("snapshot_delete", { snapshotId: id });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Edit note ─────────────────────────────────────────── //
  async function handleNoteEdit(id, note) {
    try {
      await invoke("snapshot_update_note", { snapshotId: id, note });
      setSnaps(prev => prev.map(s => s.id === id ? { ...s, note } : s));
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Filter ────────────────────────────────────────────── //
  const visible = useMemo(() => {
    if (filter === "exported") return snaps.filter(s => s.exported);
    if (filter === "committed") return snaps.filter(s => !s.exported);
    return snaps;
  }, [snaps, filter]);

  const totalSize = snaps.reduce((acc, s) => acc + (s.size_bytes || 0), 0);

  return (
    <div className="snap-page">
      <TopBar title="Snapshot & Backup"
        titleIcon="Camera" onRefresh={load} />

      {/* Stats bar */}
      <div className="snap-toolbar">
        <div className="snap-stats">
          <div className="snap-stat">
            <span className="snap-stat__val">{snaps.length}</span>
            <span className="snap-stat__lbl">SNAPSHOTS</span>
          </div>
          <div className="snap-stat snap-stat--cyan">
            <span className="snap-stat__val">{snaps.filter(s => s.exported).length}</span>
            <span className="snap-stat__lbl">EXPORTED</span>
          </div>
          <div className="snap-stat">
            <span className="snap-stat__val">{fmtBytes(totalSize)}</span>
            <span className="snap-stat__lbl">TOTAL SIZE</span>
          </div>
        </div>

        <div className="snap-filters">
          {["all", "exported", "committed"].map(f => (
            <button
              key={f}
              className={`snap-filter ${filter === f ? "snap-filter--active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="snap-error">
          <AlertTriangle size={13} /> {error}
          <button onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Two-column body */}
      <div className="snap-body">
        {/* Snapshots list */}
        <div className="snap-list-col">
          {loading ? (
            <div className="snap-loading"><RefreshCw size={18} className="spin" /> Loading…</div>
          ) : visible.length === 0 ? (
            <div className="snap-empty">
              <Camera size={36} />
              <p>{filter !== "all" ? `No ${filter} snapshots.` : "No snapshots yet."}</p>
              <small>Take a snapshot of any running tool using the panel →</small>
            </div>
          ) : (
            visible.map(snap => (
              <SnapCard
                key={snap.id}
                snap={snap}
                onExport={handleExport}
                onRestore={handleRestore}
                onDelete={handleDelete}
                onNoteEdit={handleNoteEdit}
                exporting={exporting}
                restoring={restoring}
              />
            ))
          )}
        </div>

        {/* Create panel */}
        <CreatePanel tools={tools} onCreate={handleCreate} creating={creating} />
      </div>
    </div>
  );
}
