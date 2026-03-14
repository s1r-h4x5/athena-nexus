// ═══════════════════════════════════════════════════════════
// components/LogDrawer.jsx — M5: Log Viewer
//
// Slide-in terminal drawer for a selected tool.
// Features:
//   - Auto-fetches on open, re-polls every LOG_POLL_MS while running
//   - Auto-scroll to bottom (pauses on manual scroll up)
//   - Log level colour-coding + filter pills (ALL/ERROR/WARN/INFO/DEBUG)
//   - Keyword search within visible lines
//   - Line count & container count meta bar
//   - Copy-all to clipboard
//   - Jump-to-bottom button
// ═══════════════════════════════════════════════════════════

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  X, Terminal, RefreshCw, Copy, Check,
  Search, ChevronDown, ChevronUp, Layers, AlertTriangle,
  Info, Bug, Zap, Trash2, CornerDownLeft, GripHorizontal,
} from "lucide-react";
import { useContainer } from "../context/ContainerContext";
import { IS_TAURI } from "../lib/container";
import "./LogDrawer.css";

const LOG_POLL_MS  = 3000;
const MAX_VISIBLE  = 1000;

// ── Classify a single log line ────────────────────────────── //
function classifyLine(line) {
  // Synthetic action lines injected by the context actions
  if (/^\[\d{4}-\d{2}-\d{2}.*\] [▶↺⬇]/.test(line)) return "info";
  if (/^\[\d{4}-\d{2}-\d{2}.*\] ✓/.test(line))       return "info";
  if (/^\[\d{4}-\d{2}-\d{2}.*\] ✗/.test(line))       return "error";
  if (/^\[\d{4}-\d{2}-\d{2}.*\] ⚠/.test(line))       return "warn";
  const u = line.toUpperCase();
  if (/\b(ERROR|FATAL|CRIT|CRITICAL|EMERG|ALERT|PANIC)\b/.test(u)) return "error";
  if (/\b(WARN|WARNING)\b/.test(u))                                  return "warn";
  if (/\b(DEBUG|TRACE|VERBOSE)\b/.test(u))                           return "debug";
  if (/\b(INFO|NOTICE)\b/.test(u))                                   return "info";
  return "plain";
}

const LEVEL_ICON = {
  error: <AlertTriangle size={10} />,
  warn:  <Zap          size={10} />,
  info:  <Info         size={10} />,
  debug: <Bug          size={10} />,
  plain: null,
};

// ── ANSI escape code parser ───────────────────────────────── //
const ANSI_COLORS = {
  30: "#4a4a4a", 31: "#ff5f57", 32: "#28c840", 33: "#febc2e",
  34: "#58a6ff", 35: "#d08ff0", 36: "#39c5cf", 37: "#cccccc",
  90: "#666666", 91: "#ff6e6e", 92: "#5af78e", 93: "#f4f99d",
  94: "#caa9fa", 95: "#ff92d0", 96: "#9aedfe", 97: "#ffffff",
};
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

function parseAnsi(text) {
  const segments = [];
  let last = 0, color = null, bold = false;
  ANSI_RE.lastIndex = 0;
  let m;
  while ((m = ANSI_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), color, bold });
    for (const code of m[1].split(";").map(Number)) {
      if (code === 0)          { color = null; bold = false; }
      else if (code === 1)     { bold = true; }
      else if (code === 22)    { bold = false; }
      else if (ANSI_COLORS[code]) { color = ANSI_COLORS[code]; }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), color, bold });
  return segments;
}

function AnsiText({ text }) {
  const segs = parseAnsi(text);
  if (segs.length === 1 && !segs[0].color && !segs[0].bold) return <>{text}</>;
  return <>{segs.map((s, i) => (
    <span key={i} style={{ color: s.color || undefined, fontWeight: s.bold ? "bold" : undefined }}>{s.text}</span>
  ))}</>;
}

