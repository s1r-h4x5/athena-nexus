import React, { useState } from "react";
import athenaLogo from "../assets/logo.png";
import {
  Grid, Shield, ShieldCheck, Activity, Search, Eye, Network, Wrench,
  ChevronLeft, ChevronRight, Plus, Settings, BookOpen, Camera,
  Database, Lock, ClipboardList, Cpu, Wifi, WifiOff, Pencil,
  Zap, Target, Terminal, AlertTriangle, Crosshair, Globe,
  HardDrive, Layers, Package, Radio, Server, Box, Bug,
} from "lucide-react";
import { useContainer } from "../context/ContainerContext";
import { IS_TAURI } from "../lib/container";
import "./Sidebar.css";

const ICON_MAP = {
  Grid, Shield, ShieldCheck, Activity, Search, Eye, Network, Wrench,
  Database, Lock, ClipboardList, Cpu, BookOpen, Settings, Camera,
  Zap, Target, Terminal, AlertTriangle, Crosshair, Globe,
  HardDrive, Layers, Package, Radio, Server, Box, Bug,
};

const SYSTEM_IDS = new Set([
  "all", "vulnerability", "siem", "forensics", "threat-intel", "network", "utilities",
  "topology", "preflight", "vault", "snapshot", "audit", "usertools", "registry", "settings",
]);

function NavItem({ category, isActive, isCollapsed, onClick, badge, onEdit }) {
  const Icon = ICON_MAP[category.icon] || Grid;
  const canEdit = !SYSTEM_IDS.has(category.id) && !isCollapsed;

  return (
    <button
      className={`nav-item ${isActive ? "nav-item--active" : ""} ${canEdit ? "nav-item--editable" : ""}`}
      onClick={() => onClick(category.id)}
      title={isCollapsed ? category.label : undefined}
    >
      <span className="nav-item__icon"><Icon size={16} /></span>
      {!isCollapsed && <span className="nav-item__label">{category.label}</span>}
      {!isCollapsed && canEdit && (
        <span
          className="nav-item__edit-btn"
          title="Edit category"
          onClick={e => { e.stopPropagation(); onEdit(category); }}
        >
          <Pencil size={11} />
        </span>
      )}
      {!isCollapsed && badge != null && (
        <span className="nav-item__badge">{badge}</span>
      )}
    </button>
  );
}

export default function Sidebar({
  categories,
  activeCategory,
  onCategoryChange,
  toolCounts,
  onAddCategory,
  onEditCategory,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [logoAnimating, setLogoAnimating] = useState(false);
  const { connected, podmanVersion, socketPath, activeRuntime } = useContainer();
  const runtimeLabel = activeRuntime === "docker" ? "Docker" : "Podman";

  const systemNav = [
    { id: "topology",   label: "Network Topology",     icon: "Network"       },
    { id: "preflight",  label: "Pre-flight Checks",    icon: "ShieldCheck"   },
    { id: "vault",      label: "Secrets Vault",        icon: "Lock"          },
    { id: "snapshot",   label: "Snapshot & Backup",    icon: "Camera"        },
    { id: "audit",      label: "Audit Log",            icon: "ClipboardList" },
    { id: "usertools",  label: "User-Defined Tools",   icon: "Wrench"        },
    { id: "registry",   label: "Tool Registry",        icon: "BookOpen"      },
    { id: "settings",   label: "Settings",             icon: "Settings"      },
  ];

  async function handleLogoClick() {
    setLogoAnimating(true);
    setTimeout(() => setLogoAnimating(false), 600);
    const url = "https://athenaos.org/en/getting-started/manifesto/";
    if (IS_TAURI) {
      try {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(url);
      } catch (_) {}
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  return (
    <aside className={`sidebar ${collapsed ? "sidebar--collapsed" : ""}`}>
      {/* Logo */}
      <div className="sidebar__header">
        <div className="sidebar__logo">
          <div
            className={`sidebar__logo-icon${logoAnimating ? " sidebar__logo-icon--pulse" : ""}`}
            onClick={handleLogoClick}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === "Enter" && handleLogoClick()}
          >
            <img src={athenaLogo} alt="Athena" className="sidebar__logo-img" />
          </div>
          {!collapsed && (
            <div className="sidebar__logo-text">
              <span className="sidebar__logo-title">ATHENA NEXUS</span>
              <span className="sidebar__logo-sub">Container Manager</span>
            </div>
          )}
        </div>
        <button
          className="sidebar__collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Runtime connection status */}
      <div
        className={`sidebar__status ${!connected ? "sidebar__status--error" : ""}`}
        title={connected
          ? `${runtimeLabel} ${podmanVersion || ""} • ${socketPath || "unix socket"}`
          : `${runtimeLabel} socket unreachable`}
      >
        <div className={`sidebar__status-dot ${connected ? "sidebar__status-dot--connected" : "sidebar__status-dot--disconnected"}`} />
        {!collapsed && (
          <span className="sidebar__status-text">
            {connected
              ? <>{runtimeLabel} <span className="glow-green">LIVE</span>{podmanVersion ? ` ${podmanVersion}` : ""}</>
              : <span style={{ color: "var(--red-bright)" }}>DISCONNECTED</span>}
          </span>
        )}
        {!collapsed && (connected
          ? <Wifi size={11} style={{ color: "var(--green-dim)", marginLeft: "auto" }} />
          : <WifiOff size={11} style={{ color: "var(--red-bright)", marginLeft: "auto" }} />
        )}
      </div>

      <div className="sidebar__categories-section">
        <div className="sidebar__divider">{!collapsed && <span>CATEGORIES</span>}</div>

        <div className="sidebar__categories-scroll">
          <nav className="sidebar__nav">
            {categories.map((cat) => (
              <NavItem
                key={cat.id}
                category={cat}
                isActive={activeCategory === cat.id}
                isCollapsed={collapsed}
                onClick={onCategoryChange}
                badge={cat.id !== "all" ? toolCounts[cat.id] : undefined}
                onEdit={onEditCategory}
              />
            ))}
            <button
              className="nav-item nav-item--add"
              onClick={onAddCategory}
              title={collapsed ? "Add category" : undefined}
            >
              <span className="nav-item__icon"><Plus size={14} /></span>
              {!collapsed && <span className="nav-item__label">Add Category</span>}
            </button>
          </nav>
        </div>
      </div>

      <div className="sidebar__divider">{!collapsed && <span>SYSTEM</span>}</div>
      <nav className="sidebar__nav sidebar__nav--system">
        {systemNav.map((item) => (
          <NavItem
            key={item.id}
            category={item}
            isActive={activeCategory === item.id}
            isCollapsed={collapsed}
            onClick={onCategoryChange}
          />
        ))}
      </nav>

      {!collapsed && (
        <div className="sidebar__footer">
          <span className="mono">v0.1.0-alpha</span>
          <span>MIT License</span>
        </div>
      )}

      <button
        className="sidebar__expand-btn"
        onClick={() => setCollapsed(false)}
        title="Expand sidebar"
      >
        <ChevronRight size={14} />
      </button>
    </aside>
  );
}
