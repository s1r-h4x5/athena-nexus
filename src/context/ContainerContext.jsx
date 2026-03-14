// ═══════════════════════════════════════════════════════════
// context/ContainerContext.jsx
//
// Central store for all live container runtime state (Docker/Podman).
// - Polls the socket every POLL_INTERVAL ms
// - Merges raw containers with the tool registry
// - Exposes actions: start, stop, restart, update, remove
// - Tracks per-container stats (CPU / RAM)
// ═══════════════════════════════════════════════════════════

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { runtime, config as containerConfig, IS_TAURI } from "../lib/container";
import { fullImage, displayImage } from "../lib/imageUtils";
import { MOCK_TOOLS } from "../lib/mockData";
import { diagnoseError } from "../lib/diagnoseError";

// ── Audit helper ──────────────────────────────────────────── //
async function auditLog(category, action, subjectId, subject, outcome, detail = "") {
  try {
    if (IS_TAURI) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("audit_append", {
        category, action, subject_id: subjectId, subject, outcome, detail,
      });
      // Notify AuditPage that new data is available so it can refresh
      window.dispatchEvent(new CustomEvent("athena:audit-written"));
    } else {
      // In browser/mock mode — dispatch to the AuditPage mock store via
      // a CustomEvent so the page's mock invoke handler picks it up.
      window.dispatchEvent(new CustomEvent("athena:mock-audit", {
        detail: { category, action, subject_id: subjectId, subject, outcome, detail },
      }));
    }
  } catch (e) {
    console.warn("audit_append failed:", e);
  }
}

const ContainerContext = createContext(null);

const POLL_INTERVAL       = 5000;   // ms between container list refreshes
const STATS_INTERVAL      = 4000;   // ms between stats polls
const RECONNECT_INTERVAL  = 3000;   // ms between reconnect probes when disconnected
const HEALTH_INTERVAL     = 15000;  // ms between health checks
const MAX_LOG_LINES = 500;

/**
 * Build an env map from a tool's env_vars array + optional user overrides.
 * Falls back to the legacy flat `env` dict if env_vars is absent (user-defined tools).
 * auto_uuid fields with no value get a generated UUID.
 */
export function buildEnvFromVars(tool, userOverrides = {}) {
  const defs = tool.env_vars || [];
  if (defs.length === 0) {
    // Legacy path: user-defined tools still use flat env dict
    return { ...(tool.env || {}), ...userOverrides };
  }
  const result = {};
  for (const def of defs) {
    const override = userOverrides[def.key];
    const val = (override ?? def.default ?? "").trim();
    if (val) {
      result[def.key] = val;
    } else if (def.auto_uuid) {
      result[def.key] = generateUUID();
    } else if (def.key.toLowerCase().includes("encryption_key")) {
      result[def.key] = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, "0")).join("");
    }
    // else: leave unset — compose will warn but continue
  }
  return { ...result, ...userOverrides };
}

function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Helpers ───────────────────────────────────────────────── //

/** Normalise the raw Podman container state string → our status tokens */
function normaliseStatus(podmanState) {
  switch ((podmanState || "").toLowerCase()) {
    case "running":  return "running";
    case "exited":
    case "stopped":  return "stopped";
    case "paused":   return "stopped";
    case "created":  return "stopped";
    case "dead":     return "error";
    case "removing": return "updating";
    default:         return "stopped";
  }
}

/** Convert bytes → MB */
function bytesToMB(b) {
  return Math.round(b / 1024 / 1024);
}

/**
 * Parse the human-readable Status string that both Docker and Podman always
 * include in /containers/json list responses, e.g.:
 *   "Up 3 days (healthy)"  →  "3d 0h 0m"
 *   "Up 2 hours"           →  "2h 0m"
 *   "Up 45 minutes"        →  "45m 0s"
 *   "Up 30 seconds"        →  "30s"
 * Returns null for stopped / never-started containers.
 */
function parseUptimeFromStatus(status) {
  if (!status) return null;
  const s = status.toLowerCase();
  if (!s.startsWith("up ")) return null;
  // Strip parenthetical health suffixes: "(healthy)", "(unhealthy)", etc.
  const clean = s.replace(/\s*\(.*\)/, "").trim(); // e.g. "up 3 days"
  const body  = clean.slice(3).trim();              // e.g. "3 days"

  // Match patterns like "3 days", "2 hours", "45 minutes", "30 seconds",
  // and compound forms like "2 hours 5 minutes", "1 day 3 hours" (rare but possible).
  let totalSecs = 0;
  const unitMap = {
    second: 1, seconds: 1,
    minute: 60, minutes: 60,
    hour: 3600, hours: 3600,
    day: 86400, days: 86400,
    week: 604800, weeks: 604800,
    month: 2592000, months: 2592000,
  };
  const re = /(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months)/g;
  let match;
  let found = false;
  while ((match = re.exec(body)) !== null) {
    totalSecs += parseInt(match[1], 10) * (unitMap[match[2]] || 0);
    found = true;
  }
  if (!found) return null;

  if (totalSecs < 60)   return `< 1m`;
  if (totalSecs < 3600) return `${Math.floor(totalSecs / 60)}m`;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m}m`;
}

/**
 * Compute uptime for a container entry from the list API.
 *
 * Strategy (preferred → fallback):
 *  1. Podman libpod: c.StartedAt is a unix timestamp (number) or ISO string — exact.
 *  2. Docker / Podman compat: parse the always-present human Status string.
 */
function getUptime(c) {
  // 1. Podman libpod top-level StartedAt (numeric unix seconds or ISO string)
  const raw = c.StartedAt;
  if (raw !== undefined && raw !== null && raw !== 0 && raw !== "0001-01-01T00:00:00Z") {
    let epoch;
    if (typeof raw === "string") {
      epoch = Math.floor(new Date(raw).getTime() / 1000);
    } else {
      epoch = raw;
    }
    if (epoch > 0) {
      const secs = Math.floor(Date.now() / 1000) - epoch;
      if (secs >= 0) {
        if (secs < 60)   return `< 1m`;
        if (secs < 3600) return `${Math.floor(secs / 60)}m`;
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        if (h < 24) return `${h}h ${m}m`;
        const d = Math.floor(h / 24);
        return `${d}d ${h % 24}h ${m}m`;
      }
    }
  }
  // 2. Parse Status string — works for both Docker and Podman compat API
  return parseUptimeFromStatus(c.Status);
}

/**
 * Get the best epoch-seconds value for a container's start time.
 * Used for log-since and compose multi-container max comparison.
 */
function getStartedAtEpoch(c) {
  const raw = c.StartedAt;
  if (raw !== undefined && raw !== null && raw !== 0 && raw !== "0001-01-01T00:00:00Z") {
    if (typeof raw === "string") return Math.floor(new Date(raw).getTime() / 1000);
    if (typeof raw === "number" && raw > 0) return raw;
  }
  // Approximate from Status string
  const s = (c.Status || "").toLowerCase();
  if (!s.startsWith("up ")) return 0;
  const clean = s.replace(/\s*\(.*\)/, "").slice(3).trim();
  let totalSecs = 0;
  const unitMap = { second:1,seconds:1,minute:60,minutes:60,hour:3600,hours:3600,day:86400,days:86400,week:604800,weeks:604800,month:2592000,months:2592000 };
  const re = /(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months)/g;
  let match;
  while ((match = re.exec(clean)) !== null) totalSecs += parseInt(match[1], 10) * (unitMap[match[2]] || 0);
  return totalSecs > 0 ? Math.floor(Date.now() / 1000) - totalSecs : 0;
}

/** @deprecated kept for call-sites that still use it directly */
function formatUptime(startedAt) {
  if (!startedAt) return null;
  let epoch;
  if (typeof startedAt === "string") {
    epoch = Math.floor(new Date(startedAt).getTime() / 1000);
  } else {
    epoch = startedAt;
  }
  if (!epoch || epoch <= 0) return null;
  const secs = Math.floor(Date.now() / 1000) - epoch;
  if (secs < 0)    return null;
  if (secs < 60)   return `< 1m`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m}m`;
}

