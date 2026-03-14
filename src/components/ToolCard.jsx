import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Play,
  Square,
  RotateCcw,
  Download,
  ExternalLink,
  Terminal,
  ChevronDown,
  ChevronUp,
  Layers,
  Cpu,
  MemoryStick,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader,
  Activity,
  Rocket,
  Ban,
  Trash2,
} from "lucide-react";
import { IS_TAURI } from "../lib/container";
import "./ToolCard.css";

const STATUS_CONFIG = {
  running:    { label: "RUNNING",    color: "green",  Icon: CheckCircle2 },
  stopped:    { label: "STOPPED",    color: "muted",  Icon: Square },
  error:      { label: "ERROR",      color: "red",    Icon: XCircle },
  updating:   { label: "UPDATING",   color: "cyan",   Icon: Loader },
  starting:   { label: "STARTING",   color: "amber",  Icon: Loader },
  stopping:   { label: "STOPPING",   color: "amber",  Icon: Loader },
  restarting: { label: "RESTARTING", color: "cyan",   Icon: Loader },
  deleting:   { label: "DELETING",   color: "red",    Icon: Loader },
};

const HEALTH_CONFIG = {
  healthy:      { label: "HEALTHY",      color: "green" },
  unhealthy:    { label: "UNHEALTHY",    color: "red"   },
  ready:        { label: "READY",        color: "blue"  },
  unresponsive: { label: "UNRESPONSIVE", color: "red"   },
};

function StatusDot({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.stopped;
  return (
    <span className={`status-dot status-dot--${cfg.color}`} title={cfg.label} />
  );
}

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.stopped;
  const { Icon } = cfg;
  return (
    <span className={`status-badge status-badge--${cfg.color}`}>
      <Icon size={10} className={["updating","starting","stopping","restarting","deleting"].includes(status) ? "spin" : ""} />
      {cfg.label}
    </span>
  );
}

