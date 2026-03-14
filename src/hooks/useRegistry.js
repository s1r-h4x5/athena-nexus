// ═══════════════════════════════════════════════════════════
// hooks/useRegistry.js
//
// Loads the tool registry from ~/.config/athena-nexus/tools.json
// via the Tauri backend. Always reads from disk — no hardcoded
// fallback that can go stale.
// ═══════════════════════════════════════════════════════════

import { useEffect, useState } from "react";
import { registry, IS_TAURI } from "../lib/container";

export function useRegistry(reloadTrigger = 0) {
  const [registryEntries, setRegistryEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const load = IS_TAURI
      ? Promise.all([
          registry.load(),
          import("@tauri-apps/api/core")
            .then(({ invoke }) => invoke("user_tools_list"))
            .catch(() => []),
        ])
      : // Browser dev mode: load mock registry from container.js mock handler
        Promise.all([
          registry.load(),   // returns [] from mock
          Promise.resolve([]),
        ]);

    load
      .then(([builtins, userTools]) => {
        const entries = [...(builtins || [])];
        for (const t of (userTools || [])) {
          if (!entries.find(e => e.id === t.id)) {
            entries.push({
              id:           t.id,
              name:         t.name,
              category:     t.category || (t.categories?.[0] ?? "utilities"),
              categories:   t.categories || (t.category ? [t.category] : ["utilities"]),
              description:  t.description,
              registry:     t.registry     || "docker.io",
              image:        t.image        || null,
              version:      t.version      || "latest",
              compose_url:  null,
              compose_file: t.compose_file || null,
              entrypoint:   t.entrypoint   || null,
              health_check: t.health_check || null,
              ports:        t.ports        || [],
              cli_tool:     t.cli_tool     || false,
              icon:         null,
              tags:         ["user-defined"],
              user_defined: true,
            });
          }
        }
        setRegistryEntries(entries);
      })
      .catch(err => {
        console.error("Registry load failed:", err);
        setError(err?.message || String(err));
      })
      .finally(() => setLoading(false));
  }, [reloadTrigger]);

  return { registry: registryEntries, loading, error };
}