// ── Single line ───────────────────────────────────────────── //
function LogLine({ text, lineNumber }) {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const level = classifyLine(stripped);
  const isAction = /^\[\d{4}-\d{2}-\d{2}.*\] [▶↺⬇✓✗⚠]/.test(stripped);
  return (
    <div className={`ld-line ld-line--${level}${isAction ? " ld-line--action" : ""}`}>
      <span className="ld-line__num">{String(lineNumber).padStart(4, "\u00a0")}</span>
      {LEVEL_ICON[level] && (
        <span className="ld-line__icon">{LEVEL_ICON[level]}</span>
      )}
      <span className="ld-line__text"><AnsiText text={text} /></span>
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────── //
export default function LogDrawer({ toolId, onClose }) {
  const { logs, fetchLogs, clearLogs, tools, activeRuntime } = useContainer();

  // Always resolve the LIVE tool from context so containerIds and status
  // are never stale (critical when opening logs right after Start/Update).
  const tool = useMemo(
    () => tools.find(t => t.id === toolId) || null,
    [tools, toolId]
  );

  const [search,      setSearch]      = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [autoScroll,  setAutoScroll]  = useState(true);
  const [loading,     setLoading]     = useState(false);
  const [copied,      setCopied]      = useState(false);

  // ── Exec terminal state ───────────────────────────────── //
  const [execInput,   setExecInput]   = useState("");
  const [execHistory, setExecHistory] = useState([]);
  const [execRunning, setExecRunning] = useState(false);
  const [historyIdx,  setHistoryIdx]  = useState(-1);
  const [execHeight,  setExecHeight]  = useState(220);  // px, user-resizable
  const [execCollapsed, setExecCollapsed] = useState(false);
  const execInputRef  = useRef(null);
  const execBodyRef   = useRef(null);
  const dragRef       = useRef({ dragging: false, startY: 0, startH: 0 });

  const bodyRef   = useRef(null);
  const bottomRef = useRef(null);
  const pollRef   = useRef(null);

  // Raw lines for this tool, capped for perf
  const rawLines = useMemo(() => {
    if (!tool) return [];
    return (logs[tool.id] || []).slice(-MAX_VISIBLE);
  }, [logs, tool]);

  // Filtered view
  const visibleLines = useMemo(() => {
    let lines = rawLines;
    if (levelFilter !== "all") {
      lines = lines.filter(l => classifyLine(l) === levelFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      lines = lines.filter(l => l.toLowerCase().includes(q));
    }
    return lines;
  }, [rawLines, search, levelFilter]);

  // Level counts for pill badges
  const levelCounts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0, debug: 0 };
    rawLines.forEach(l => {
      const lv = classifyLine(l);
      if (lv in c) c[lv]++;
    });
    return c;
  }, [rawLines]);

  // ── Fetch ──────────────────────────────────────────────── //
  const doFetch = useCallback(async () => {
    if (!tool) return;
    // Container may still be starting — containerIds gets populated after
    // the first successful pollContainers(). Retry silently if empty.
    if (!tool.containerIds?.length) return;
    setLoading(true);
    try { await fetchLogs(tool); }
    finally { setLoading(false); }
  }, [tool, fetchLogs]);

  // On tool change: reset UI + initial fetch
  useEffect(() => {
    if (!toolId) return;
    setSearch("");
    setLevelFilter("all");
    setAutoScroll(true);
    doFetch();
  }, [toolId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When containerIds becomes populated (container just started),
  // trigger an immediate fetch so logs appear without waiting for the poll.
  const prevContainerIdsLen = useRef(0);
  useEffect(() => {
    const len = tool?.containerIds?.length || 0;
    if (len > 0 && prevContainerIdsLen.current === 0) {
      doFetch();
    }
    prevContainerIdsLen.current = len;
  }, [tool?.containerIds?.length, doFetch]);

  // Auto-poll while drawer is open
  useEffect(() => {
    if (!toolId) return;
    clearInterval(pollRef.current);
    // Poll regardless of status — covers the "just started" window
    // where status may flicker between starting → running.
    pollRef.current = setInterval(doFetch, LOG_POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [toolId, doFetch]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [visibleLines, autoScroll]);

  // Detect manual scroll-up → pause auto-scroll
  function onBodyScroll() {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAutoScroll(atBottom);
  }

  // Copy all raw lines
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(rawLines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* silent */ }
  }

  function toggleAutoScroll() {
    if (autoScroll) {
      // Currently on → turn off (user wants to stop following)
      setAutoScroll(false);
    } else {
      // Currently off → jump to bottom and re-enable
      setAutoScroll(true);
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }

  if (!tool) return null;

  const hasContainers = (tool.containerIds?.length ?? 0) > 0;
  const containerId   = tool.containerIds?.[0] || null;

  // ── Run exec command ────────────────────────────────────── //
  async function runExec(e) {
    e?.preventDefault();
    const cmd = execInput.trim();
    if (!cmd || execRunning || !containerId || tool.status !== "running") return;

    setExecRunning(true);
    setExecInput("");
    setHistoryIdx(-1);

    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false, fractionalSecondDigits: 3 });
    let output = "", isError = false;

    try {
      if (IS_TAURI) {
        const { invoke } = await import("@tauri-apps/api/core");
        output = await invoke("exec_container", { containerId, command: cmd });
      } else {
        await new Promise(r => setTimeout(r, 300));
        output = `[mock] $ ${cmd}\n(exec output would appear here in Tauri)`;
      }
    } catch (err) {
      output = err?.message || String(err);
      isError = true;
    }

    setExecHistory(prev => [...prev, { cmd, output: output.trimEnd(), isError, ts }]);
    setExecRunning(false);
    setTimeout(() => {
      execBodyRef.current?.scrollTo({ top: execBodyRef.current.scrollHeight, behavior: "smooth" });
      execInputRef.current?.focus();
    }, 30);
  }

  function handleExecKeyDown(e) {
    const cmds = execHistory.map(h => h.cmd);
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = historyIdx < cmds.length - 1 ? historyIdx + 1 : historyIdx;
      setHistoryIdx(next);
      setExecInput(cmds[cmds.length - 1 - next] || "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = historyIdx > 0 ? historyIdx - 1 : -1;
      setHistoryIdx(next);
      setExecInput(next === -1 ? "" : cmds[cmds.length - 1 - next] || "");
    }
  }

  function onDragStart(e) {
    e.preventDefault();
    dragRef.current = { dragging: true, startY: e.clientY, startH: execHeight };
    const onMove = (ev) => {
      if (!dragRef.current.dragging) return;
      // Dragging up (negative delta) → increase height
      const delta = dragRef.current.startY - ev.clientY;
      const next  = Math.max(100, Math.min(600, dragRef.current.startH + delta));
      setExecHeight(next);
    };
    const onUp = () => {
      dragRef.current.dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }

  return (
    <>
      {/* Dim backdrop — click to close */}
      <div className="ld-backdrop" onClick={onClose} />

      <aside className="ld-panel">

        {/* ── Header ──────────────────────────────────────── */}
        <div className="ld-header">
          <div className="ld-header__left">
            <Terminal size={14} className="ld-header__icon" />
            <span className="ld-header__name">{tool.name}</span>
            {tool.compose && (
              <span className="ld-header__compose">
                <Layers size={9} /> COMPOSE
              </span>
            )}
            <span className={`ld-header__status ld-header__status--${tool.status}`}>
              {tool.status.toUpperCase()}
            </span>
          </div>

          <div className="ld-header__right">
            <button
              className={`ld-icon-btn${loading ? " ld-icon-btn--spinning" : ""}`}
              onClick={doFetch}
              title="Refresh logs"
            >
              <RefreshCw size={13} />
            </button>
            <button
              className="ld-icon-btn"
              onClick={handleCopy}
              title="Copy all logs"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <button
              className="ld-icon-btn ld-icon-btn--danger"
              onClick={() => tool && clearLogs(tool.id)}
              title="Clear logs"
            >
              <Trash2 size={13} />
            </button>
            <button
              className="ld-icon-btn ld-icon-btn--close"
              onClick={onClose}
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* ── Toolbar: search + level pills ───────────────── */}
        <div className="ld-toolbar">
          <div className="ld-search">
            <Search size={11} className="ld-search__icon" />
            <input
              className="ld-search__input"
              placeholder="Filter lines…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className="ld-search__clear" onClick={() => setSearch("")}>
                <X size={10} />
              </button>
            )}
          </div>

          <div className="ld-levels">
            {[
              { key: "all",   label: `ALL`,   count: rawLines.length },
              { key: "error", label: "ERROR",  count: levelCounts.error },
              { key: "warn",  label: "WARN",   count: levelCounts.warn },
              { key: "info",  label: "INFO",   count: levelCounts.info },
              { key: "debug", label: "DEBUG",  count: levelCounts.debug },
            ].map(({ key, label, count }) => (
              <button
                key={key}
                className={`ld-pill ld-pill--${key}${levelFilter === key ? " ld-pill--active" : ""}`}
                onClick={() => setLevelFilter(key)}
              >
                {label} <span className="ld-pill__count">{count}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── Meta bar ─────────────────────────────────────── */}
        <div className="ld-meta">
          <span>{tool.containerIds?.length ?? 0} container{tool.containerIds?.length !== 1 ? "s" : ""}</span>
          <span className="ld-meta__sep">·</span>
          <span>
            {visibleLines.length} line{visibleLines.length !== 1 ? "s" : ""}
            {(search || levelFilter !== "all") ? " (filtered)" : ""}
          </span>
          <div style={{ flex: 1 }} />
          <button
            className={`ld-autoscroll${autoScroll ? " ld-autoscroll--on" : ""}`}
            onClick={toggleAutoScroll}
            title={autoScroll ? "Pause auto-scroll" : "Jump to bottom & resume auto-scroll"}
          >
            <ChevronDown size={11} />
            {autoScroll ? "Auto-scroll on" : "Jump to bottom"}
          </button>
        </div>

        {/* ── Log body ─────────────────────────────────────── */}
        <div className="ld-body" ref={bodyRef} onScroll={onBodyScroll}>
          {visibleLines.length > 0 ? (
            <div className="ld-lines">
              {visibleLines.map((line, i) => (
                <LogLine key={i} text={line} lineNumber={i + 1} />
              ))}
              <div ref={bottomRef} />
            </div>
          ) : (
            <div className="ld-empty">
              <Terminal size={32} />
              <p>
                {loading
                  ? "Fetching logs…"
                  : search || levelFilter !== "all"
                    ? "No lines match the current filter."
                    : !hasContainers && (tool.status === "stopped")
                      ? "No containers running for this tool."
                      : "No log output yet."}
              </p>
              {!search && levelFilter === "all" && !hasContainers && tool.status === "stopped" && (
                <small>Start the tool to see logs.</small>
              )}
            </div>
          )}
        </div>

        {/* ── Exec terminal — CLI tools only ───────────────── */}
        {tool.cli_tool && (
          <div className="ld-exec" style={{ height: execCollapsed ? "auto" : execHeight }}>

            {/* Drag-to-resize handle — only when expanded */}
            {!execCollapsed && (
              <div className="ld-exec__resize-handle" onMouseDown={onDragStart} title="Drag to resize">
                <GripHorizontal size={14} />
              </div>
            )}

            <div className="ld-exec__header">
              <Terminal size={11} />
              <span>EXEC</span>
              <span className="ld-exec__container mono">{containerId ? containerId.slice(0, 12) : "no container"}</span>
              <button
                className="ld-exec__collapse-btn"
                onClick={() => setExecCollapsed(c => !c)}
                title={execCollapsed ? "Expand exec panel" : "Collapse exec panel"}
              >
                {execCollapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            </div>

            {!execCollapsed && (
              <>
                {/* Output history */}
                <div className="ld-exec__body" ref={execBodyRef}>
                  {execHistory.length === 0 && (
                    <div className="ld-exec__hint">
                      Type a command and press Enter — runs inside the container via <code>{activeRuntime} exec</code>
                    </div>
                  )}
                  {execHistory.map((h, i) => (
                    <div key={i} className="ld-exec__entry">
                      <div className="ld-exec__cmd">
                        <span className="ld-exec__ts">{h.ts}</span>
                        <span className="ld-exec__prompt">$</span>
                        <span className="ld-exec__cmd-text">{h.cmd}</span>
                      </div>
                      {h.output && (
                        <pre className={`ld-exec__output${h.isError ? " ld-exec__output--error" : ""}`}>
                          {h.output}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>

                {/* Input row */}
                <form className="ld-exec__input-row" onSubmit={runExec}>
                  <span className="ld-exec__prompt-static">$</span>
                  <input
                    ref={execInputRef}
                    className="ld-exec__input"
                    value={execInput}
                    onChange={e => setExecInput(e.target.value)}
                    onKeyDown={handleExecKeyDown}
                    placeholder={
                      !containerId            ? "no running container" :
                      tool.status !== "running" ? `container ${tool.status}…` :
                      `${tool.id} --help`
                    }
                    disabled={execRunning || !containerId || tool.status !== "running"}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    className="ld-exec__run-btn"
                    disabled={execRunning || !execInput.trim() || !containerId}
                    title="Run (Enter)"
                  >
                    {execRunning
                      ? <RefreshCw size={12} className="ld-exec__spin" />
                      : <CornerDownLeft size={12} />}
                  </button>
                </form>
              </>
            )}
          </div>
        )}

      </aside>
    </>
  );
}