function toEpochSeconds(startedAt) {
  if (!startedAt) return 0;
  if (typeof startedAt === "string") return Math.floor(new Date(startedAt).getTime() / 1000);
  return startedAt;
}


/** Extract a friendly name from Podman container Names array
 *  e.g. ["/wazuh-manager-1"] → "wazuh-manager-1" */
function containerName(names) {
  if (!names?.length) return "unknown";
  return names[0].replace(/^\//, "");
}

// ═══════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════

export function ContainerProvider({ children, registry = [] }) {
  // ── Connection state ──────────────────────────────────── //
  const [connected, setConnected] = useState(false);
  const [socketPath, setSocketPath] = useState("");
  const [runtimeVersion, setRuntimeVersion] = useState(null);
  const [apiVersion,     setApiVersion]     = useState(null);
  const [connectionError, setConnectionError] = useState(null);
  // "podman" | "docker" — read from persisted config on mount, kept in sync
  const [activeRuntime, setActiveRuntime] = useState("podman");

  // ── Container/tool state ──────────────────────────────── //
  // rawContainers: straight from Podman API
  const [rawContainers, setRawContainers] = useState([]);
  const rawContainersRef = useRef([]);  // mirror — avoids stale closure in pollStats
  // tools: merged view (registry definition + live container data)
  const [tools, setTools] = useState([]);
  // stats: { [containerId]: { cpu, mem, memLimit } }
  const [stats, setStats] = useState({});
  // pendingActions: { [toolId]: "starting"|"stopping"|"restarting"|"updating" }
  const [pendingActions, setPendingActions] = useState({});

  // Count of active long-running operations (deploy/update/delete).
  // While > 0, background container polls are skipped to avoid log overwrites.
  const activeOpsRef = useRef(0);

  // ── Log buffers ───────────────────────────────────────── //
  const [logs, setLogs] = useState({}); // { [toolId]: string[] }

  // ── Health map ────────────────────────────────────────── //
  // { [toolId]: { status: "healthy"|"unhealthy"|"ready"|"unresponsive", detail: string|null } }
  const [healthMap, setHealthMap] = useState({});
  const healthMapRef = useRef({});  // mirror for stale-closure-safe access in setTools

  // Keep ref in sync
  useEffect(() => { healthMapRef.current = healthMap; }, [healthMap]);

  // Whenever healthMap changes, push updated health into the tools array
  useEffect(() => {
    if (Object.keys(healthMap).length === 0) return;
    setTools(prev => prev.map(t => ({
      ...t,
      health:       healthMap[t.id]?.status  ?? t.health,
      healthDetail: healthMap[t.id]?.detail  ?? t.healthDetail ?? null,
    })));
  }, [healthMap]);

  // ── Refs for intervals ────────────────────────────────── //
  const pollRef    = useRef(null);
  const statsRef   = useRef({});
  const healthRef  = useRef(null);
  const registryRef = useRef(registry);
  const isMounted  = useRef(true);

  useEffect(() => {
    registryRef.current = registry;
    // Re-merge tools immediately so card details update without waiting for next poll
    if (registry.length > 0) {
      setTools(mergeWithRegistry(rawContainersRef.current, statsRef.current).map(t => ({
        ...t,
        status: pendingActionsRef.current?.[t.id] || t.status,
        health: healthMapRef.current?.[t.id]?.status ?? t.health,
        healthDetail: healthMapRef.current?.[t.id]?.detail ?? null,
      })));
    }
  }, [registry]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // ── Merge raw containers with registry ───────────────── //
  const mergeWithRegistry = useCallback((containers, statsMap) => {
    const reg = registryRef.current;

    // Build a lookup: bare image name (no registry, no tag) → registry entry
    const byImage = {};
    for (const entry of reg) {
      const entryImage = entry.source?.image || entry.image;
      if (entryImage) byImage[entryImage.toLowerCase()] = entry;
      if (entry.id)    byImage[entry.id] = entry;
    }

    // Build a lookup: compose project name → registry entry.
    // podman-compose sets com.docker.compose.project = directory name of the compose file.
    // We store compose files at /tmp/athena-nexus/{tool_id}/, so the project name = tool_id.
    // Also index by tool name lowercased as a fallback.
    const byProject = {};
    for (const entry of reg) {
      if (entry.source?.compose_url || entry.source?.compose_file || entry.source?.compose_repo ||
          entry.compose_url || entry.compose_file || entry.compose_repo) {
        byProject[entry.id.toLowerCase()] = entry;
        byProject[entry.name.toLowerCase()] = entry;
      }
    }

    const toolMap = {};

    for (const c of containers) {
      // 1. Try to match by compose project label first.
      //    podman-compose sets com.docker.compose.project on every container it manages.
      const projectLabel = (c.Labels?.["com.docker.compose.project"] || "").toLowerCase();
      const composeEntry = projectLabel ? byProject[projectLabel] : null;

      // 2. Fall back to image-name matching for single-container tools.
      const rawImg   = c.Image || "";
      const imgNoTag = rawImg.split(":")[0];
      const imgBase  = imgNoTag.includes("/")
        ? imgNoTag.split("/").slice(-2).join("/").toLowerCase()
        : imgNoTag.toLowerCase();

      const name     = containerName(c.Names);
      const regEntry = composeEntry || byImage[imgBase] || byImage[name] || null;

      const toolId = regEntry?.id || name;
      const cStats = statsMap[c.Id] || {};
      const status = normaliseStatus(c.State);

      if (!toolMap[toolId]) {
        toolMap[toolId] = {
          id:          toolId,
          name:        regEntry?.name     || name,
          category:    regEntry?.category || "utilities",
          categories:  regEntry?.categories || (regEntry?.category ? [regEntry.category] : ["utilities"]),
          description: regEntry?.description || rawImg,
          // Structured image fields — prefer registry entry, fall back to parsing running image
          registry:    regEntry?.source?.registry || regEntry?.registry || "docker.io",
          image:       regEntry?.source?.image    || regEntry?.image    || imgBase,
          version:     regEntry?.source?.version  || regEntry?.version  || rawImg.split(":")[1] || "latest",
          compose:     !!(regEntry?.source?.compose_url || regEntry?.source?.compose_file || regEntry?.source?.compose_repo),
          compose_url:           regEntry?.source?.compose_url           || null,
          compose_file:          regEntry?.source?.compose_file          || null,
          compose_repo:          regEntry?.source?.compose_repo          || null,
          compose_repo_tag:      regEntry?.source?.compose_repo_tag      || null,
          compose_subdir:        regEntry?.source?.compose_subdir        || null,
          compose_port_overrides: regEntry?.source?.port_overrides       || {},
          status,
          health: c.Status?.includes("(healthy)")   ? "healthy"
                : c.Status?.includes("(unhealthy)") ? "unhealthy"
                : null,
          health_check: regEntry?.access?.health_check || regEntry?.health_check || null,
          entrypoint:   regEntry?.access?.entrypoint   || regEntry?.entrypoint   || null,
          cli_tool:     regEntry?.cli_tool   || false,
          cpu:          cStats.cpu      ?? 0,
          mem:          cStats.mem      ?? 0,
          memLimit:     cStats.memLimit ?? 0,
          uptime:       getUptime(c),
          startedAt:    getStartedAtEpoch(c),
          ports:        (c.Ports || []).map(p => p.PublicPort || p.PrivatePort).filter(Boolean),
          containerIds: [c.Id],
          rawNames:     [name],
          containers:   [{ id: c.Id, name, status, ports: (c.Ports || []).map(p => p.PublicPort || p.PrivatePort).filter(Boolean), ip: (() => { const nets = c.NetworkSettings?.Networks || {}; const first = Object.values(nets)[0]; return first?.IPAddress || c.NetworkSettings?.IPAddress || ""; })() }],
          networkMode:  c.HostConfig?.NetworkMode || (c.NetworkSettings?.Networks
                          ? Object.keys(c.NetworkSettings.Networks)[0]
                          : "bridge") || "bridge",
          containerIp:  (() => {
            const nets = c.NetworkSettings?.Networks || {};
            const first = Object.values(nets)[0];
            return first?.IPAddress || c.NetworkSettings?.IPAddress || "";
          })(),
        };
      } else {
        toolMap[toolId].compose = true;
        toolMap[toolId].containerIds.push(c.Id);
        toolMap[toolId].rawNames.push(name);
        toolMap[toolId].containers = toolMap[toolId].containers || [];
        toolMap[toolId].containers.push({ id: c.Id, name, status, ports: (c.Ports || []).map(p => p.PublicPort || p.PrivatePort).filter(Boolean), ip: (() => { const nets = c.NetworkSettings?.Networks || {}; const first = Object.values(nets)[0]; return first?.IPAddress || c.NetworkSettings?.IPAddress || ""; })() });
        // Use the most recent startedAt for uptime display
        const ctEpoch = getStartedAtEpoch(c);
        if (ctEpoch > (toolMap[toolId]._maxStartedAt || 0)) {
          toolMap[toolId]._maxStartedAt = ctEpoch;
          toolMap[toolId].uptime    = getUptime(c);
          toolMap[toolId].startedAt = ctEpoch;
        }
        toolMap[toolId].cpu += cStats.cpu ?? 0;
        toolMap[toolId].mem += cStats.mem ?? 0;
        if (status === "running") toolMap[toolId].status = "running";
        if (status === "error")   toolMap[toolId].status = "error";
        // Merge ports from all compose containers — deduplicated
        const newPorts = (c.Ports || []).map(p => p.PublicPort || p.PrivatePort).filter(Boolean);
        toolMap[toolId].ports = [...new Set([...toolMap[toolId].ports, ...newPorts])];
      }
    }

    // Add registry entries that have no container yet
    for (const entry of reg) {
      if (!toolMap[entry.id]) {
        toolMap[entry.id] = {
          id:          entry.id,
          name:        entry.name,
          category:    entry.category,
          categories:  entry.categories || (entry.category ? [entry.category] : ["utilities"]),
          description: entry.description,
          registry:    entry.source?.registry || entry.registry || "docker.io",
          image:       entry.source?.image    || entry.image    || "",
          version:     entry.source?.version  || entry.version  || "latest",
          compose:     !!(entry.source?.compose_url || entry.source?.compose_file || entry.source?.compose_repo),
          compose_url:           entry.source?.compose_url           || null,
          compose_file:          entry.source?.compose_file          || null,
          compose_repo:          entry.source?.compose_repo          || null,
          compose_repo_tag:      entry.source?.compose_repo_tag      || null,
          compose_subdir:        entry.source?.compose_subdir        || null,
          compose_port_overrides: entry.source?.port_overrides       || {},
          status:      "stopped",
          health:      null,
          health_check: entry.access?.health_check || entry.health_check || null,
          entrypoint:  entry.access?.entrypoint   || entry.entrypoint   || null,
          cli_tool:    entry.cli_tool   || false,
          user_defined:entry.user_defined || false,
          cpu: 0, mem: 0, memLimit: 0, uptime: null,
          ports:        entry.access?.ports || entry.ports || [],
          containerIds: [],
          rawNames:     [],
          containers:   [],
        };
      }
    }

    return Object.values(toolMap);
  }, []);

  // ── pendingActions ref — kept in sync so polling closures are never stale ── //
  const pendingActionsRef = useRef({});
  useEffect(() => { pendingActionsRef.current = pendingActions; }, [pendingActions]);

  // ── Poll container list ───────────────────────────────── //
  // Owns ONLY data — does NOT touch connected state.
  // Disconnect detection is handled exclusively by the connection loop below.
  const pollContainers = useCallback(async () => {
    // Don't overwrite tools/logs state while a deploy or update is streaming
    if (activeOpsRef.current > 0) return;
    try {
      const containers = await runtime.listContainers(true);
      if (!isMounted.current) return;
      rawContainersRef.current = containers;
      setRawContainers(containers);
      // Pass current stats so we don't wipe them on every container poll
      setTools(mergeWithRegistry(containers, statsRef.current).map(t => ({
        ...t,
        status: pendingActionsRef.current[t.id] || t.status,
        // Overlay health from our active polling (overrides Podman's own health annotation)
        health: healthMapRef.current[t.id]?.status ?? t.health,
        healthDetail: healthMapRef.current[t.id]?.detail ?? null,
      })));
    } catch (err) {
      if (!isMounted.current) return;
      setConnectionError(err?.message || String(err));
      setTools(prev => prev.map(t => ({ ...t, status: "stopped", cpu: 0, mem: 0, uptime: null })));
    }
  }, [mergeWithRegistry]);

  // ── Poll stats for running containers ────────────────── //
  const pollStats = useCallback(async () => {
    if (!connectedRef.current) return;
    if (activeOpsRef.current > 0) return;
    const running = rawContainersRef.current.filter(c =>
      normaliseStatus(c.State) === "running"
    );

    // Use refs to avoid stale closures — refs always have latest values
    const newStats = { ...statsRef.current };
    await Promise.allSettled(
      running.map(async c => {
        try {
          const s = await runtime.getStats(c.Id);
          if (!s || !isMounted.current) return;

          // Podman stats shape varies by version — handle both
          const cpuDelta = s.cpu_stats?.cpu_usage?.total_usage
            - (s.precpu_stats?.cpu_usage?.total_usage || 0);
          const sysDelta = s.cpu_stats?.system_cpu_usage
            - (s.precpu_stats?.system_cpu_usage || 0);
          const numCPU = s.cpu_stats?.online_cpus || 1;
          const cpuPct = sysDelta > 0
            ? (cpuDelta / sysDelta) * numCPU * 100
            : (statsRef.current[c.Id]?.cpu ?? 0); // keep last value if no delta yet

          const memUsage = s.memory_stats?.usage || 0;
          const memLimit = s.memory_stats?.limit || 1;

          newStats[c.Id] = {
            cpu: Math.round(cpuPct * 10) / 10,
            mem: bytesToMB(memUsage),
            memLimit: bytesToMB(memLimit),
          };
        } catch (_) {
          // Individual stat failure is non-fatal
        }
      })
    );

    if (isMounted.current) {
      statsRef.current = newStats;
      setStats(newStats);
      setTools(mergeWithRegistry(rawContainersRef.current, newStats).map(t => ({
        ...t,
        status: pendingActionsRef.current[t.id] || t.status,
        health: healthMapRef.current[t.id]?.status ?? t.health,
        healthDetail: healthMapRef.current[t.id]?.detail ?? null,
      })));
    }
  }, [mergeWithRegistry]);
  // All mutable values read via refs — no stale closure risk

  // ── Health polling ────────────────────────────────────── //
  // Runs every 15s. For each running tool that has a health_check URL
  // (web tools) or is a CLI tool, fire check_health and update healthMap.
  const pollHealth = useCallback(async () => {
    if (!isMounted.current) return;

    // Get the current tools snapshot via ref-safe approach
    const currentTools = mergeWithRegistry(rawContainersRef.current, statsRef.current);
    const runningTools = currentTools.filter(t => t.status === "running");
    if (!runningTools.length) return;

    const updates = {};

    await Promise.allSettled(runningTools.map(async tool => {
      // Only check tools that have something to check
      const hasUrl = !!tool.health_check;
      const isCli  = !!tool.cli_tool;
      if (!hasUrl && !isCli) return;

      try {
        let result;
        if (IS_TAURI) {
          const { invoke } = await import("@tauri-apps/api/core");
          result = await invoke("check_health", {
            containerId:    tool.containerIds?.[0] || null,
            healthCheckUrl: tool.health_check || null,
            cliTool:        isCli,
          });
        } else {
          // Mock: randomly healthy/ready for dev
          result = isCli
            ? { status: "ready",   detail: null }
            : { status: "healthy", detail: "HTTP 200" };
        }
        if (result) updates[tool.id] = result;
      } catch (_) {
        updates[tool.id] = {
          status: isCli ? "unresponsive" : "unhealthy",
          detail: "check failed",
        };
      }
    }));

    if (isMounted.current && Object.keys(updates).length > 0) {
      setHealthMap(prev => ({ ...prev, ...updates }));
    }
  }, [mergeWithRegistry]);
  //
  //  Two separate intervals:
  //    PROBE  — always running, every RECONNECT_INTERVAL ms
  //             calls checkConnection; owns all connected ↔ disconnected transitions
  //    POLL   — runs only while connected, every POLL_INTERVAL ms
  //             calls listContainers + pollStats
  //
  //  Keeping them separate means:
  //    - disconnect is detected within 3s (probe interval), not 5s (poll interval)
  //    - pollContainers errors never interfere with connection state

  const connectedRef = useRef(false);

  function setConnectedSync(val) {
    connectedRef.current = val;
    setConnected(val);
  }

  useEffect(() => {
    const probeTimerRef = { current: null };
    const pollTimerRef  = { current: null };
    const statsTimerRef = { current: null };
    let probeRunning    = false; // prevent overlapping async probe calls

    // Load the persisted runtime choice BEFORE the first probe fires so
    // ConnectionBanner shows the correct title immediately on first render.
    containerConfig.load().then(cfg => {
      if (cfg?.container_runtime) setActiveRuntime(cfg.container_runtime);
    }).catch(() => {});

    async function probe() {
      if (!isMounted.current || probeRunning) return;
      probeRunning = true;
      try {
        const result = await runtime.checkConnection();
        if (!isMounted.current) return;

        if (result?.success) {
          const info = result.data;
          // Both runtimes return the same normalised shape from check_podman_connection:
          //   { version: { Version }, host: { remoteSocket: { path } } }
          if (info?.version?.Version)    setRuntimeVersion(info.version.Version);
          if (info?.version?.ApiVersion) setApiVersion(info.version.ApiVersion);
          if (info?.host?.remoteSocket?.path) setSocketPath(info.host.remoteSocket.path);
          // Keep activeRuntime in sync (user may have changed it in Settings)
          containerConfig.load().then(cfg => {
            if (cfg?.container_runtime) setActiveRuntime(cfg.container_runtime);
          }).catch(() => {});

          if (!connectedRef.current) {
            // Transition: disconnected → connected
            setConnectedSync(true);
            setConnectionError(null);
            startPolling();
          }
          // Already connected: probe just confirms we're still up — no action needed
        } else {
          handleProbeFailure(result?.message || "Cannot reach Podman socket");
        }
      } catch (err) {
        handleProbeFailure(err?.message || String(err));
      } finally {
        probeRunning = false;
      }
    }

    function handleProbeFailure(msg) {
      if (!isMounted.current) return;
      setConnectionError(msg);
      const wasConnected = connectedRef.current; // read BEFORE mutating
      setConnectedSync(false);
      if (wasConnected) {
        // Transition: connected → disconnected
        stopPolling();
        setTools(prev => prev.map(t => ({
          ...t, status: "stopped", cpu: 0, mem: 0, uptime: null,
        })));
      }
    }

    function startPolling() {
      stopPolling(); // clear any stale timers before creating new ones
      pollContainers();
      pollStats();
      pollHealth();  // initial health check immediately on connect
      pollTimerRef.current  = setInterval(pollContainers, POLL_INTERVAL);
      statsTimerRef.current = setInterval(pollStats,      STATS_INTERVAL);
      healthRef.current     = setInterval(pollHealth,     HEALTH_INTERVAL);
    }

    function stopPolling() {
      clearInterval(pollTimerRef.current);
      clearInterval(statsTimerRef.current);
      clearInterval(healthRef.current);
      pollTimerRef.current  = null;
      statsTimerRef.current = null;
      healthRef.current     = null;
    }

    // Probe runs immediately and on every interval — both connected and disconnected.
    probe();
    probeTimerRef.current = setInterval(probe, RECONNECT_INTERVAL);

    return () => {
      clearInterval(probeTimerRef.current);
      stopPolling();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ───────────────────────────────────────────── //

  function setPending(toolId, action) {
    setPendingActions(p => ({ ...p, [toolId]: action }));
    // Immediately reflect in tools list
    setTools(prev => prev.map(t =>
      t.id === toolId ? { ...t, status: action } : t
    ));
  }

  function clearPending(toolId) {
    setPendingActions(p => {
      const next = { ...p };
      delete next[toolId];
      return next;
    });
  }

  // ── Logs ──────────────────────────────────────────────── //
  const fetchLogs = useCallback(async (tool) => {
    const ids = tool.containerIds || [];
    if (!ids.length) return;
    try {
      // Pass startedAt so we only fetch logs since the current run started —
      // avoids showing output from previous restart-loop iterations.
      const since = tool.startedAt || 0;
      const allLogs = await Promise.all(ids.map(id => runtime.getLogs(id, 200, since)));
      const containerLines = allLogs.join("\n").split("\n").filter(Boolean);
      setLogs(prev => {
        const existing = prev[tool.id] || [];
        // Keep any action log lines (prefixed with [timestamp]) already in the buffer,
        // then append the fresh container log lines — never wipe what deployTool wrote.
        const actionLines = existing.filter(l => l.startsWith("["));
        const combined = [...actionLines, ...containerLines].slice(-MAX_LOG_LINES);
        return { ...prev, [tool.id]: combined };
      });
    } catch (err) {
      console.error("Log fetch failed:", err);
    }
  }, []);

  // ── Action log helper ─────────────────────────────────── //
  // Writes synthetic timestamped lines into the Log Drawer buffer AND
  // into the Audit Log so every step of start/restart/update is traceable.
  const appendActionLog = useCallback((toolId, toolName, action, lines) => {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const stamped = lines.map(l => `[${ts}] ${l}`);

    // Log Drawer buffer
    setLogs(prev => ({
      ...prev,
      [toolId]: [...(prev[toolId] || []), ...stamped].slice(-MAX_LOG_LINES),
    }));

    // Audit Log — one entry per line, outcome inferred from prefix symbol
    lines.forEach(line => {
      const outcome =
        line.startsWith("✓") ? "success" :
        line.startsWith("✗") ? "failure" :
        line.startsWith("⚠") ? "warning" : "info";
      auditLog("container", action, toolId, toolName, outcome, line);
    });
  }, []);

  const startTool = useCallback(async (tool) => {
    activeOpsRef.current += 1;  // Pause background polls during start
    setPending(tool.id, "starting");
    appendActionLog(tool.id, tool.name, "start", [`▶ Starting ${tool.name}…`]);
    try {
      if (tool.containerIds?.length > 0) {
        for (const id of tool.containerIds) {
          const short = id.slice(0, 12);
          appendActionLog(tool.id, tool.name, "start", [`▶ ${activeRuntime} start ${short}`]);
          await runtime.start(id);
        }
      } else {
        appendActionLog(tool.id, tool.name, "start", ["⚠ No container ID — deploy not yet implemented"]);
      }
      appendActionLog(tool.id, tool.name, "start", [`✓ Start command sent — fetching logs…`]);
    } catch (err) {
      appendActionLog(tool.id, tool.name, "start", [`✗ Start failed: ${err?.message || String(err)}`]);
    }
    activeOpsRef.current = Math.max(0, activeOpsRef.current - 1);
    await pollContainers();
    clearPending(tool.id);
    await fetchLogs(tool);
  }, [pollContainers, appendActionLog, fetchLogs, activeRuntime]);

  const stopTool = useCallback(async (tool) => {
    activeOpsRef.current += 1;  // Pause background polls so they don't overwrite action logs
    setPending(tool.id, "stopping");
    appendActionLog(tool.id, tool.name, "stop", [`■ Stopping ${tool.name}…`]);
    const isCompose = !!(tool.source?.compose_url || tool.source?.compose_file || tool.source?.compose_repo || tool.compose_url || tool.compose_file || tool.compose || tool.compose_repo);

    try {
      if (IS_TAURI) {
        const { invoke } = await import("@tauri-apps/api/core");
        const { listen }  = await import("@tauri-apps/api/event");

        // If a deploy/redeploy is actively running, kill it first so compose stop
        // doesn't race with compose up over the same stack.
        const deployWasActive = activeOpsRef.current > 1; // >1 because we just incremented
        if (deployWasActive) {
          appendActionLog(tool.id, tool.name, "stop", ["⚠ Deploy in progress — aborting it first…"]);
          try { await invoke("cancel_deploy"); } catch (_) {}
          await new Promise(r => setTimeout(r, 800));
        }

        if (isCompose) {
          // Stream backend progress events into the log drawer in real time
          const unlisten = await listen("deploy:progress", (event) => {
            const raw = typeof event.payload === "string" ? event.payload : String(event.payload);
            if (raw.trim()) appendActionLog(tool.id, tool.name, "stop", [raw]);
          });

          try {
            // Log the exact parameters being sent to the backend
            const stopParams = {
              toolId:         tool.id,
              composeFile:    tool.compose_file    || null,
              composeRepo:    tool.compose_repo    || null,
              composeRepoTag: tool.compose_repo_tag || null,
              composeSubdir:  tool.compose_subdir  || null,
              containerIds:   tool.containerIds    || [],
            };
            appendActionLog(tool.id, tool.name, "stop", [
              `▶ ${activeRuntime} compose -p ${tool.id} stop`,
            ]);

            const result = await invoke("stop_compose_tool", stopParams);

            appendActionLog(tool.id, tool.name, "stop", [
              `Backend returned: success=${result?.success}, message=${result?.message || "none"}`,
            ]);

            if (result?.success === false) {
              appendActionLog(tool.id, tool.name, "stop",
                [`✗ ${result.message || "compose stop failed"}`]);
            }
          } catch (invokeErr) {
            appendActionLog(tool.id, tool.name, "stop",
              [`✗ invoke stop_compose_tool threw: ${invokeErr?.message || String(invokeErr)}`]);
          } finally {
            unlisten();
          }
        } else {
          // Single-container tool — stop via API.
          for (const id of (tool.containerIds || [])) {
            const short = id.slice(0, 12);
            appendActionLog(tool.id, tool.name, "stop", [`▶ ${activeRuntime} stop -t 10 ${short}`]);
            try {
              await invoke("stop_container", { containerId: id, timeout: 10 });
            } catch (e) {
              appendActionLog(tool.id, tool.name, "stop",
                [`✗ stop ${short}: ${e?.message || e}`]);
            }
          }
        }
      }
      appendActionLog(tool.id, tool.name, "stop", [`✓ ${tool.name} stopped.`]);
    } catch (err) {
      appendActionLog(tool.id, tool.name, "stop", [`✗ Stop failed: ${err?.message || String(err)}`]);
    }

    activeOpsRef.current = Math.max(0, activeOpsRef.current - 1);

    // Now poll once to refresh container state
    try {
      const containers = await runtime.listContainers(true);
      if (isMounted.current) {
        rawContainersRef.current = containers;
        setRawContainers(containers);
        setTools(mergeWithRegistry(containers, statsRef.current).map(t => ({
          ...t,
          status: pendingActionsRef.current[t.id] || t.status,
          health: healthMapRef.current[t.id]?.status ?? t.health,
          healthDetail: healthMapRef.current[t.id]?.detail ?? null,
        })));
      }
    } catch (_) {}

    clearPending(tool.id);
    // Don't call fetchLogs here — stopped containers dump their entire historical
    // output which overwrites the stop action log the user actually wants to see.
  }, [pollContainers, appendActionLog, fetchLogs, mergeWithRegistry, activeRuntime]);

  const restartTool = useCallback(async (tool) => {
    activeOpsRef.current += 1;  // Pause background polls during restart
    setPending(tool.id, "restarting");
    appendActionLog(tool.id, tool.name, "restart", [`↺ Restarting ${tool.name}…`]);
    try {
      for (const id of tool.containerIds) {
        const short = id.slice(0, 12);
        appendActionLog(tool.id, tool.name, "restart", [`▶ ${activeRuntime} restart ${short}`]);
        await runtime.restart(id);
      }
      appendActionLog(tool.id, tool.name, "restart", [`✓ Restart command sent — waiting for container…`]);
    } catch (err) {
      appendActionLog(tool.id, tool.name, "restart", [`✗ Restart failed: ${err?.message || String(err)}`]);
      await pollContainers();
      clearPending(tool.id);
      return;
    }
    // Poll until the container reports "running" (up to ~30s)
    let attempts = 0;
    const maxAttempts = 30;
    while (attempts < maxAttempts) {
      await pollContainers();
      const current = rawContainersRef.current || [];
      const isRunning = tool.containerIds.every(id =>
        current.some(c => c.Id === id && (c.State || "").toLowerCase() === "running")
      );
      if (isRunning) break;
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
    if (attempts >= maxAttempts) {
      appendActionLog(tool.id, tool.name, "restart", [`⚠ Container did not come back up within 30s`]);
    } else {
      appendActionLog(tool.id, tool.name, "restart", [`✓ Container is running — fetching logs…`]);
    }
    activeOpsRef.current = Math.max(0, activeOpsRef.current - 1);
    clearPending(tool.id);
    await fetchLogs(tool);
  }, [pollContainers, appendActionLog, fetchLogs, activeRuntime]);

  const updateTool = useCallback(async (tool) => {
    activeOpsRef.current += 1;
    setPending(tool.id, "updating");
    const ref = fullImage(tool);
    appendActionLog(tool.id, tool.name, "update", [`⬇ Pulling latest image: ${ref}…`]);
    try {
      if (IS_TAURI) {
        const { invoke } = await import("@tauri-apps/api/core");
        const { listen } = await import("@tauri-apps/api/event");

        const unlisten = await listen("deploy:progress", (event) => {
          const raw = typeof event.payload === "string" ? event.payload : String(event.payload);
          if (raw.trim()) appendActionLog(tool.id, tool.name, "update", [raw]);
        });

        try {
          const pullResult = await invoke("pull_image_streaming", { image: ref });
          if (pullResult?.success === false) throw new Error(pullResult.message || "Pull failed");
        } finally {
          unlisten();
        }

        appendActionLog(tool.id, tool.name, "update", [`✓ Pull complete — restarting container…`]);
        if (tool.containerIds?.length > 0) {
          for (const id of tool.containerIds) {
            appendActionLog(tool.id, tool.name, "update", [`▶ ${activeRuntime} restart ${id.slice(0, 12)}`]);
            await runtime.restart(id);
          }
          appendActionLog(tool.id, tool.name, "update", [`✓ Container restarted.`]);
        }
      } else {
        // Browser dev mock
        appendActionLog(tool.id, tool.name, "update", [`✓ Pull complete — restarting container…`]);
        if (tool.containerIds?.length > 0) {
          for (const id of tool.containerIds) {
            appendActionLog(tool.id, tool.name, "update", [`▶ ${activeRuntime} restart ${id.slice(0, 12)}`]);
            await runtime.restart(id);
          }
          appendActionLog(tool.id, tool.name, "update", [`✓ Container restarted.`]);
        }
      }
    } catch (err) {
      appendActionLog(tool.id, tool.name, "update", [`✗ Update failed: ${err?.message || String(err)}`]);
    }
    activeOpsRef.current = Math.max(0, activeOpsRef.current - 1);
    await pollContainers();
    clearPending(tool.id);
    await fetchLogs(tool);
  }, [pollContainers, appendActionLog, fetchLogs, activeRuntime]);

  const openTool = useCallback((tool) => {
    if (!tool.entrypoint) return;
    if (window.__TAURI_INTERNALS__) {
      import("@tauri-apps/plugin-shell").then(({ open }) => open(tool.entrypoint));
    } else {
      window.open(tool.entrypoint, "_blank", "noopener");
    }
  }, []);

  // Deploy a tool for the first time (pull + run).
  // Calls the existing deploy_tool Tauri command which streams progress.
  const deployTool = useCallback(async (tool) => {
    activeOpsRef.current += 1;
    setPending(tool.id, "updating");
    appendActionLog(tool.id, tool.name, "deploy", [`⬇ Deploying ${tool.name}…`]);
    try {
      if (IS_TAURI) {
        const { invoke } = await import("@tauri-apps/api/core");

        // Re-read tools.json fresh so we always deploy with the current
        // ports / entrypoint / health_check — not stale React state.
        let freshEntry = null;
        try {
          const freshRegistry = await invoke("load_registry");
          freshEntry = freshRegistry.find(e => e.id === tool.id) || null;
        } catch (_) {}

        const effectiveTool = freshEntry ? { ...tool, ...freshEntry } : tool;
        const isCompose = !!(effectiveTool.source?.compose_url || effectiveTool.source?.compose_file || effectiveTool.source?.compose_repo || effectiveTool.compose_url || effectiveTool.compose_file || effectiveTool.compose_repo);
        const ref = isCompose ? "" : fullImage(effectiveTool);
        const portSpecs = (effectiveTool.ports || []).map(p =>
          String(p).includes(":") ? String(p) : `${p}:${p}`
        );

        // Stream deploy:progress events into the card's action log
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen("deploy:progress", (event) => {
          const raw = typeof event.payload === "string" ? event.payload : String(event.payload);
          if (!raw.trim()) return;
          appendActionLog(tool.id, tool.name, "deploy", [raw]);
          // Append a diagnostic hint for known error patterns
          if (raw.startsWith("stderr: ") || raw.startsWith("Error")) {
            const hint = diagnoseError(raw);
            if (hint) appendActionLog(tool.id, tool.name, "deploy", [`  ↳ ${hint}`]);
          }
        });

        try {
          const result = await invoke("deploy_tool", {
            toolId:               effectiveTool.id,
            image:                ref,
            composeUrl:           effectiveTool.compose_url           || null,
            composeFile:          effectiveTool.compose_file          || null,
            composeRepo:          effectiveTool.compose_repo          || null,
            composeRepoTag:       effectiveTool.compose_repo_tag      || null,
            composeSubdir:        effectiveTool.compose_subdir        || null,
            preDeploy:            effectiveTool.pre_deploy            || effectiveTool.source?.pre_deploy || [],
            ports:                portSpecs,
            entrypoint:           effectiveTool.entrypoint            || null,
            cliTool:              effectiveTool.cli_tool              || false,
            env:                  buildEnvFromVars(effectiveTool),
            portOverrides: effectiveTool.source?.port_overrides || effectiveTool.compose_port_overrides || {},
          });
          if (result?.success === false) throw new Error(result.message || "Deploy failed");
          appendActionLog(tool.id, tool.name, "deploy", [`✓ ${tool.name} deployed.`]);
        } finally {
          unlisten();
        }
      } else {
        appendActionLog(tool.id, tool.name, "deploy", [`✓ Deploy (mock) complete`]);
      }
    } catch (err) {
      appendActionLog(tool.id, tool.name, "deploy", [`✗ Deploy failed: ${err?.message || String(err)}`]);
    }
    activeOpsRef.current = Math.max(0, activeOpsRef.current - 1);
    await pollContainers();
    clearPending(tool.id);
    await fetchLogs(tool);
    window.dispatchEvent(new CustomEvent("athena:registry-reload"));
  }, [pollContainers, appendActionLog, fetchLogs]);

  // Stop, remove containers, and optionally remove the image too.
  const deleteTool = useCallback(async (tool) => {
    activeOpsRef.current += 1;
    setPending(tool.id, "deleting");
    const isCompose = !!(tool.source?.compose_url || tool.source?.compose_file || tool.source?.compose_repo || tool.compose_url || tool.compose_file || tool.compose || tool.compose_repo);
    appendActionLog(tool.id, tool.name, "delete", [`■ Removing ${tool.name}…`]);
    try {
      if (IS_TAURI) {
        const { invoke } = await import("@tauri-apps/api/core");
        const { listen }  = await import("@tauri-apps/api/event");

        const unlisten = await listen("deploy:progress", (event) => {
          const raw = typeof event.payload === "string" ? event.payload : String(event.payload);
          if (raw.trim()) appendActionLog(tool.id, tool.name, "delete", [raw]);
        });

        try {
          if (isCompose) {
            appendActionLog(tool.id, tool.name, "delete", [
              `▶ ${activeRuntime} compose -p ${tool.id} down --remove-orphans --volumes`,
            ]);
            const result = await invoke("undeploy_tool", {
              toolId:        tool.id,
              containerIds:  tool.containerIds || [],
              composeUrl:    tool.compose_url       || null,
              composeFile:   tool.compose_file      || null,
              composeRepo:   tool.compose_repo      || null,
              composeRepoTag:tool.compose_repo_tag  || null,
              composeSubdir: tool.compose_subdir    || null,
            });
            if (result?.success === false) throw new Error(result.message || "Undeploy failed");
          } else {
            for (const id of tool.containerIds || []) {
              const short = id.slice(0, 12);
              appendActionLog(tool.id, tool.name, "delete", [`▶ ${activeRuntime} stop -t 10 ${short}`]);
              await invoke("stop_container",   { containerId: id, timeout: 10 });
              appendActionLog(tool.id, tool.name, "delete", [`▶ ${activeRuntime} rm -f ${short}`]);
              await invoke("remove_container", { containerId: id, force: true });
            }
            const ref = fullImage(tool);
            if (ref) {
              appendActionLog(tool.id, tool.name, "delete", [`▶ ${activeRuntime} rmi ${ref}`]);
              await invoke("remove_image", { reference: ref });
            }
          }
        } finally {
          unlisten();
        }
      } else {
        await new Promise(r => setTimeout(r, 600));
      }
      appendActionLog(tool.id, tool.name, "delete", [`✓ ${tool.name} removed.`]);
    } catch (err) {
      appendActionLog(tool.id, tool.name, "delete", [`✗ Remove failed: ${err?.message || String(err)}`]);
    }
    activeOpsRef.current = Math.max(0, activeOpsRef.current - 1);
    clearPending(tool.id);
    await pollContainers();
    window.dispatchEvent(new CustomEvent("athena:registry-reload"));
  }, [pollContainers, appendActionLog, activeRuntime]);

  const clearLogs = useCallback((toolId) => {
    setLogs(prev => ({ ...prev, [toolId]: [] }));
  }, []);

  const manualRefresh = useCallback(async () => {
    await pollContainers();
    await pollStats();
  }, [pollContainers, pollStats]);

  // Kill the active deploy/pull process and reset pending state for the tool
  const abortTool = useCallback(async (tool) => {
    if (IS_TAURI) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("cancel_deploy");
      } catch (_) {}
    }
    appendActionLog(tool.id, tool.name, "abort", ["■ Operation aborted by user."]);
    clearPending(tool.id);
    await pollContainers();
  }, [appendActionLog, pollContainers]);

  // ── Context value ─────────────────────────────────────── //
  const value = {
    // Connection
    connected,
    socketPath,
    runtimeVersion,
    apiVersion,
    connectionError,
    activeRuntime,
    // Data
    tools,
    logs,
    // Actions
    startTool,
    stopTool,
    restartTool,
    updateTool,
    deployTool,
    abortTool,
    deleteTool,
    openTool,
    fetchLogs,
    clearLogs,
    manualRefresh,
  };

  return (
    <ContainerContext.Provider value={value}>
      {children}
    </ContainerContext.Provider>
  );
}

export function useContainer() {
  const ctx = useContext(ContainerContext);
  if (!ctx) throw new Error("useContainer must be used inside <ContainerProvider>");
  return ctx;
}
