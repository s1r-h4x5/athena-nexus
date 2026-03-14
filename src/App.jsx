import React, { useState, useMemo, useEffect } from "react";
import { ContainerProvider } from "./context/ContainerContext";
import { NavigationProvider } from "./context/NavigationContext";
import { DeployProvider } from "./context/DeployContext";
import { useRegistry } from "./hooks/useRegistry";
import Sidebar from "./components/Sidebar";
import Dashboard from "./pages/Dashboard";
import NetworkTopology from "./pages/NetworkTopology";
import VaultPage from "./pages/VaultPage";
import PreflightPage from "./pages/PreflightPage";
import SnapshotPage from "./pages/SnapshotPage";
import AuditPage from "./pages/AuditPage";
import SettingsPage from "./pages/SettingsPage";
import UserToolsPage from "./pages/UserToolsPage";
import RealRegistryPage from "./pages/RegistryPage";
import CategoryModal from "./components/CategoryModal";
import { MOCK_CATEGORIES } from "./lib/mockData";

// Inner app — has access to PodmanContext via hooks
function AppInner({ registry, onToolSaved }) {
  const [activeCategory, setActiveCategory] = useState("all");
  const [categories, setCategories] = useState(MOCK_CATEGORIES);
  const [settingsTab, setSettingsTab] = useState("general");
  const [registryExpandId, setRegistryExpandId] = useState(null);
  const [categoryModal, setCategoryModal] = useState(null); // null | { mode: "add" } | { mode: "edit", cat }

  // Count tools per category from the registry (gives badges before Podman connects)
  const toolCounts = useMemo(() => {
    const counts = {};
    for (const entry of registry) {
      // Count the full categories array so multi-category tools increment all their cats
      const cats = entry.categories?.length ? entry.categories : [entry.category];
      for (const cat of cats) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    return counts;
  }, [registry]);

  function handleAddCategory() {
    setCategoryModal({ mode: "add" });
  }

  function handleEditCategory(cat) {
    setCategoryModal({ mode: "edit", cat });
  }

  function handleCategoryModalConfirm({ name, icon }) {
    if (categoryModal?.mode === "add") {
      const id = name.toLowerCase().replace(/\s+/g, "-");
      setCategories(prev => [...prev, { id, label: name, icon }]);
    } else if (categoryModal?.mode === "edit") {
      const { cat } = categoryModal;
      setCategories(prev => prev.map(c =>
        c.id === cat.id ? { ...c, label: name, icon } : c
      ));
    }
    setCategoryModal(null);
  }

  function handleDeleteCategory(cat) {
    setCategories(prev => prev.filter(c => c.id !== cat.id));
    // If the deleted category is active, fall back to "all"
    if (activeCategory === cat.id) setActiveCategory("all");
    setCategoryModal(null);

    // Strip the deleted category from all user-defined tool definitions
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("user_tools_list").then(tools => {
        for (const tool of (tools || [])) {
          const cats = tool.categories?.length ? tool.categories : [tool.category];
          if (cats.includes(cat.id)) {
            const next = cats.filter(c => c !== cat.id);
            invoke("user_tools_update", {
              id:         tool.id,
              categories: next.length ? next : ["utilities"],
              category:   next[0] || "utilities",
            }).catch(() => {});
          }
        }
      }).catch(() => {});
    }).catch(() => {});
  }

  // Navigation supports "page" or "page:subtab" e.g. "settings:export"
  // Also supports "registry:expand:<toolId>" to open Registry and expand a tool.
  function handleNavigate(target) {
    const parts = (target || "").split(":");
    const page  = parts[0];
    if (page === "settings") {
      setSettingsTab(parts[1] || "general");
    }
    if (page === "registry" && parts[1] === "expand") {
      setRegistryExpandId(parts[2] || null);
    } else if (page !== "registry") {
      setRegistryExpandId(null);
    }
    setActiveCategory(page);
  }

  function renderMain() {
    switch (activeCategory) {
      case "topology":  return <NetworkTopology />;
      case "preflight": return <PreflightPage />;
      case "vault":     return <VaultPage />;
      case "snapshot":  return <SnapshotPage />;
      case "audit":     return <AuditPage />;
      case "usertools": return <UserToolsPage categories={categories} onToolSaved={onToolSaved} />;
      case "registry":  return <RealRegistryPage categories={categories} registry={registry} expandToolId={registryExpandId} onExpanded={() => setRegistryExpandId(null)} />;
      case "settings":  return <SettingsPage initialTab={settingsTab} />;
      default:
        return (
          <Dashboard
            activeCategory={activeCategory}
            onCategoryChange={handleNavigate}
            categories={categories}
          />
        );
    }
  }

  const isRegistry = activeCategory === "registry";

  return (
    <NavigationProvider onNavigate={handleNavigate}>
      <DeployProvider>
      <div className="app-shell">
        <Sidebar
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={handleNavigate}
          toolCounts={toolCounts}
          onAddCategory={handleAddCategory}
          onEditCategory={handleEditCategory}
        />
        <main style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}>
          {renderMain()}
        </main>
      </div>

      {categoryModal && (
        <CategoryModal
          existing={categoryModal.mode === "edit" ? categoryModal.cat : null}
          onConfirm={handleCategoryModalConfirm}
          onDelete={handleDeleteCategory}
          onClose={() => setCategoryModal(null)}
        />
      )}
      </DeployProvider>
    </NavigationProvider>
  );
}

// Root — loads registry then mounts provider + inner app
export default function App() {
  const [registryTrigger, setRegistryTrigger] = useState(0);
  const { registry, error: registryError } = useRegistry(registryTrigger);

  function handleToolSaved() {
    setRegistryTrigger(t => t + 1);
  }

  // Re-read tools.json whenever a deploy completes — picks up any
  // entrypoint / port / health_check edits the user made before redeploying.
  useEffect(() => {
    const handler = () => setRegistryTrigger(t => t + 1);
    window.addEventListener("athena:registry-reload", handler);
    return () => window.removeEventListener("athena:registry-reload", handler);
  }, []);

  return (
    <ContainerProvider registry={registry}>
      {registryError && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          background: "rgba(255,45,85,0.15)", borderBottom: "1px solid rgba(255,45,85,0.4)",
          color: "#ff6b8a", fontFamily: "var(--font-mono)", fontSize: "11px",
          padding: "8px 16px", display: "flex", alignItems: "center", gap: "10px",
        }}>
          <span style={{ color: "#ff2d55", fontWeight: 700 }}>⚠ REGISTRY ERROR</span>
          <span style={{ flex: 1 }}>{registryError}</span>
          <span style={{ opacity: 0.6 }}>Fix the file and restart the app</span>
        </div>
      )}
      <AppInner registry={registry} onToolSaved={handleToolSaved} />
    </ContainerProvider>
  );
}
