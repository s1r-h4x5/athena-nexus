// ── useCardOrder.js ──────────────────────────────────────────
// Persists a user-defined card ordering per category.
// Storage key: "athena:card-order:<categoryId>"
// Falls back to the natural tool order if no saved order exists.

import { useState, useEffect, useCallback } from "react";
import { IS_TAURI } from "../lib/container";

const STORAGE_PREFIX = "athena:card-order:";

async function loadOrder(categoryId) {
  const key = STORAGE_PREFIX + categoryId;
  if (IS_TAURI) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const val = await invoke("kv_get", { key });
      if (val) return JSON.parse(val);
    } catch (_) {}
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

async function saveOrder(categoryId, ids) {
  const key = STORAGE_PREFIX + categoryId;
  const val = JSON.stringify(ids);
  if (IS_TAURI) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("kv_set", { key, value: val });
    } catch (_) {}
  }
  try { localStorage.setItem(key, val); } catch (_) {}
}

// Apply saved order to tools array — unknown IDs go to end, deleted ones dropped
function applyOrder(tools, savedIds) {
  if (!savedIds) return tools;
  const byId = new Map(tools.map(t => [t.id, t]));
  const ordered = savedIds.map(id => byId.get(id)).filter(Boolean);
  const unordered = tools.filter(t => !savedIds.includes(t.id));
  return [...ordered, ...unordered];
}

export function useCardOrder(categoryId, tools) {
  const [savedIds, setSavedIds] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    loadOrder(categoryId).then(ids => {
      setSavedIds(ids);
      setLoaded(true);
    });
  }, [categoryId]);

  const orderedTools = loaded ? applyOrder(tools, savedIds) : tools;

  const reorder = useCallback((dragIndex, dropIndex) => {
    setSavedIds(prev => {
      // Build current id list from the currently ordered tools
      const currentIds = applyOrder(tools, prev).map(t => t.id);
      const next = [...currentIds];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(dropIndex, 0, moved);
      saveOrder(categoryId, next);
      return next;
    });
  }, [categoryId, tools]);

  return { orderedTools, reorder };
}