function MiniBar({ value, max = 100, color = "cyan" }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="mini-bar">
      <div
        className={`mini-bar__fill mini-bar__fill--${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function ToolCard({ tool, onAction, runtimeConnected = true }) {
  const [expanded, setExpanded]                 = useState(false);
  const [confirmDelete, setConfirmDelete]       = useState(false);
  const [composePopoverOpen, setComposePopover] = useState(false);
  const [composePopoverPos, setComposePopoverPos] = useState({ top: 0, left: 0 });
  const composeBadgeRef                         = useRef(null);
  const deleteWrapRef                     = useRef(null);

  // Dismiss confirm popover when clicking outside the card
  useEffect(() => {
    if (!composePopoverOpen) return;
    function onOutside(e) {
      if (composeBadgeRef.current && !composeBadgeRef.current.contains(e.target)) {
        setComposePopover(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [composePopoverOpen]);

  // Dismiss confirm popover when clicking outside the card
  useEffect(() => {
    if (!confirmDelete) return;
    function onOutside(e) {
      if (deleteWrapRef.current && !deleteWrapRef.current.contains(e.target)) {
        setConfirmDelete(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [confirmDelete]);
  const isRunning   = tool.status === "running";
  const isUpdating  = tool.status === "updating";
  const isStale     = !runtimeConnected;
  // Any transient state — locks out all action buttons
  const isBusy      = ["updating","starting","stopping","restarting","deleting"].includes(tool.status);
  // A tool is "deployed" if it has at least one known container (even if stopped)
  const isDeployed  = (tool.containerIds?.length ?? 0) > 0;
  const memGB = tool.mem >= 1024
    ? `${(tool.mem / 1024).toFixed(1)} GB`
    : `${tool.mem} MB`;

  // ── Live uptime ticker ────────────────────────────────── //
  const [uptime, setUptime] = useState(tool.uptime || null);
  useEffect(() => {
    const startedAt = tool.startedAt;
    if (!isRunning || !startedAt || startedAt <= 0) {
      setUptime(tool.uptime || null);
      return;
    }
    function tick() {
      const secs = Math.floor(Date.now() / 1000) - startedAt;
      if (secs < 0) { setUptime(null); return; }
      if (secs < 60)   { setUptime(`${secs}s`); return; }
      if (secs < 3600) { setUptime(`${Math.floor(secs / 60)}m ${secs % 60}s`); return; }
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      if (h < 24)      { setUptime(`${h}h ${m}m`); return; }
      const d = Math.floor(h / 24);
      setUptime(`${d}d ${h % 24}h ${m}m`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning, tool.startedAt, tool.uptime]);

  function handleAction(action, e) {
    e.stopPropagation();
    if (isStale) return;
    onAction?.(action, tool);
  }

  async function handleAbort(e) {
    e.stopPropagation();
    if (IS_TAURI) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("cancel_deploy");
      } catch (_) {}
    }
    onAction?.("abort", tool);
  }

  return (
    <div
      className={`tool-card tool-card--${tool.status} ${expanded ? "tool-card--expanded" : ""} ${isStale ? "tool-card--stale" : ""}`}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Running glow accent */}
      {isRunning && !isStale && <div className="tool-card__glow" />}

      {/* Stale overlay badge */}
      {isStale && (
        <div className="tool-card__stale-badge" title="Podman offline — last known state">
          OFFLINE
        </div>
      )}

      {/* ── Header row ────────────────────────── */}
      <div className="tool-card__header">
        <div className="tool-card__identity">
          <StatusDot status={tool.status} />
          <div className="tool-card__name-block">
            <span className="tool-card__name">{tool.name}</span>
            {tool.compose && (
              <div className="tool-card__compose-badge-wrap" ref={composeBadgeRef}>
                <span
                  className={`tool-card__compose-tag${tool.containers?.length > 0 ? " tool-card__compose-tag--clickable" : ""}`}
                  title={tool.containers?.length > 0 ? "Click to see containers" : `Docker Compose stack`}
                  onClick={tool.containers?.length > 0 ? (e) => {
                    e.stopPropagation();
                    if (!composePopoverOpen) {
                      const rect = composeBadgeRef.current?.getBoundingClientRect();
                      if (rect) setComposePopoverPos({ top: rect.bottom + 6, left: rect.left });
                    }
                    setComposePopover(v => !v);
                  } : undefined}
                >
                  <Layers size={9} /> COMPOSE
                  {tool.containerIds?.length > 1 && (
                    <span className="tool-card__compose-count">{tool.containerIds.length}</span>
                  )}
                </span>
              </div>
            )}
            {tool.cli_tool && (
              <span className="tool-card__compose-tag tool-card__compose-tag--cli" title="CLI tool — exec into container to run commands">
                <Terminal size={9} /> CLI
              </span>
            )}
          </div>
        </div>

        <div className="tool-card__header-right">
          <StatusBadge status={tool.status} />
          <button
            className="tool-card__expand-btn"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

      {/* ── Description ───────────────────────── */}
      <p className="tool-card__desc">{tool.description}</p>

      {/* ── Metrics row ───────────────────────── */}
      {isRunning && (
        <div className="tool-card__metrics">
          <div className="tool-card__metric">
            <Cpu size={10} />
            <span className="mono">{tool.cpu.toFixed(1)}%</span>
            <MiniBar value={tool.cpu} max={100} color="cyan" />
          </div>
          <div className="tool-card__metric">
            <Activity size={10} />
            <span className="mono">{memGB}</span>
            <MiniBar value={tool.mem} max={4096} color="green" />
          </div>
          {uptime && (
            <div className="tool-card__metric">
              <Clock size={10} />
              <span className="mono tool-card__uptime">{uptime}</span>
            </div>
          )}
          {tool.health && (() => {
            const cfg = HEALTH_CONFIG[tool.health];
            if (!cfg) return null;
            const isGood = tool.health === "healthy" || tool.health === "ready";
            return (
              <div
                className={`tool-card__health tool-card__health--${cfg.color}`}
                title={tool.healthDetail || cfg.label}
              >
                <span className={`tool-card__health-dot${isGood ? " tool-card__health-dot--pulse" : ""}`} />
                {cfg.label}
              </div>
            );
          })()}
          {/* Show "CHECKING…" while running but no health result yet */}
          {!tool.health && tool.status === "running" && (tool.health_check || tool.cli_tool) && (
            <div className="tool-card__health tool-card__health--dim">
              <span className="tool-card__health-dot" />
              CHECKING…
            </div>
          )}
        </div>
      )}

      {/* ── Action buttons ────────────────────── */}
      <div className="tool-card__actions" onClick={(e) => e.stopPropagation()}>
        {/* While ANY operation is in progress: show Abort + Logs only.
            This covers updating, starting, stopping, restarting, and deleting. */}
        {isBusy ? (
          <>
            {/* Only show Abort for ops that can be cancelled (deploy/update).
                Stop/restart/delete complete quickly and shouldn't be killed mid-flight. */}
            {isUpdating && (
              <button
                className="tool-card__btn tool-card__btn--abort"
                onClick={handleAbort}
                title="Abort the running operation"
              >
                <Ban size={12} />
                Abort
              </button>
            )}
            <button
              className="tool-card__btn tool-card__btn--logs"
              style={{ marginLeft: isUpdating ? "auto" : undefined, flexShrink: 0 }}
              onClick={(e) => handleAction("logs", e)}
              title="View logs"
            >
              <Terminal size={12} />
            </button>
          </>
        ) : (
          <>
        {/* Deploy / Start / Stop */}
        {isRunning ? (
          <button
            className="tool-card__btn tool-card__btn--stop"
            onClick={(e) => handleAction("stop", e)}
            disabled={isStale}
            title="Stop"
          >
            <Square size={12} />
            Stop
          </button>
        ) : !isDeployed ? (
          <button
            className="tool-card__btn tool-card__btn--deploy"
            onClick={(e) => handleAction("deploy", e)}
            disabled={isStale}
            title="Pull image and start for the first time"
          >
            <Rocket size={12} />
            Deploy
          </button>
        ) : (
          <button
            className="tool-card__btn tool-card__btn--start"
            onClick={(e) => handleAction("start", e)}
            disabled={isStale}
            title="Start"
          >
            <Play size={12} />
            Start
          </button>
        )}

        <button
          className="tool-card__btn"
          onClick={(e) => handleAction("restart", e)}
          disabled={!isRunning || isStale}
          title="Restart"
        >
          <RotateCcw size={12} />
          Restart
        </button>

        <button
          className="tool-card__btn tool-card__btn--update"
          onClick={(e) => handleAction("update", e)}
          disabled={isStale || !isDeployed}
          title={!isDeployed ? "Deploy first to enable updates" : "Pull latest & update"}
        >
          <Download size={12} />
          Update
        </button>

        {/* Delete — confirm appears as a popover above the button, nothing shifts */}
        {isDeployed && (
          <div className="tool-card__delete-wrap" ref={deleteWrapRef} onClick={e => e.stopPropagation()}>
            {confirmDelete && (
              <div className="tool-card__confirm-popover">
                <span className="tool-card__confirm-label">Remove?</span>
                <button
                  className="tool-card__btn tool-card__btn--delete-confirm"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); handleAction("delete", e); }}
                >
                  <Trash2 size={11} /> Yes
                </button>
                <button
                  className="tool-card__btn"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                >
                  No
                </button>
              </div>
            )}
            <button
              className={`tool-card__btn tool-card__btn--delete${confirmDelete ? " tool-card__btn--delete-active" : ""}`}
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(v => !v); }}
              disabled={isStale}
              title="Remove containers and image"
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}

        <button
          className="tool-card__btn tool-card__btn--logs"
          style={{ marginLeft: "auto", flexShrink: 0 }}
          onClick={(e) => handleAction("logs", e)}
          disabled={isStale}
          title="View logs"
        >
          <Terminal size={12} />
        </button>

        {tool.entrypoint && (
          <button
            className="tool-card__btn tool-card__btn--open"
            style={{ flexShrink: 0 }}
            onClick={(e) => handleAction("open", e)}
            disabled={!isRunning || isStale}
            title={`Open: ${tool.entrypoint}`}
          >
            <ExternalLink size={12} />
          </button>
        )}
          </>
        )}
      </div>

      {/* ── Expanded details ──────────────────── */}
      {expanded && (
        <div className="tool-card__details animate-fade-in">
          {/* Compose container list */}
          {tool.compose && tool.containers?.length > 0 && (
            <div className="tool-card__detail-row tool-card__detail-row--containers">
              <span className="tool-card__detail-key">CONTAINERS</span>
              <div className="tool-card__container-list">
                {tool.containers.map((ct) => (
                  <div key={ct.id} className="tool-card__container-item">
                    <span className={`tool-card__container-dot dot--${ct.status === "running" ? "running" : ct.status === "error" ? "error" : "stopped"}`} />
                    <span className="tool-card__container-name mono">{ct.name}</span>
                    <span className={`tool-card__container-status tool-card__container-status--${ct.status}`}>{ct.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="tool-card__detail-row">
            <span className="tool-card__detail-key">IMAGE</span>
            <span className="tool-card__detail-val mono">{tool.image}</span>
          </div>
          <div className="tool-card__detail-row">
            <span className="tool-card__detail-key">VERSION</span>
            <span className="tool-card__detail-val mono">{tool.version}</span>
          </div>
          {tool.ports?.length > 0 && (
            <div className="tool-card__detail-row">
              <span className="tool-card__detail-key">PORTS</span>
              <span className="tool-card__detail-val">
                {tool.ports.map((p) => (
                  <span key={p} className="port-tag mono">{p}</span>
                ))}
              </span>
            </div>
          )}
          {tool.entrypoint && (
            <div className="tool-card__detail-row">
              <span className="tool-card__detail-key">ENTRY</span>
              <span className="tool-card__detail-val mono cyan-text">
                {tool.entrypoint}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Compose containers popover (portal — escapes card overflow) ── */}
      {composePopoverOpen && tool.containers?.length > 0 && createPortal(
        <div
          className="tool-card__compose-popover"
          style={{ top: composePopoverPos.top, left: composePopoverPos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tool-card__compose-popover-title">
            <Layers size={10} /> CONTAINERS
          </div>
          {tool.containers.map((ct) => (
            <div key={ct.id} className="tool-card__compose-popover-row">
              <span className={`tool-card__container-dot dot--${ct.status === "running" ? "running" : ct.status === "error" ? "error" : "stopped"}`} />
              <span className="tool-card__compose-popover-name">{ct.name}</span>
              <span className={`tool-card__compose-popover-status tool-card__compose-popover-status--${ct.status}`}>{ct.status}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
