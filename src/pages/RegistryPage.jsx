// ═══════════════════════════════════════════════════════════
// pages/RegistryPage.jsx — Tool Registry Browser
//
// Shows all tools from tools.yaml. Each entry shows:
//   - install status (deployed / not deployed)
//   - category, tags, ports, image
//   - one-click deploy with live progress panel
// ═══════════════════════════════════════════════════════════

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  Search, Tag, Layers, ExternalLink, Download, CheckCircle2,
  Circle, ChevronDown, ChevronUp, RefreshCw, X, Play, Package, Loader,
} from "lucide-react";
import { useContainer } from "../context/ContainerContext";
import { useDeployContext } from "../context/DeployContext";
import TopBar from "../components/TopBar";
import { displayImage, fullImage } from "../lib/imageUtils";
import "./RegistryPage.css";

const CATEGORY_LABELS = {
  "vulnerability": "Vuln Management",
  "siem":          "SIEM",
  "forensics":     "Forensics",
  "threat-intel":  "Threat Intel",
  "network":       "Network",
  "utilities":     "Utilities",
};

const CATEGORY_COLORS = {
  "vulnerability": "red",
  "siem":          "cyan",
  "forensics":     "green",
  "threat-intel":  "amber",
  "network":       "purple",
  "utilities":     "muted",
};

