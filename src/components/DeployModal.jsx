// ═══════════════════════════════════════════════════════════
// components/DeployModal.jsx
// ═══════════════════════════════════════════════════════════

import React, { useState, useEffect, useRef } from "react";
import {
  X, CheckCircle2, XCircle, AlertTriangle, Loader,
  Download, Layers, Terminal, ExternalLink,
  ChevronDown, ChevronUp, RefreshCw, Trash2, Upload,
  Eye, EyeOff, Wand2, Settings2,
} from "lucide-react";
import { useContainer, buildEnvFromVars } from "../context/ContainerContext";
import { IS_TAURI } from "../lib/container";
import { fullImage, displayImage } from "../lib/imageUtils";
import { diagnoseError } from "../lib/diagnoseError";
import "./DeployModal.css";

// ── Helpers (module-level — only use parameters, never outer scope) ── //

async function checkPortInUse(port) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("check_port_in_use", { port });
  } catch {
    return false;
  }
}

// entry = the resolved fresh entry passed in as a parameter
async function runPreflightChecks(entry, liveTools, runtimeName = "container") {
  const checks = [];

  // 1. Port availability
  // If this tool is already running, its own ports will appear "in use" — skip those.
  const toolIsRunning = liveTools.some(t => t.id === entry.id && t.status === "running");

  const entryPorts = entry.access?.ports || entry.ports || [];
  if (entryPorts.length > 0) {
    for (const portSpec of entryPorts) {
      const hostPort = String(portSpec).includes(":")
        ? parseInt(String(portSpec).split(":")[0], 10)
        : parseInt(String(portSpec), 10);
      const label = String(portSpec).includes(":") ? `Port ${portSpec} available` : `Port ${hostPort} available`;
      // If tool is already running, its ports are legitimately occupied by itself — pass
      const inUse = toolIsRunning ? false : (IS_TAURI ? await checkPortInUse(hostPort) : false);
      checks.push({
        id: `port-${portSpec}`,
        label,
        status: inUse ? "fail" : "pass",
        detail: inUse ? `Port ${hostPort} is already in use on this host` : null,
      });
    }
  }

  // 2. Compose source flagged
  const composeUrl  = entry.source?.compose_url  || entry.compose_url;
  const composeFile = entry.source?.compose_file || entry.compose_file;
  if (composeUrl || composeFile) {
    checks.push({
      id: "compose-source",
      label: "Compose source available",
      status: "pass",
      detail: composeUrl || composeFile,
    });
  }

  // 3. Runtime socket — label reflects the actually-configured runtime
  const runtimeLabel = runtimeName === "docker" ? "Docker" : runtimeName === "podman" ? "Podman" : "Container runtime";
  checks.push({ id: "runtime-socket", label: `${runtimeLabel} socket reachable`, status: "pass", detail: null });

  // 4. Conflicting container
  const conflict = liveTools.find(t => t.id === entry.id && t.containerIds?.length > 0);
  checks.push({
    id: "no-conflict",
    label: "No existing container conflict",
    status: conflict ? "warn" : "pass",
    detail: conflict ? `${entry.name} already has containers. Deploying will recreate them.` : null,
  });

  return checks;
}

const STEPS = {
  IDLE: "idle", PREFLIGHT: "preflight", ENV_CONFIG: "env_config", PULLING: "pulling",
  STARTING: "starting", DELETING: "deleting", DONE: "done", ERROR: "error",
};

// ── Component ─────────────────────────────────────────────── //

