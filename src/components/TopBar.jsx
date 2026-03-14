import React, { useState } from "react";
import {
  Search, Bell, RefreshCw, Download, Upload,
  Grid, Shield, ShieldCheck, Activity, Eye, Network, Wrench,
  Database, Lock, ClipboardList, Cpu, BookOpen, Settings, Camera,
  Zap, Target, Terminal, AlertTriangle, Crosshair, Globe,
  HardDrive, Layers, Package, Radio, Server, Box, Bug,
} from "lucide-react";
import { useNavigation } from "../context/NavigationContext";
import "./TopBar.css";

const ICON_MAP = {
  Grid, Shield, ShieldCheck, Activity, Search, Eye, Network, Wrench,
  Database, Lock, ClipboardList, Cpu, BookOpen, Settings, Camera,
  Zap, Target, Terminal, AlertTriangle, Crosshair, Globe,
  HardDrive, Layers, Package, Radio, Server, Box, Bug,
};

export default function TopBar({ title, titleIcon, onSearch, onRefresh, onNavigate: onNavigateProp }) {
  const contextNavigate = useNavigation();
  const navigate = onNavigateProp || contextNavigate;
  const [searchVal,   setSearchVal]   = useState("");
  const [refreshing,  setRefreshing]  = useState(false);

  function handleSearch(e) {
    setSearchVal(e.target.value);
    onSearch?.(e.target.value);
  }

  async function handleRefresh() {
    if (!onRefresh) return;
    setRefreshing(true);
    try { await onRefresh(); } catch (_) {}
    // Keep spin for at least 600ms so the animation is visible
    setTimeout(() => setRefreshing(false), 600);
  }

  const TitleIcon = ICON_MAP[titleIcon] || null;

  return (
    <header className="topbar">
      {/* Page title */}
      <div className="topbar__title">
        {TitleIcon && <TitleIcon size={15} className="topbar__title-icon" />}
        {title}
      </div>

      {/* Search — only shown on pages that support it */}
      {onSearch && (
        <div className="topbar__search">
          <Search size={13} className="topbar__search-icon" />
          <input
            className="topbar__search-input"
            placeholder="Search tools, containers, images…"
            value={searchVal}
            onChange={handleSearch}
          />
        </div>
      )}

      {/* Actions */}
      <div className="topbar__actions">
        <button
          className={`topbar__btn${refreshing ? " topbar__btn--spinning" : ""}`}
          onClick={handleRefresh}
          title="Refresh"
          disabled={refreshing}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="topbar__btn"
          title="Audit Log"
          onClick={() => navigate("audit")}
        >
          <Bell size={14} />
        </button>
        <button
          className="topbar__btn"
          title="Import config"
          onClick={() => navigate("settings:import")}
        >
          <Upload size={14} />
        </button>
        <button
          className="topbar__btn"
          title="Export config"
          onClick={() => navigate("settings:export")}
        >
          <Download size={14} />
        </button>
      </div>
    </header>
  );
}
