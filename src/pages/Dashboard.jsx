import React, { useState, useMemo } from "react";
import ToolCard from "../components/ToolCard";
import TopBar from "../components/TopBar";
import ConnectionBanner from "../components/ConnectionBanner";
import LogDrawer from "../components/LogDrawer";
import ThemedSelect from "../components/ThemedSelect";
import { useContainer } from "../context/ContainerContext";
import { MOCK_CATEGORIES } from "../lib/mockData";
import { LayoutGrid, List, Filter, SortAsc } from "lucide-react";
import { displayImage } from "../lib/imageUtils";
import "./Dashboard.css";

const SORT_OPTIONS = [
  { value: "name",   label: "Name" },
  { value: "status", label: "Status" },
  { value: "cpu",    label: "CPU" },
  { value: "mem",    label: "Memory" },
];

const STATUS_FILTER_OPTIONS = [
  { value: "all",      label: "All" },
  { value: "running",  label: "Running" },
  { value: "stopped",  label: "Stopped" },
  { value: "error",    label: "Error" },
];

const STATUS_SORT_ORDER = { running: 0, starting: 1, updating: 2, error: 3, stopping: 4, stopped: 5 };

export default function Dashboard({ activeCategory, onCategoryChange, categories }) {
  const {
    tools,
    connected,
    connectionError,
    activeRuntime,
    manualRefresh,
    startTool,
    stopTool,
    restartTool,
    updateTool,
    deployTool,
    abortTool,
    deleteTool,
    openTool,
  } = useContainer();

  // Refresh: reload tools.json from disk AND refresh live container state
  async function handleRefresh() {
    window.dispatchEvent(new CustomEvent("athena:registry-reload"));
    await manualRefresh();
  }

  const [search, setSearch]             = useState("");
  const [viewMode, setViewMode]         = useState("grid");
  const [sortBy, setSortBy]             = useState("status");
  const [statusFilter, setStatusFilter] = useState("all");
  const [logToolId, setLogToolId] = useState(null);

  // Filter + sort
  const filteredTools = useMemo(() => {
    let result = [...tools];

    if (activeCategory && activeCategory !== "all") {
      result = result.filter((t) =>
        (t.categories && t.categories.includes(activeCategory)) ||
        t.category === activeCategory
      );
    }
    if (statusFilter !== "all") {
      result = result.filter((t) => t.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((t) =>
        t.name.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        displayImage(t)?.toLowerCase().includes(q)
      );
    }

    result.sort((a, b) => {
      switch (sortBy) {
        case "name":   return a.name.localeCompare(b.name);
        case "status": return (STATUS_SORT_ORDER[a.status] ?? 9) - (STATUS_SORT_ORDER[b.status] ?? 9);
        case "cpu":    return b.cpu - a.cpu;
        case "mem":    return b.mem - a.mem;
        default:       return 0;
      }
    });
    return result;
  }, [tools, activeCategory, search, statusFilter, sortBy]);

  // Stats summary
  const stats = useMemo(() => ({
    total:   tools.length,
    running: tools.filter((t) => t.status === "running").length,
    stopped: tools.filter((t) => t.status === "stopped").length,
    error:   tools.filter((t) => t.status === "error").length,
  }), [tools]);

  // Route ToolCard actions → context actions
  async function handleAction(action, tool) {
    switch (action) {
      case "start":   await startTool(tool);   break;
      case "stop":    await stopTool(tool);    break;
      case "restart": await restartTool(tool); break;
      case "update":  await updateTool(tool);  break;
      case "deploy":
        // Don't deploy from category view — navigate to Tool Registry
        // and expand the relevant entry there so the user has full context.
        onCategoryChange(`registry:expand:${tool.id}`);
        break;
      case "open":    openTool(tool);          break;
      case "logs":    setLogToolId(tool.id);   break;
      case "abort":   await abortTool(tool);   break;
      case "delete":  await deleteTool(tool);  break;
    }
  }

  const activeCat     = (categories || MOCK_CATEGORIES).find((c) => c.id === activeCategory);
  const categoryLabel = activeCat?.label || "All Tools";
  const categoryIcon  = activeCat?.icon  || "Grid";

  return (
    <div className="dashboard">
      <TopBar
        title={categoryLabel}
        titleIcon={categoryIcon}
        onSearch={setSearch}
        onRefresh={handleRefresh}
        onNavigate={onCategoryChange}
      />

      {/* Connection error banner */}
      {!connected && connectionError && (
        <ConnectionBanner error={connectionError} onRetry={handleRefresh} runtime={activeRuntime} />
      )}

      {/* Stats bar */}
      <div className="dashboard__statsbar">
        <div className="stat-pill">
          <span className="stat-pill__value">{stats.total}</span>
          <span className="stat-pill__label">TOTAL</span>
        </div>
        <div className="stat-pill stat-pill--green">
          <span className="stat-pill__value">{stats.running}</span>
          <span className="stat-pill__label">RUNNING</span>
        </div>
        <div className="stat-pill stat-pill--muted">
          <span className="stat-pill__value">{stats.stopped}</span>
          <span className="stat-pill__label">STOPPED</span>
        </div>
        {stats.error > 0 && (
          <div className="stat-pill stat-pill--red">
            <span className="stat-pill__value">{stats.error}</span>
            <span className="stat-pill__label">ERROR</span>
          </div>
        )}

        <div style={{ flex: 1 }} />

        <div className="dashboard__filters">
          <div className="filter-group">
            <Filter size={12} />
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`filter-btn ${statusFilter === opt.value ? "filter-btn--active" : ""}`}
                onClick={() => setStatusFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="filter-group">
            <SortAsc size={12} />
            <ThemedSelect
              value={sortBy}
              options={SORT_OPTIONS}
              onChange={setSortBy}
            />
          </div>

          <div className="view-toggle">
            <button
              className={`view-toggle__btn ${viewMode === "grid" ? "view-toggle__btn--active" : ""}`}
              onClick={() => setViewMode("grid")}
              title="Grid view"
            >
              <LayoutGrid size={13} />
            </button>
            <button
              className={`view-toggle__btn ${viewMode === "list" ? "view-toggle__btn--active" : ""}`}
              onClick={() => setViewMode("list")}
              title="List view"
            >
              <List size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Tool grid */}
      <div className="dashboard__content">
        {filteredTools.length === 0 ? (
          <div className="dashboard__empty">
            <span className="mono">// No Tools Found</span>
            <p>
              {!connected
                ? "Connect Podman to see running containers."
                : "Try adjusting your filters or add a new tool."}
            </p>
          </div>
        ) : (
          <div className={`tool-grid tool-grid--${viewMode}`}>
            {filteredTools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} onAction={handleAction} runtimeConnected={connected} />
            ))}
          </div>
        )}
      </div>

      {/* M5 — Log Viewer */}
      <LogDrawer
        toolId={logToolId}
        onClose={() => setLogToolId(null)}
      />
    </div>
  );
}