export default function DeployModal({ entry, liveTool, onClose, onDismiss = null, visible = true }) {
  const { startTool, updateTool, manualRefresh, activeRuntime } = useContainer();

  const [step, setStep]                   = useState(STEPS.IDLE);
  const [checks, setChecks]               = useState([]);
  const [logLines, setLogLines]           = useState([]);
  const [error, setError]                 = useState(null);
  const [showLog, setShowLog]             = useState(true);
  const [showEnvConfig, setShowEnvConfig] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmAbort,  setConfirmAbort]  = useState(false);
  const [envValues, setEnvValues]         = useState({});   // user-edited env values
  const [showSecrets, setShowSecrets]     = useState({});   // per-key show/hide

  // freshEntry: always reflects what's in tools.json on disk.
  // Initialised from prop, overwritten by load_registry on mount.
  const [freshEntry, setFreshEntry] = useState(entry);
  const freshEntryRef               = useRef(entry); // ref for use inside async handlers

  const logRef          = useRef(null);
  const cancelRef       = useRef(false);
  const preflightRanRef = useRef(false);
  const isUpdatingRef   = useRef(false); // true when PULLING was triggered by handleUpdate, not handleDeploy
  const isFirstDeployRef = useRef(false); // true when PULLING is a brand-new first deploy (no containers yet)
  const modalMountedRef = useRef(true);  // false after unmount — guards async callbacks

  // Clear terminal buffer when modal mounts (prevents stale output from a previous tool)
  useEffect(() => {
    modalMountedRef.current = true;
    termBufRef.current = [];
    termLayersRef.current = new Map();
    if (logRef.current) logRef.current.innerHTML = "";
    return () => { modalMountedRef.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep ref in sync with state
  useEffect(() => { freshEntryRef.current = freshEntry; }, [freshEntry]);

  // On mount: load fresh registry entry, THEN run preflight with it
  useEffect(() => {
    let cancelled = false;

    async function loadAndPreflight() {
      // 1. Read fresh data from disk
      let resolved = { ...entry };
      if (IS_TAURI) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const reg = await invoke("load_registry");
          const found = reg.find(e => e.id === entry.id);
          if (found) resolved = { ...entry, ...found };
        } catch (_) {}
      }

      if (cancelled) return;

      // 2. Update both state (display) and ref (handlers)
      setFreshEntry(resolved);
      freshEntryRef.current = resolved;

      // 3. Run preflight exactly once with the resolved entry
      if (preflightRanRef.current) return;
      preflightRanRef.current = true;

      setStep(STEPS.PREFLIGHT);
      addLog("Running pre-flight checks…", "info");

      // runPreflightChecks uses `resolved` — its own parameter, no outer scope
      const results = await runPreflightChecks(resolved, liveTool ? [liveTool] : [], activeRuntime);

      if (cancelled) return;

      for (const check of results) {
        await new Promise(r => setTimeout(r, 180));
        if (cancelled) return;
        setChecks(prev => [...prev, check]);
        if (check.status === "pass")      addLog(`✓ ${check.label}`, "success");
        else if (check.status === "warn") addLog(`⚠ ${check.label}: ${check.detail}`, "warn");
        else                              addLog(`✗ ${check.label}: ${check.detail}`, "error");
      }

      const hasFail = results.some(c => c.status === "fail");
      if (hasFail) {
        setStep(STEPS.ERROR);
        setError("Pre-flight checks failed. Resolve the issues above before deploying.");
      } else {
        // If this tool has required env vars, show the config step
        const envVarDefs = resolved.env_vars || [];
        if (envVarDefs.length > 0) {
          // Initialize envValues with defaults
          const initial = {};
          for (const def of envVarDefs) {
            initial[def.key] = def.default || "";
          }
          setEnvValues(initial);
          setStep(STEPS.ENV_CONFIG);
          addLog("Pre-flight checks passed. Configure required variables before deploying.", "success");
        } else {
          setStep(STEPS.IDLE);
          addLog("Pre-flight checks passed. Ready to deploy.", "success");
        }
      }
    }

    loadAndPreflight();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isDeployed = liveTool && liveTool.containerIds?.length > 0;
  const isRunning  = liveTool?.status === "running";

  // ── Terminal buffer ──────────────────────────────────────────
  // termBuf: array of { text, color } lines rendered as a <pre> block.
  // Layer lines are stored in termLayers map (layerId → index in termBuf)
  // so each layer occupies exactly ONE row, updated in-place.
  const termBufRef    = useRef([]);   // { text: string, color: string }[]
  const termLayersRef = useRef(new Map()); // layerId → index in termBuf
  const termRafRef    = useRef(null);

  // Matches both "abc123def456: Downloading 45MB/98MB" (Docker)
  // and "abc123def456  Downloading..." (Podman without colon)
  // and "   ✔ abc123def456 Pull complete" (compose up output, indented with checkmark)
  const LAYER_RE      = /(?:^|[\s✔✓])([a-f0-9]{12})(?::\s*|\s+)(.+)$/i;
  const PULL_STATUS_RE = /^(Pulling from|Pulling fs layer|Copying blob|Copying config|Writing manifest|Waiting|Downloading|Extracting|Pull complete|Download complete|Already exists|Digest:|Status:|Image\s)/i;
  // Lines from compose stderr that indicate image pulling progress
  const COMPOSE_PULL_RE = /([a-f0-9]{12}).*(?:Downloading|Extracting|Pull complete|Already exists|Waiting|Pulling)/i;

  function flushTerm() {
    if (termRafRef.current) return;
    termRafRef.current = requestAnimationFrame(() => {
      termRafRef.current = null;
      if (!logRef.current) return;
      // Each line is its own <div> so that inline-block bar spans never collide
      // with adjacent text (avoids overlap that occurs when joining with \n in <pre>).
      logRef.current.innerHTML = termBufRef.current
        .map(l => l.html
          ? `<div style="display:flex;align-items:center;gap:4px;min-height:1.65em">${l.html}</div>`
          : `<div><span style="color:${l.color}">${escHtml(l.text)}</span></div>`)
        .join("");
      logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function termWrite(text, color = "#c8d3f5") {
    termBufRef.current.push({ text, color });
    flushTerm();
  }

  function termUpsertLayer(layerId, html) {
    const layers = termLayersRef.current;
    if (layers.has(layerId)) {
      termBufRef.current[layers.get(layerId)].html = html;
    } else {
      const idx = termBufRef.current.length;
      layers.set(layerId, idx);
      termBufRef.current.push({ html });  // html flag — rendered without escaping
    }
    flushTerm();
  }

  function addLog(line, type = "info") {
    const color = type === "error"   ? "#ff5370"
                : type === "warn"    ? "#ffc777"
                : type === "success" ? "#c3e88d"
                : type === "pass"    ? "#c3e88d"
                : "#c8d3f5";
    termWrite(line, color);
  }

  /**
   * Render a layer progress line with a visual █░ bar.
   * Input examples (after ANSI strip):
   *   "abc123def456: Downloading  45.3MB / 98.7MB"
   *   "abc123def456: Extracting   12.1MB / 50.0MB"
   *   "abc123def456: Pull complete"
   *   "abc123def456: Already exists"
   *   "abc123def456: Waiting"
   */
  // Returns an HTML string for a layer progress line.
  // Uses a CSS-width inline bar instead of Unicode block chars which are double-width
  // in most monospace fonts and cause text overlap.
  function formatLayerLine(layerId, rest) {
    const BAR_PX = 120; // fixed pixel width for the bar element
    const bytesRe = /([\d.]+)\s*([kKmMgG]i?[Bb]|[kKmMgG][Bb]|[bB])\s*\/\s*([\d.]+)\s*([kKmMgG]i?[Bb]|[kKmMgG][Bb]|[bB])/;
    const m = rest.match(bytesRe);

    function toMB(val, unit) {
      const n = parseFloat(val);
      const u = unit.toUpperCase().replace("I", "");
      if (u === "KB") return n / 1024;
      if (u === "GB") return n * 1024;
      if (u === "B")  return n / (1024 * 1024);
      return n;
    }

    const short = layerId.slice(0, 12);
    const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    function renderBar(pct, label, pctStr) {
      const fillPx = Math.round(pct * BAR_PX);
      // Fixed-width CSS bar — no Unicode block chars (they are double-width in monospace)
      const bar = `<span style="display:inline-block;width:${BAR_PX}px;height:9px;background:#1e2030;border-radius:2px;overflow:hidden;flex-shrink:0"><span style="display:block;width:${fillPx}px;height:100%;background:#4fd6be"></span></span>`;
      return `<span style="color:#7dcfff;flex-shrink:0">${esc(short)}</span><span style="color:#636da6;width:88px;flex-shrink:0;overflow:hidden">${esc(label.slice(0,11))}</span>${bar}<span style="color:#c3e88d;flex-shrink:0">${esc(pctStr)}</span>`;
    }

    if (m) {
      const done  = toMB(m[1], m[2]);
      const total = toMB(m[3], m[4]);
      const pct   = total > 0 ? Math.min(1, done / total) : 0;
      const pctStr = (pct * 100).toFixed(0).padStart(3) + "%";
      const statusMatch = rest.match(/^(\w+)/);
      const label = statusMatch ? statusMatch[1] : "Downloading";
      return renderBar(pct, label, pctStr);
    }

    // No byte counts: status-only line
    const statusClean = rest.trim();
    if (statusClean.toLowerCase().includes("complete") || statusClean.toLowerCase().includes("exists")) {
      return renderBar(1, statusClean, "100%");
    }
    // Waiting / Pulling fs layer / etc — no bar yet
    return `<span style="color:#7dcfff">${esc(short)}</span>  <span style="color:#636da6">${esc(statusClean)}</span>`;
  }

  function upsertLayerLog(line) {
    const layerMatch = line.match(LAYER_RE);
    if (layerMatch) {
      // layerMatch[1] = leading char or undefined (non-capturing prefix group),
      // actual layer ID is in [1], rest in [2] due to (?:^|[\s✔✓]) non-capturing prefix.
      // Re-extract with a simpler targeted regex to get clean ID + rest.
      const idMatch = line.match(/([a-f0-9]{12})(?::\s*|\s+)(.+)$/i);
      if (idMatch) {
        const formatted = formatLayerLine(idMatch[1], idMatch[2]);
        termUpsertLayer(idMatch[1], formatted);
      } else {
        addLog(line, "info");
      }
    } else {
      addLog(line, "info");
    }
  }

  // Auto-scroll (kept for non-terminal parts — terminal scrolls itself in flushTerm)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  async function handleDeploy() {
    cancelRef.current = false;
    isUpdatingRef.current = false;
    isFirstDeployRef.current = !isDeployed; // snapshot at click time — liveTool may change during pull
    setConfirmAbort(false);
    setError(null);
    setShowEnvConfig(false);
    setLogLines([]);
    termBufRef.current = [];
    termLayersRef.current = new Map();

    const fe = freshEntryRef.current;
    const isCompose = !!(fe.source?.compose_url || fe.source?.compose_file || fe.source?.compose_repo ||
                         fe.compose_url || fe.compose_file || fe.compose_repo ||
                         (liveTool?.containerIds?.length > 1));
    const finalEnv = buildEnvFromVars(fe, envValues);

    try {
      setStep(STEPS.PULLING);
      addLog(isCompose ? `Deploying compose stack: ${fe.name}…` : `Pulling image: ${fullImage(fe)}…`, "info");

      if (IS_TAURI) {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen("deploy:progress", (event) => {
          if (cancelRef.current) return;
          // Strip ANSI escape sequences
          // eslint-disable-next-line no-control-regex
          const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\[[\d;]*[mGKHF]/g, "");
          const raw = stripAnsi(typeof event.payload === "string" ? event.payload : String(event.payload));
          if (!raw.trim()) return;

          if (raw.startsWith("stderr: ")) {
            const errLine = raw.slice(8);
            // Compose up writes all progress (including image pulls) to stderr.
            // Route pull/layer lines through the progress bar renderer instead
            // of showing them in red as errors.
            if (LAYER_RE.test(errLine) || PULL_STATUS_RE.test(errLine) || COMPOSE_PULL_RE.test(errLine)) {
              upsertLayerLog(errLine);
            } else {
              addLog(errLine, "error");
              const hint = diagnoseError(errLine);
              if (hint) addLog(`  ↳ ${hint}`, "warn");
            }
          } else if (PULL_STATUS_RE.test(raw) || LAYER_RE.test(raw)) {
            upsertLayerLog(raw);
          } else {
            addLog(raw, "info");
          }
        });

        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const result = await invoke("deploy_tool", {
            toolId:               fe.id,
            image:                isCompose ? "" : fullImage(fe),
            composeUrl:           fe.source?.compose_url      || fe.compose_url      || null,
            composeFile:          fe.source?.compose_file     || fe.compose_file     || null,
            composeRepo:          fe.source?.compose_repo     || fe.compose_repo     || null,
            composeRepoTag:       fe.source?.compose_repo_tag || fe.compose_repo_tag || null,
            composeSubdir:        fe.source?.compose_subdir   || fe.compose_subdir   || null,
            preDeploy:            fe.source?.pre_deploy       || fe.pre_deploy       || [],
            ports:                fe.access?.ports            || fe.ports            || [],
            entrypoint:           fe.access?.entrypoint       || fe.entrypoint       || null,
            cliTool:              fe.cli_tool              || false,
            env:                  finalEnv,
            portOverrides:        fe.source?.port_overrides   || fe.compose_port_overrides || {},
          });
          if (result?.success === false) throw new Error(result.message || "Deploy failed");
        } finally {
          unlisten();
        }
      } else {
        const steps = isCompose
          ? ["Downloading compose file…", "Pulling service images…", "Starting containers…", "Stack started."]
          : [`Pulling from ${fullImage(fe)}`, "Downloading: 50%", "Download complete", `Downloaded ${displayImage(fe)}`];
        for (const msg of steps) {
          if (cancelRef.current) return;
          await new Promise(r => setTimeout(r, 350 + Math.random() * 200));
          addLog(msg, "info");
        }
      }

      if (cancelRef.current) return;
      addLog(isCompose ? "Compose stack ready." : "Image ready.", "success");

      if (isCompose) {
        // Compose orchestrates its own container lifecycle — some containers (init jobs,
        // config generators) intentionally exit after a few seconds. We don't wait for
        // all containers to be "running"; the stack is ready when compose up returns.
        await manualRefresh();
        addLog(`✓ ${fe.name} deployed.`, "success");
        if (fe.access?.entrypoint || fe.entrypoint) addLog(`Access at: ${fe.access?.entrypoint || fe.entrypoint}`, "info");
        setStep(STEPS.DONE);
      } else {
        setStep(STEPS.STARTING);
        addLog(`Starting ${fe.name}…`, "info");
        if (!IS_TAURI) await new Promise(r => setTimeout(r, 600));
        if (liveTool?.containerIds?.length > 0) await startTool(liveTool);
        await new Promise(r => setTimeout(r, 400));
        await manualRefresh();
        addLog(`${fe.name} is running.`, "success");
        if (fe.entrypoint) addLog(`Access at: ${fe.entrypoint}`, "info");
        setStep(STEPS.DONE);
      }

    } catch (err) {
      if (cancelRef.current) return;
      const msg = err?.message || String(err);
      addLog(`Error: ${msg}`, "error");
      setError(msg);
      setStep(STEPS.ERROR);
    }
  }

  async function handleUpdate() {
    if (!liveTool) return;
    isUpdatingRef.current = true;
    setStep(STEPS.PULLING);
    setError(null);
    try {
      await updateTool(liveTool);
      setStep(STEPS.DONE);
    } catch (err) {
      setError(err?.message || String(err));
      setStep(STEPS.ERROR);
    }
  }

  async function handleDelete() {
    const fe = freshEntryRef.current;
    const isCompose = !!(fe.source?.compose_url || fe.source?.compose_file || fe.source?.compose_repo ||
                         fe.compose_url || fe.compose_file || fe.compose_repo ||
                         (liveTool?.containerIds?.length > 1));
    setConfirmDelete(false);
    setStep(STEPS.DELETING);
    setError(null);
    addLog(`■ Stopping and removing ${fe.name}…`, "info");
    try {
      if (IS_TAURI) {
        const { invoke } = await import("@tauri-apps/api/core");
        const { listen }  = await import("@tauri-apps/api/event");

        // Stream undeploy progress into the output log
        const unlisten = await listen("deploy:progress", (event) => {
          if (!modalMountedRef.current) return;
          const raw = typeof event.payload === "string" ? event.payload : String(event.payload);
          if (raw.trim()) addLog(raw, "info");
        });

        try {
          if (isCompose) {
            const result = await invoke("undeploy_tool", {
              toolId:         fe.id,
              containerIds:   liveTool?.containerIds || [],
              composeFile:    fe.source?.compose_file     || fe.compose_file     || null,
              composeRepo:    fe.source?.compose_repo     || fe.compose_repo     || null,
              composeRepoTag: fe.source?.compose_repo_tag || fe.compose_repo_tag || null,
              composeSubdir:  fe.source?.compose_subdir   || fe.compose_subdir   || null,
            });
            if (result?.success === false) throw new Error(result.message || "Undeploy failed");
          } else {
            // Single-container tool — show each step explicitly
            const ids = liveTool?.containerIds || [];
            for (const id of ids) {
              const short = id.slice(0, 12);
              addLog(`▶ ${activeRuntime} stop ${short}`, "info");
              await invoke("stop_container", { containerId: id, timeout: 15 });
              addLog(`▶ ${activeRuntime} rm -f ${short}`, "info");
              await invoke("remove_container", { containerId: id, force: true });
              addLog(`✓ Container ${short} removed.`, "success");
            }
            const ref = fullImage(fe);
            if (ref) {
              addLog(`▶ ${activeRuntime} rmi ${ref}`, "info");
              const result = await invoke("remove_image", { reference: ref });
              if (result?.success === false) {
                addLog(`⚠ Image removal skipped (may still be in use): ${result.message || ""}`, "warn");
              } else {
                addLog(`✓ Image ${ref} removed.`, "success");
              }
            }
          }
        } finally {
          unlisten();
        }
      } else {
        await new Promise(r => setTimeout(r, 800));
      }
      addLog(`✓ ${fe.name} removed.`, "success");
      // Transition to DONE immediately — don't wait for manualRefresh which can be slow
      setStep(STEPS.DONE);
      // Refresh in background so the registry/dashboard update without blocking the UI
      manualRefresh().catch(() => {});
    } catch (err) {
      const msg = err?.message || String(err);
      addLog(`✗ Delete failed: ${msg}`, "error");
      setError(msg);
      setStep(STEPS.ERROR);
    }
  }

  function handleCancel() {
    const busy = step === STEPS.PULLING || step === STEPS.STARTING || step === STEPS.DELETING || step === STEPS.PREFLIGHT;
    if (busy) {
      setConfirmAbort(true); // show inline confirmation — don't close yet
      return;
    }
    onClose();
  }

  function handleAbortConfirmed() {
    // Actually kill the deploy
    cancelRef.current = true;
    if (IS_TAURI) {
      import("@tauri-apps/api/core").then(({ invoke }) => invoke("cancel_deploy").catch(() => {}));
    }
    // Reset UI back to idle — don't close the modal
    setConfirmAbort(false);
    setStep(STEPS.IDLE);
    setError(null);
    addLog("— Deploy aborted by user.", "warn");
    setShowEnvConfig(true); // re-expand config so user can adjust and retry
  }

  function handleDismiss() {
    // Dismiss to background (keep deploy running) — only callable from backdrop click while busy
    if (onDismiss) onDismiss();
    else onClose();
  }

  // Clicking the backdrop while busy dismisses to background; otherwise closes
  function handleBackdropClick(e) {
    if (e.target !== e.currentTarget) return;
    const busy = step === STEPS.PULLING || step === STEPS.STARTING || step === STEPS.DELETING || step === STEPS.PREFLIGHT;
    if (busy) handleDismiss();
    else onClose();
  }

  const allChecksPassed = checks.length > 0 && checks.every(c => c.status !== "fail");
  const requiredEnvFilled = (freshEntry.env_vars || [])
    .filter(d => d.required)
    .every(d => (envValues[d.key] ?? "").trim() || d.auto_uuid || d.key.toLowerCase().includes("encryption_key"));
  const busy = step === STEPS.PULLING || step === STEPS.STARTING || step === STEPS.DELETING || step === STEPS.PREFLIGHT;
  const readyToDeploy = allChecksPassed && requiredEnvFilled && step !== STEPS.ERROR && !busy;

  return (
    <div className="deploy-modal-backdrop" style={visible ? {} : { display: "none" }} onClick={handleBackdropClick}>
      <div className="deploy-modal">

        {/* Header */}
        <div className="deploy-modal__header">
          <div className="deploy-modal__title-block">
            <span className="deploy-modal__tag">// DEPLOY</span>
            <h2 className="deploy-modal__title">{freshEntry.name}</h2>
            {(freshEntry.source?.compose_url || freshEntry.source?.compose_file || freshEntry.source?.compose_repo || freshEntry.compose_url || freshEntry.compose_file) && (
              <span className="deploy-modal__compose-badge"><Layers size={10} /> COMPOSE STACK</span>
            )}
          </div>
          <button className="deploy-modal__close" onClick={() => {
            const busy = step === STEPS.PULLING || step === STEPS.STARTING || step === STEPS.DELETING || step === STEPS.PREFLIGHT;
            if (busy) handleDismiss(); else onClose();
          }}>
            <X size={16} />
          </button>
        </div>

        {/* Info strip */}
        <div className="deploy-modal__info-strip">
          {(freshEntry.source?.compose_url || freshEntry.source?.compose_file || freshEntry.compose_url || freshEntry.compose_file) ? (
            <span className="deploy-modal__image mono" title={freshEntry.source?.compose_url || freshEntry.source?.compose_file || freshEntry.compose_url || freshEntry.compose_file}>
              {(freshEntry.source?.compose_url || freshEntry.source?.compose_file || freshEntry.compose_url || freshEntry.compose_file || "").replace(/^https?:\/\//, "")}
            </span>
          ) : (
            <span className="deploy-modal__image mono">{displayImage(freshEntry)}</span>
          )}
          {(freshEntry.access?.ports || freshEntry.ports || []).length > 0 && (
            <span className="deploy-modal__ports">
              {(freshEntry.access?.ports || freshEntry.ports || []).map(p => <span key={p} className="port-tag mono">{p}</span>)}
            </span>
          )}
          {(freshEntry.access?.entrypoint || freshEntry.entrypoint) && (
            <a className="deploy-modal__entry mono" href={freshEntry.access?.entrypoint || freshEntry.entrypoint} target="_blank" rel="noopener noreferrer">
              {freshEntry.access?.entrypoint || freshEntry.entrypoint} <ExternalLink size={10} />
            </a>
          )}
        </div>

        {/* Pre-flight checks */}
        <div className="deploy-modal__checks">
          <div className="deploy-modal__section-title">
            Pre-flight Checks
            {step === STEPS.PREFLIGHT && <span className="spin-inline"><Loader size={12} /></span>}
          </div>
          {checks.length === 0 && step === STEPS.PREFLIGHT && (
            <div className="check-item check-item--loading">
              <Loader size={12} className="spin" /> Running checks…
            </div>
          )}
          {checks.map(check => (
            <div key={check.id} className={`check-item check-item--${check.status}`}>
              {check.status === "pass" && <CheckCircle2 size={13} />}
              {check.status === "fail" && <XCircle size={13} />}
              {check.status === "warn" && <AlertTriangle size={13} />}
              <span className="check-item__label">{check.label}</span>
              {check.detail && <span className="check-item__detail">{check.detail}</span>}
            </div>
          ))}
        </div>

        {/* ── Environment Variables Config ─────────────────────── */}
        {(step === STEPS.ENV_CONFIG || step === STEPS.IDLE || step === STEPS.PULLING || step === STEPS.STARTING || step === STEPS.DELETING || step === STEPS.DONE || step === STEPS.ERROR) &&
         (freshEntry.env_vars?.length > 0) && (
          <div className="deploy-modal__env-section">
            <button className="deploy-modal__section-title deploy-modal__log-toggle" onClick={() => setShowEnvConfig(v => !v)}>
              <Settings2 size={12} /> Configuration
              {step === STEPS.ENV_CONFIG && !showEnvConfig && !requiredEnvFilled && (
                <span className="deploy-modal__env-required-note deploy-modal__env-required-note--warn">⚠ required fields missing</span>
              )}
              {step === STEPS.ENV_CONFIG && !showEnvConfig && requiredEnvFilled && (
                <span className="deploy-modal__env-required-note">configured ✓</span>
              )}
              <span style={{marginLeft:"auto"}} />
              {showEnvConfig ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showEnvConfig && (
            <div className="deploy-modal__env-grid">
              {freshEntry.env_vars.map(def => {
                const isSecret = def.secret;
                const shown = showSecrets[def.key];
                const inputType = isSecret && !shown ? "password" : "text";
                const val = envValues[def.key] ?? "";
                const isEmpty = !val.trim();
                const isRequired = def.required;
                return (
                  <div key={def.key} className={`deploy-modal__env-row${isRequired && isEmpty ? " deploy-modal__env-row--missing" : ""}`}>
                    <div className="deploy-modal__env-label-wrap">
                      <span className="deploy-modal__env-label">
                        {def.label}
                        {isRequired && <span className="deploy-modal__env-required">*</span>}
                      </span>
                      {def.description && (
                        <span className="deploy-modal__env-desc">{def.description}</span>
                      )}
                    </div>
                    <div className="deploy-modal__env-input-wrap">
                      <input
                        className={`deploy-modal__env-input${isRequired && isEmpty ? " deploy-modal__env-input--missing" : ""}`}
                        type={inputType}
                        value={val}
                        placeholder={def.auto_uuid ? "auto-generate UUID" : def.key.toLowerCase().includes("encryption_key") ? "auto-generate 32-char key" : ""}
                        disabled={step === STEPS.PULLING || step === STEPS.STARTING || step === STEPS.DONE}
                        onChange={e => setEnvValues(prev => ({ ...prev, [def.key]: e.target.value }))}
                      />
                      {isSecret && (
                        <button
                          className="deploy-modal__env-eye"
                          onClick={() => setShowSecrets(prev => ({ ...prev, [def.key]: !prev[def.key] }))}
                          title={shown ? "Hide" : "Show"}
                          type="button"
                        >
                          {shown ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      )}
                      {(def.auto_uuid || def.key.toLowerCase().includes("encryption_key")) && (
                        <button
                          className="deploy-modal__env-gen"
                          title="Auto-generate"
                          type="button"
                          onClick={() => {
                            // Generate a single value using the same logic as buildEnvFromVars
                            const singleVal = buildEnvFromVars({ env_vars: [def] }, {})[def.key] || "";
                            setEnvValues(prev => ({ ...prev, [def.key]: singleVal }));
                            setShowSecrets(prev => ({ ...prev, [def.key]: true }));
                          }}
                        >
                          <Wand2 size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </div>
        )}

        {/* Log output */}
        <div className="deploy-modal__log-section">
          <button className="deploy-modal__section-title deploy-modal__log-toggle" onClick={() => setShowLog(v => !v)}>
            <Terminal size={12} /> Output
            <span style={{marginLeft:"auto"}} />
            {showLog ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showLog && (
            <pre className="deploy-modal__terminal" ref={logRef}>
              <span className="deploy-modal__terminal-placeholder">// waiting for output…</span>
            </pre>
          )}
          {error && (
            <div className="deploy-modal__error"><XCircle size={14} />{error}</div>
          )}
        </div>

        {/* Actions */}
        <div className="deploy-modal__actions">

          {/* Abort confirmation — shown inline when user clicks Abort */}
          {confirmAbort ? (
            <div className="deploy-modal__confirm deploy-modal__confirm--abort">
              <span className="deploy-modal__confirm-msg">Abort the running deploy?</span>
              <button className="deploy-modal__btn deploy-modal__btn--delete-confirm" onClick={handleAbortConfirmed}>
                <XCircle size={13} /> Yes, Abort
              </button>
              <button className="deploy-modal__btn deploy-modal__btn--cancel" onClick={() => setConfirmAbort(false)}>
                Keep going
              </button>
            </div>
          ) : (
            <>
              <button
                className={`deploy-modal__btn deploy-modal__btn--cancel${busy ? " abort-active" : ""}`}
                onClick={handleCancel}
              >
                {step === STEPS.DONE ? "Close" : busy ? "Abort" : "Cancel"}
              </button>

              {isDeployed && step !== STEPS.DONE && !confirmDelete && (
                <>
                  <button
                    className="deploy-modal__btn deploy-modal__btn--update"
                    onClick={handleUpdate}
                    disabled={busy || step === STEPS.ERROR}
                    title="Pull latest image and restart containers"
                  >
                    {step === STEPS.PULLING && isUpdatingRef.current
                      ? <><Loader size={13} className="spin" /> Updating…</>
                      : <><Upload size={13} /> Update</>}
                  </button>
                  <button
                    className={`deploy-modal__btn deploy-modal__btn--delete${step === STEPS.DELETING ? " deploy-modal__btn--deleting-active" : ""}`}
                    onClick={() => !busy && setConfirmDelete(true)}
                    disabled={busy && step !== STEPS.DELETING}
                  >
                    {step === STEPS.DELETING
                      ? <><Loader size={13} className="spin" /> Deleting…</>
                      : <><Trash2 size={13} /> Delete</>}
                  </button>
                </>
              )}

              {confirmDelete && (
                <div className="deploy-modal__confirm">
                  <span className="deploy-modal__confirm-msg">Stop all containers and remove image?</span>
                  <button className="deploy-modal__btn deploy-modal__btn--delete-confirm" onClick={handleDelete} disabled={busy}>
                    <Trash2 size={13} /> Yes, Delete
                  </button>
                  <button className="deploy-modal__btn deploy-modal__btn--cancel" onClick={() => setConfirmDelete(false)}>
                    No
                  </button>
                </div>
              )}

              {step === STEPS.DONE ? (
                (freshEntry.access?.entrypoint || freshEntry.entrypoint) && isRunning && (
                  <a className="deploy-modal__btn deploy-modal__btn--open" href={freshEntry.access?.entrypoint || freshEntry.entrypoint} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={13} /> Open {freshEntry.name}
                  </a>
                )
              ) : (
                // Hide the deploy button entirely while an Update is running —
                // the Update button already shows "Updating…" as feedback.
                !confirmDelete && !isUpdatingRef.current && step !== STEPS.DELETING && (
                  <button
                    className={`deploy-modal__btn deploy-modal__btn--deploy ${busy ? "deploy-modal__btn--busy" : ""}`}
                    onClick={handleDeploy}
                    disabled={!readyToDeploy}
                  >
                    {step === STEPS.PULLING  &&  isFirstDeployRef.current && <><Loader size={13} className="spin" /> Deploying…</>}
                    {step === STEPS.PULLING  && !isFirstDeployRef.current && <><Loader size={13} className="spin" /> Redeploying…</>}
                    {step === STEPS.STARTING && <><Loader size={13} className="spin" /> Starting…</>}
                    {step === STEPS.DELETING && <></>}  {/* hidden during delete — deploy btn is not shown */}
                    {(step === STEPS.IDLE || step === STEPS.PREFLIGHT || step === STEPS.ENV_CONFIG) && (
                      isDeployed ? <><RefreshCw size={13} /> Redeploy</> : <><Download size={13} /> Deploy</>
                    )}
                    {step === STEPS.ERROR && <><XCircle size={13} /> Failed</>}
                  </button>
                )
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