export default function RegistryPage({ categories: propCategories, registry = [], expandToolId = null, onExpanded = null }) {
  const { tools: liveTools, connected, manualRefresh } = useContainer();
  const { openDeploy, bgDeployId } = useDeployContext();

  // Signal App to re-read tools.json on mount and on refresh
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("athena:registry-reload"));
  }, []);

  async function handleRefresh() {
    window.dispatchEvent(new CustomEvent("athena:registry-reload"));
    await manualRefresh();
  }

  const [search, setSearch]           = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter]     = useState("all"); // all | deployed | available
  const [expandedId, setExpandedId]   = useState(null);

  // Build a set of deployed tool IDs from live container data
  const deployedIds = useMemo(() => {
    const ids = new Set();
    for (const t of liveTools) {
      if (t.status !== "stopped" || t.containerIds?.length > 0) {
        ids.add(t.id);
      }
    }
    return ids;
  }, [liveTools]);

  // Build category list from ALL category assignments (not just primary)
  const categories = useMemo(() => {
    const cats = new Set();
    for (const e of registry) {
      const all = e.categories?.length ? e.categories : [e.category];
      all.forEach(c => cats.add(c));
    }
    return ["all", ...Array.from(cats)];
  }, [registry]);

  // Label lookup: App's dynamic categories take priority over hardcoded map
  function catLabel(id) {
    if (id === "all") return "All Tools";
    if (propCategories) {
      const found = propCategories.find(c => c.id === id);
      if (found) return found.label;
    }
    return CATEGORY_LABELS[id] || id;
  }

  // Filtered + sorted registry entries
  const filtered = useMemo(() => {
    let result = [...registry];

    if (categoryFilter !== "all") {
      result = result.filter(e => {
        const cats = e.categories?.length ? e.categories : [e.category];
        return cats.includes(categoryFilter);
      });
    }
    if (statusFilter === "deployed") {
      result = result.filter(e => deployedIds.has(e.id));
    } else if (statusFilter === "available") {
      result = result.filter(e => !deployedIds.has(e.id));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.description?.toLowerCase().includes(q) ||
        e.tags?.some(t => t.toLowerCase().includes(q)) ||
        fullImage(e)?.toLowerCase().includes(q)
      );
    }

    // Sort: deployed first, then alphabetical
    result.sort((a, b) => {
      const ad = deployedIds.has(a.id) ? 0 : 1;
      const bd = deployedIds.has(b.id) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    return result;
  }, [registry, categoryFilter, statusFilter, search, deployedIds]);

  // Refs for scrolling to a tool entry by id
  const entryRefs = useRef({});

  // When App navigates here with expandToolId, expand + scroll to that tool
  useEffect(() => {
    if (!expandToolId) return;
    setExpandedId(expandToolId);
    // Scroll after a tick so the DOM has updated
    setTimeout(() => {
      const el = entryRefs.current[expandToolId];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    if (onExpanded) onExpanded();
  }, [expandToolId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stats
  const stats = useMemo(() => ({
    total:    registry.length,
    deployed: deployedIds.size,
    available: registry.length - deployedIds.size,
  }), [registry, deployedIds]);

  function toggleExpand(id) {
    setExpandedId(prev => prev === id ? null : id);
  }

  function handleDeploy(entry) {
    openDeploy(entry);
  }

  // Find the live tool matching this registry entry (for status)
  function getLiveTool(entry) {
    return liveTools.find(t => t.id === entry.id);
  }

  return (
    <div className="registry-page">
      <TopBar
        title="Tool Registry"
        titleIcon="BookOpen"
        onSearch={setSearch}
        onRefresh={handleRefresh}
        onAddTool={null}
      />

      {/* Stats bar */}
      <div className="registry-page__statsbar">
        <div className="stat-pill">
          <span className="stat-pill__value">{stats.total}</span>
          <span className="stat-pill__label">TOTAL</span>
        </div>
        <div className="stat-pill stat-pill--green">
          <span className="stat-pill__value">{stats.deployed}</span>
          <span className="stat-pill__label">DEPLOYED</span>
        </div>
        <div className="stat-pill stat-pill--muted">
          <span className="stat-pill__value">{stats.available}</span>
          <span className="stat-pill__label">AVAILABLE</span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Status filter */}
        <div className="registry-page__filters">
          {["all", "deployed", "available"].map(f => (
            <button
              key={f}
              className={`filter-btn ${statusFilter === f ? "filter-btn--active" : ""}`}
              onClick={() => setStatusFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="registry-page__body">
        {/* Category sidebar */}
        <aside className="registry-page__cats">
          {categories.map(cat => {
            const count = cat === "all"
              ? registry.length
              : registry.filter(e => {
                  const cats = e.categories?.length ? e.categories : [e.category];
                  return cats.includes(cat);
                }).length;
            return (
              <button
                key={cat}
                className={`cat-btn ${categoryFilter === cat ? "cat-btn--active" : ""}`}
                onClick={() => setCategoryFilter(cat)}
              >
                <span className="cat-btn__label">
                  {catLabel(cat)}
                </span>
                <span className="cat-btn__count">{count}</span>
              </button>
            );
          })}
        </aside>

        {/* Registry entries */}
        <div className="registry-page__list">
          {filtered.length === 0 ? (
            <div className="registry-page__empty">
              <span className="mono">// no tools match</span>
              <p>Try a different filter or search term.</p>
            </div>
          ) : (
            filtered.map(entry => (
              <div key={entry.id} ref={el => { entryRefs.current[entry.id] = el; }}>
                <RegistryEntry
                  entry={entry}
                  liveTool={getLiveTool(entry)}
                  isDeployed={deployedIds.has(entry.id)}
                  isExpanded={expandedId === entry.id}
                  onToggle={() => toggleExpand(entry.id)}
                  onDeploy={() => handleDeploy(entry)}
                  connected={connected}
                  catLabel={catLabel}
                  isDeployingInBackground={bgDeployId === entry.id}
                />
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}

// ── Registry entry row ────────────────────────────────────── //

function RegistryEntry({ entry, liveTool, isDeployed, isExpanded, onToggle, onDeploy, connected, catLabel, isDeployingInBackground }) {
  const catColor = CATEGORY_COLORS[entry.category] || "muted";
  // Fallback in case catLabel isn't passed
  const getLabel = catLabel || (id => CATEGORY_LABELS[id] || id);
  const statusLabel = isDeployed
    ? (liveTool?.status === "running" ? "RUNNING" : "DEPLOYED")
    : "NOT DEPLOYED";

  return (
    <div className={`reg-entry ${isDeployed ? "reg-entry--deployed" : ""} ${isExpanded ? "reg-entry--expanded" : ""} ${isDeployingInBackground ? "reg-entry--deploying" : ""}`}>
      {/* Main row */}
      <div className="reg-entry__row" onClick={onToggle}>
        {/* Status indicator */}
        <div className={`reg-entry__status-dot ${isDeployingInBackground ? "dot--deploying" : isDeployed ? (liveTool?.status === "running" ? "dot--running" : "dot--deployed") : "dot--none"}`} />

        {/* Name + category */}
        <div className="reg-entry__identity">
          <span className="reg-entry__name">{entry.name}</span>
          <span className={`reg-entry__cat cat--${catColor}`}>
            {getLabel(entry.category)}
          </span>
          {(entry.source?.compose_url || entry.compose_url) && (
            <span className="reg-entry__compose-badge">
              <Layers size={9} /> COMPOSE
            </span>
          )}
          {isDeployingInBackground && (
            <span className="reg-entry__deploying-badge">
              <Loader size={9} className="spin" /> DEPLOYING…
            </span>
          )}
        </div>

        {/* Description (truncated) */}
        <p className="reg-entry__desc">{entry.description}</p>

        {/* Right side */}
        <div className="reg-entry__right">
          <span className={`reg-entry__status-badge ${isDeployed ? "badge--deployed" : "badge--none"}`}>
            {isDeployed
              ? <><CheckCircle2 size={10} /> {statusLabel}</>
              : <><Circle size={10} /> {statusLabel}</>
            }
          </span>

          {/* Deploy / Manage / Watch button */}
          {connected && (
            <button
              className={`reg-entry__action-btn ${isDeployingInBackground ? "reg-entry__action-btn--watch" : isDeployed ? "reg-entry__action-btn--manage" : "reg-entry__action-btn--deploy"}`}
              onClick={(e) => { e.stopPropagation(); onDeploy(); }}
              title={isDeployingInBackground ? "Watch deployment progress" : isDeployed ? "Manage deployment" : "Deploy this tool"}
            >
              {isDeployingInBackground
                ? <><Loader size={12} className="spin" /> Watch</>
                : isDeployed
                  ? <><RefreshCw size={12} /> Manage</>
                  : <><Download size={12} /> Deploy</>
              }
            </button>
          )}

          <button className="reg-entry__expand-btn" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded detail panel */}
      {isExpanded && (
        <div className="reg-entry__detail">
          <div className="reg-entry__detail-grid">
            {/* Image */}
            <div className="reg-detail-row">
              <span className="reg-detail-key">IMAGE</span>
              <span className="reg-detail-val mono">{displayImage(entry) || "—"}</span>
            </div>

            {/* Compose URL */}
            {(entry.source?.compose_url || entry.compose_url) && (
              <div className="reg-detail-row">
                <span className="reg-detail-key">COMPOSE</span>
                <a
                  className="reg-detail-val mono reg-detail-link"
                  href={entry.source?.compose_url || entry.compose_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                >
                  {entry.source?.compose_url || entry.compose_url} <ExternalLink size={10} />
                </a>
              </div>
            )}

            {/* Ports */}
            {(entry.access?.ports || entry.ports || []).length > 0 && (
              <div className="reg-detail-row">
                <span className="reg-detail-key">PORTS</span>
                <span className="reg-detail-val">
                  {(entry.access?.ports || entry.ports || []).map(p => (
                    <span key={p} className="port-tag mono">{p}</span>
                  ))}
                </span>
              </div>
            )}

            {/* Entrypoint */}
            {(entry.access?.entrypoint || entry.entrypoint) && (
              <div className="reg-detail-row">
                <span className="reg-detail-key">ENTRY</span>
                <span className="reg-detail-val mono cyan-text">{entry.access?.entrypoint || entry.entrypoint}</span>
              </div>
            )}

            {/* Health check */}
            {(entry.access?.health_check || entry.health_check) && (
              <div className="reg-detail-row">
                <span className="reg-detail-key">HEALTH</span>
                <span className="reg-detail-val mono">{entry.access?.health_check || entry.health_check}</span>
              </div>
            )}

            {/* Tags */}
            {entry.tags?.length > 0 && (
              <div className="reg-detail-row">
                <span className="reg-detail-key">TAGS</span>
                <span className="reg-detail-val">
                  {entry.tags.map(t => (
                    <span key={t} className="tag-badge">{t}</span>
                  ))}
                </span>
              </div>
            )}
          </div>

          {/* Live container info if deployed */}
          {liveTool && liveTool.containerIds?.length > 0 && (
            <div className="reg-entry__live-info">
              <span className="reg-detail-key">CONTAINERS</span>
              {liveTool.rawNames?.map(name => (
                <span key={name} className="container-name-tag mono">{name}</span>
              ))}
              {liveTool.status === "running" && (
                <>
                  <span className="live-stat">
                    CPU <span className="cyan-text mono">{liveTool.cpu?.toFixed(1)}%</span>
                  </span>
                  <span className="live-stat">
                    MEM <span className="cyan-text mono">
                      {liveTool.mem >= 1024
                        ? `${(liveTool.mem / 1024).toFixed(1)} GB`
                        : `${liveTool.mem} MB`}
                    </span>
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

