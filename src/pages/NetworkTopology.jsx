// ═══════════════════════════════════════════════════════════
// pages/NetworkTopology.jsx — M6: Network Topology
//
// D3 force-directed graph showing:
//   - Podman networks (hub nodes)
//   - Tools/containers attached to each network (tool nodes)
//   - Port mappings on running tools (port nodes)
//
// Data sources:
//   - podman.listNetworks() → network nodes
//   - PodmanContext tools   → container nodes + edges
//   - tool.ports            → port leaf nodes
// ═══════════════════════════════════════════════════════════

import React, {
  useEffect, useRef, useState, useCallback, useMemo,
} from "react";
import * as d3 from "d3";
import {
  RefreshCw, ZoomIn, ZoomOut, Maximize2, Info,
  Circle, Layers, Network, Globe, Download,
} from "lucide-react";
import TopBar from "../components/TopBar";
import { useContainer } from "../context/ContainerContext";
import { runtime, IS_TAURI } from "../lib/container";
import "./NetworkTopology.css";

// ── Mock network data for browser dev ─────────────────────── //
const MOCK_NETWORKS = [
  { id: "net-podman",    name: "podman",        driver: "bridge", subnet: "10.88.0.0/16" },
  { id: "net-athena",    name: "athena-mgmt",   driver: "bridge", subnet: "172.20.0.0/24" },
  { id: "net-isolated",  name: "isolated-scan", driver: "bridge", subnet: "192.168.100.0/24" },
];

// ── Colour palette ────────────────────────────────────────── //
const COLORS = {
  network:   { fill: "rgba(0,229,255,0.15)",   stroke: "#00e5ff",  text: "#00e5ff"  },
  running:   { fill: "rgba(57,255,20,0.12)",   stroke: "#39ff14",  text: "#39ff14"  },
  stopped:   { fill: "rgba(100,116,139,0.1)",  stroke: "#64748b",  text: "#64748b"  },
  error:     { fill: "rgba(255,45,85,0.12)",   stroke: "#ff2d55",  text: "#ff2d55"  },
  port:      { fill: "rgba(245,158,11,0.1)",   stroke: "#f59e0b",  text: "#f59e0b"  },
  host:      { fill: "rgba(139,154,176,0.1)",  stroke: "#8b9ab0",  text: "#8b9ab0"  },
  compose:   { fill: "rgba(139,92,246,0.18)",  stroke: "#8b5cf6",  text: "#8b5cf6"  },
};

// ── Map tool status → colour key ──────────────────────────── //
function statusColor(status) {
  if (status === "running")  return "running";
  if (status === "error")    return "error";
  return "stopped";
}

// ── Human-readable descriptions for Docker's built-in networks ── //
const NETWORK_DESCRIPTIONS = {
  // Docker default names
  bridge: "Default isolated network. Containers communicate with each other; reach the host via mapped ports.",
  host:   "Shares the host machine's network stack directly. No isolation — the container uses the host's IP and ports.",
  none:   "No network access. The container is fully isolated with no external connectivity.",
  // Podman default names
  podman: "Default Podman bridge network. Containers can reach each other and the internet via NAT.",
  pasta:  "Podman's userspace networking (pasta). Provides internet access without root privileges.",
  slirp4netns: "Podman rootless networking via slirp4netns. NAT-based, no direct container-to-container access.",
};

// Friendly display names — keyed by network name or driver
const FRIENDLY_BY_NAME = {
  bridge:      "Default Bridge",
  host:        "Host Network",
  none:        "No Network (isolated)",
  podman:      "Podman Default Bridge",
  pasta:       "Pasta (rootless)",
  slirp4netns: "Slirp4netns (rootless)",
};
const FRIENDLY_BY_DRIVER = {
  bridge:  "Bridge Network",
  macvlan: "MacVLAN Network",
  ipvlan:  "IPvlan Network",
  overlay: "Overlay Network",
};

// ── Build graph nodes + links from live data ──────────────── //
function buildGraph(networks, tools) {
  const nodes = [];
  const links = [];

  // Host node (centre)
  nodes.push({ id: "__host__", type: "host", label: "HOST", r: 22 });

  // Network nodes — build name→id lookup for tool assignment
  const netByName = {};
  for (const net of networks) {
    netByName[net.name] = net.id;
    nodes.push({
      id:          net.id,
      type:        "network",
      label:       net.name,
      sub:         net.friendly || net.subnet || net.driver,
      driver:      net.driver,
      description: NETWORK_DESCRIPTIONS[net.name] || null,
      r:           18,
    });
    links.push({ source: "__host__", target: net.id, kind: "network" });
  }

  // Tool nodes — place each tool on its actual network using networkMode
  // captured from Docker/Podman API (HostConfig.NetworkMode / NetworkSettings.Networks)
  tools.forEach((tool) => {
    // Docker default = "bridge", Podman default = "podman" — try both fallbacks.
    const mode  = tool.networkMode || "";
    const netId = netByName[mode] || netByName["bridge"] || netByName["podman"] || networks[0]?.id || "__host__";

    const isCompose = tool.compose && tool.containers?.length > 1;

    nodes.push({
      id:      `tool-${tool.id}`,
      type:    "tool",
      label:   tool.name,
      status:  tool.status,
      compose: tool.compose,
      r:       isCompose ? 17 : 15,
    });
    links.push({ source: netId, target: `tool-${tool.id}`, kind: "container" });

    if (isCompose) {
      // Compose tool: show each sub-container as a child node
      tool.containers.forEach((ct) => {
        // Shorten name: strip compose project prefix (e.g. "single-node-wazuh-manager-1" → "wazuh-manager")
        const shortName = ct.name
          .replace(/^[a-z0-9_-]+-(\w)/, "$1") // strip leading project prefix
          .replace(/-\d+$/, "")                // strip trailing -1, -2 etc.
          .replace(/^\//, "");                 // strip leading slash
        const ctId = `ct-${tool.id}-${ct.id.slice(0, 8)}`;
        nodes.push({
          id:       ctId,
          type:     "container",
          label:    shortName || ct.name.replace(/^\//, ""),
          fullName: ct.name.replace(/^\//, ""),
          status:   ct.status,
          ports:    ct.ports || [],
          ip:       ct.ip || "",
          r:        10,
        });
        links.push({ source: `tool-${tool.id}`, target: ctId, kind: "subcontainer" });

        // Port leaf nodes off each sub-container (max 3, deduplicated)
        if (ct.status === "running" && ct.ports?.length) {
          const seen = new Set();
          let count = 0;
          for (const port of ct.ports) {
            const portStr = String(port);
            if (seen.has(portStr)) continue;
            seen.add(portStr);
            const portId = `port-${ctId}-${portStr}`;
            nodes.push({ id: portId, type: "port", label: portStr, r: 8 });
            links.push({ source: ctId, target: portId, kind: "port" });
            if (++count >= 3) break;
          }
        }
      });
    } else {
      // Single-container tool: show port leaf nodes
      if (tool.status === "running" && tool.ports?.length) {
        const seen = new Set();
        let portCount = 0;
        for (const port of tool.ports) {
          const portStr = String(port);
          if (seen.has(portStr)) continue;
          seen.add(portStr);
          const portId = `port-${tool.id}-${portStr}`;
          nodes.push({ id: portId, type: "port", label: portStr, r: 9 });
          links.push({ source: `tool-${tool.id}`, target: portId, kind: "port" });
          if (++portCount >= 4) break;
        }
      }
    }
  });

  return { nodes, links };
}

// ── Legend item ───────────────────────────────────────────── //
function LegendItem({ color, label }) {
  return (
    <div className="nt-legend__item">
      <span className="nt-legend__dot" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      <span className="nt-legend__label">{label}</span>
    </div>
  );
}

// ── Module-level cache — survives navigation (component unmount/remount) ── //
let _cachedNetworks = [];
let _cachedHostInfo = null;

// ── Main component ────────────────────────────────────────── //
export default function NetworkTopology() {
  const { tools, manualRefresh } = useContainer();

  const svgRef       = useRef(null);
  const simRef       = useRef(null);
  const zoomRef      = useRef(null);

  const [networks,  setNetworks]  = useState(_cachedNetworks);
  const [loading,   setLoading]   = useState(_cachedNetworks.length === 0);
  const [selected,  setSelected]  = useState(null); // clicked node info
  const [nodeCount, setNodeCount] = useState(0);
  const [hostInfo,  setHostInfo]  = useState(_cachedHostInfo);

  // Stable topology key — only changes when container set or network set changes,
  // NOT when CPU/mem stats update. This prevents the D3 simulation from rebuilding
  // on every poll cycle.
  const topoKey = useMemo(() => {
    const tIds = tools.map(t => `${t.id}:${t.status}:${(t.networks||[]).join(",")}`).sort().join("|");
    const nIds = networks.map(n => n.id).sort().join("|");
    return `${tIds}__${nIds}`;
  }, [tools, networks]);

  // ── Fetch networks ───────────────────────────────────────── //
  const fetchNetworks = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      let raw;
      if (IS_TAURI) {
        raw = await runtime.listNetworks();
      } else {
        raw = MOCK_NETWORKS;
      }

      // First pass: normalise without inspect (fast) → unblock the graph render
      const normalised = raw.map((n, i) => {
        const name   = n.Name || n.name || `network-${i}`;
        const driver = n.Driver || n.driver || "";
        const subnet  = n.Subnets?.[0]?.Subnet  || n.IPAM?.Config?.[0]?.Subnet  || n.subnet  || "";
        const gateway = n.Subnets?.[0]?.Gateway || n.IPAM?.Config?.[0]?.Gateway || n.gateway || "";
        const cleanDriver = (!driver || driver === "null") ? (name === "none" ? "isolated" : "bridge") : driver;
        const friendly = FRIENDLY_BY_NAME[name] || FRIENDLY_BY_DRIVER[cleanDriver] || name;
        return {
          id:       n.Id  || n.id  || `net-${i}`,
          name, driver: cleanDriver, subnet, gateway, hostIp: "", friendly,
        };
      });

      setNetworks(normalised);
      _cachedNetworks = normalised;
      setLoading(false); // ← unblock immediately, before slow inspectNetwork calls

      // Fetch host info in background
      if (IS_TAURI) {
        try {
          const info = await runtime.getInfo();
          const hi = {
            hostname: info?.Name         || info?.host?.hostname || "",
            os:       info?.OperatingSystem || info?.OSType      || info?.host?.os || "",
            arch:     info?.Architecture || info?.host?.arch     || "",
            cpus:     info?.NCPU         || info?.host?.cpus     || "",
            ram:      (info?.MemTotal    || info?.host?.memTotal)
                        ? `${((info?.MemTotal || info?.host?.memTotal) / 1073741824).toFixed(1)} GB`
                        : "",
          };
          setHostInfo(hi);
          _cachedHostInfo = hi;
        } catch (_) {}
      }

      // Second pass: enrich with inspect data (slow, non-blocking)
      if (IS_TAURI) {
        const enriched = await Promise.all(normalised.map(async (net) => {
          try {
            const detail = await runtime.inspectNetwork(net.name);
            const containers = detail?.Containers || {};
            const firstCt = Object.values(containers)[0];
            const hostIp = net.name === "host"
              ? (firstCt?.IPv4Address?.split("/")?.[0] || "")
              : "";
            const subnet = net.subnet || detail?.IPAM?.Config?.[0]?.Subnet || detail?.Subnets?.[0]?.Subnet || "";
            const gateway = net.gateway || detail?.IPAM?.Config?.[0]?.Gateway || detail?.Subnets?.[0]?.Gateway || "";
            return { ...net, hostIp, subnet, gateway };
          } catch (_) {
            return net; // failed inspect — keep what we have
          }
        }));
        setNetworks(enriched);
        _cachedNetworks = enriched;
      }

    } catch (err) {
      console.error("Failed to fetch networks:", err);
      setNetworks(MOCK_NETWORKS);
      _cachedNetworks = MOCK_NETWORKS;
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Skip refetch on remount if we already have cached network data.
    // fetchNetworks is only called on first mount or when user hits Refresh.
    if (_cachedNetworks.length > 0) return;
    fetchNetworks();
  }, [fetchNetworks]);

  // ── Build graph data ─────────────────────────────────────── //
  const graphData = useMemo(() => {
    if (!tools.length) return { nodes: [], links: [] };
    return buildGraph(networks, tools);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey]); // only rebuild when topology structure changes, not stats

  useEffect(() => {
    setNodeCount(graphData.nodes.length);
  }, [graphData]);

  // ── D3 simulation ────────────────────────────────────────── //
  useEffect(() => {
    if (!svgRef.current || !graphData.nodes.length) return;

    const svgEl = svgRef.current;
    const { width, height } = svgEl.getBoundingClientRect();
    const W = width  || 800;
    const H = height || 560;

    // Clear previous render
    d3.select(svgEl).selectAll("*").remove();

    const svg = d3.select(svgEl);

    // ── Zoom layer ───────────────────────────────────────── //
    const g = svg.append("g").attr("class", "nt-zoom-layer");

    const zoom = d3.zoom()
      .scaleExtent([0.25, 3])
      .on("zoom", (event) => g.attr("transform", event.transform));

    svg.call(zoom);
    zoomRef.current = zoom;

    // Initial transform — centred
    svg.call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2));

    // ── Defs: arrowhead marker ───────────────────────────── //
    svg.append("defs").append("marker")
      .attr("id", "arrowhead")
      .attr("viewBox", "0 -4 8 8")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L8,0L0,4")
      .attr("fill", "rgba(0,229,255,0.35)");

    // ── Clone node/link data (D3 mutates positions) ──────── //
    const nodes = graphData.nodes.map(d => ({ ...d }));
    const links = graphData.links.map(d => ({ ...d }));

    // ── Force simulation ─────────────────────────────────── //
    const sim = d3.forceSimulation(nodes)
      .force("link",   d3.forceLink(links).id(d => d.id).distance(d => {
        if (d.kind === "network")      return 110;
        if (d.kind === "container")    return 90;
        if (d.kind === "subcontainer") return 48;
        return 50;
      }).strength(d => d.kind === "subcontainer" ? 0.9 : 0.6))
      .force("charge", d3.forceManyBody().strength(d => {
        if (d.type === "host")      return -600;
        if (d.type === "network")   return -350;
        if (d.type === "tool")      return -200;
        if (d.type === "container") return -60;
        return -80;
      }))
      .force("collision", d3.forceCollide().radius(d => d.r + 12))
      .force("center",    d3.forceCenter(0, 0));

    simRef.current = sim;

    // ── Links ────────────────────────────────────────────── //
    const linkSel = g.append("g").attr("class", "nt-links")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", d => `nt-link nt-link--${d.kind}`)
      .attr("marker-end", d => d.kind !== "port" ? "url(#arrowhead)" : null);

    // ── Nodes ────────────────────────────────────────────── //
    const nodeSel = g.append("g").attr("class", "nt-nodes")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", d => `nt-node nt-node--${d.type}`)
      .call(
        d3.drag()
          .on("start", (event, d) => {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on("end",  (event, d) => {
            if (!event.active) sim.alphaTarget(0);
            // Keep fx/fy — nodes stay where user placed them
          })
      )
      .on("click", (event, d) => {
        event.stopPropagation();
        setSelected(d);
      });

    // Click on SVG background → deselect
    svg.on("click", () => setSelected(null));

    // Outer glow ring for network nodes
    nodeSel.filter(d => d.type === "network")
      .append("circle")
      .attr("r", d => d.r + 8)
      .attr("class", "nt-node__glow");

    // Main circle
    nodeSel.append("circle")
      .attr("r", d => d.r)
      .attr("class", "nt-node__circle")
      .attr("fill", d => {
        if (d.type === "tool" && d.compose) return COLORS.compose.fill;
        if (d.type === "tool" || d.type === "container") return (COLORS[statusColor(d.status)] || COLORS.stopped).fill;
        return (COLORS[d.type] || COLORS.stopped).fill;
      })
      .attr("stroke", d => {
        if (d.type === "tool" && d.compose) return COLORS.compose.stroke;
        if (d.type === "tool" || d.type === "container") return (COLORS[statusColor(d.status)] || COLORS.stopped).stroke;
        return (COLORS[d.type] || COLORS.stopped).stroke;
      });

    // Icon text inside circle
    nodeSel.append("text")
      .attr("class", "nt-node__icon")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("font-size", d => {
        if (d.type === "host")      return "13px";
        if (d.type === "port")      return "8px";
        if (d.type === "container") return "8px";
        return "10px";
      })
      .text(d => {
        if (d.type === "host")      return "⬡";
        if (d.type === "network")   return "⬡";
        if (d.type === "port")      return d.label;
        if (d.type === "container") return "▪";
        return d.compose ? "⧉" : "▣";
      });

    // Label below node
    nodeSel.filter(d => d.type !== "port")
      .append("text")
      .attr("class", "nt-node__label")
      .attr("text-anchor", "middle")
      .attr("y", d => d.r + 13)
      .attr("font-size", d => {
        if (d.type === "host")      return "11px";
        if (d.type === "container") return "9px";
        return "10px";
      })
      .text(d => d.label.length > 18 ? d.label.slice(0, 16) + "…" : d.label);

    // Sub-label (subnet) for network nodes
    nodeSel.filter(d => d.type === "network" && d.sub)
      .append("text")
      .attr("class", "nt-node__sublabel")
      .attr("text-anchor", "middle")
      .attr("y", d => d.r + 24)
      .attr("font-size", "8.5px")
      .text(d => d.sub);

    // ── Tick ─────────────────────────────────────────────── //
    sim.on("tick", () => {
      linkSel
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);

      nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    return () => sim.stop();
  }, [graphData]);

  // ── Zoom controls ────────────────────────────────────────── //
  function zoomBy(factor) {
    d3.select(svgRef.current)
      .transition().duration(250)
      .call(zoomRef.current.scaleBy, factor);
  }
  function zoomFit() {
    d3.select(svgRef.current)
      .transition().duration(400)
      .call(
        zoomRef.current.transform,
        d3.zoomIdentity.translate(
          svgRef.current.getBoundingClientRect().width  / 2,
          svgRef.current.getBoundingClientRect().height / 2,
        )
      );
  }

  function handleRefresh() {
    fetchNetworks(false); // silent refresh — no loading spinner
    manualRefresh();
  }

  const [exportToast, setExportToast] = useState(null); // { filename }
  const toastTimerRef = useRef(null);

  async function exportPng() {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const { width, height } = svgEl.getBoundingClientRect();
    const serializer = new XMLSerializer();

    // Inline CSS so the exported PNG looks identical to the screen
    const styles = Array.from(document.styleSheets)
      .flatMap(s => { try { return Array.from(s.cssRules); } catch { return []; } })
      .map(r => r.cssText)
      .join("\n");
    const svgClone = svgEl.cloneNode(true);
    const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
    styleEl.textContent = styles;
    svgClone.insertBefore(styleEl, svgClone.firstChild);
    svgClone.setAttribute("width", width);
    svgClone.setAttribute("height", height);
    // Dark background rect
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("width", "100%");
    bg.setAttribute("height", "100%");
    bg.setAttribute("fill", "#0a0e14");
    svgClone.insertBefore(bg, svgClone.firstChild);

    const svgStr = serializer.serializeToString(svgClone);
    const blob   = new Blob([svgStr], { type: "image/svg+xml" });
    const url    = URL.createObjectURL(blob);
    const img    = new Image();
    const defaultName = `athena-topology-${new Date().toISOString().slice(0, 10)}.png`;

    img.onload = async () => {
      const canvas = document.createElement("canvas");
      canvas.width  = width  * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext("2d");
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      if (IS_TAURI) {
        try {
          const { save }      = await import("@tauri-apps/plugin-dialog");
          const { writeFile } = await import("@tauri-apps/plugin-fs");

          const savePath = await save({
            title:       "Save topology as PNG",
            defaultPath: defaultName,
            filters:     [{ name: "PNG Image", extensions: ["png"] }],
          });

          if (!savePath) return; // user cancelled

          // canvas → Uint8Array
          const dataUrl = canvas.toDataURL("image/png");
          const base64  = dataUrl.split(",")[1];
          const bytes   = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          await writeFile(savePath, bytes);

          // Show success toast
          const filename = savePath.split(/[\\/]/).pop();
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          setExportToast({ filename, success: true });
          toastTimerRef.current = setTimeout(() => setExportToast(null), 4000);

        } catch (err) {
          console.error("Export failed:", err);
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          setExportToast({ filename: null, success: false, error: String(err) });
          toastTimerRef.current = setTimeout(() => setExportToast(null), 5000);
        }
      } else {
        // Browser fallback — direct download
        const link = document.createElement("a");
        link.download = defaultName;
        link.href = canvas.toDataURL("image/png");
        link.click();
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setExportToast({ filename: defaultName, success: true });
        toastTimerRef.current = setTimeout(() => setExportToast(null), 4000);
      }
    };
    img.src = url;
  }

  // ── Selected node detail panel ───────────────────────────── //
  function renderDetail() {
    if (!selected) return null;
    const tool = selected.type === "tool"
      ? tools.find(t => `tool-${t.id}` === selected.id)
      : null;
    const net = selected.type === "network"
      ? networks.find(n => n.id === selected.id)
      : null;
    // For container sub-nodes: data is on the D3 node itself (selected)
    const isCt = selected.type === "container";

    return (
      <div className="nt-detail">
        <div className="nt-detail__type">{selected.type.toUpperCase()}</div>
        <div className="nt-detail__name">{net ? (net.friendly || net.name) : selected.label}</div>

        {/* ── Network node ── */}
        {net && (
          <>
            <div className="nt-detail__row"><span>Internal name</span><span>{net.name}</span></div>
            <div className="nt-detail__row"><span>Driver</span><span>{net.driver}</span></div>
            {net.subnet  && <div className="nt-detail__row"><span>Subnet</span><span>{net.subnet}</span></div>}
            {net.gateway && <div className="nt-detail__row"><span>Gateway IP</span><span>{net.gateway}</span></div>}
            {net.hostIp  && <div className="nt-detail__row"><span>Host IP</span><span>{net.hostIp}</span></div>}
            {NETWORK_DESCRIPTIONS[net.name] && (
              <div className="nt-detail__description">{NETWORK_DESCRIPTIONS[net.name]}</div>
            )}
          </>
        )}

        {/* ── Tool (compose or single) node ── */}
        {tool && (
          <>
            <div className="nt-detail__row">
              <span>Status</span>
              <span className={`nt-detail__status nt-detail__status--${tool.status}`}>
                {tool.status.toUpperCase()}
              </span>
            </div>
            {tool.status === "running" && (
              <>
                {tool.containerIp && <div className="nt-detail__row"><span>Container IP</span><span>{tool.containerIp}</span></div>}
                <div className="nt-detail__row"><span>CPU</span><span>{tool.cpu?.toFixed(1)}%</span></div>
                <div className="nt-detail__row"><span>RAM</span><span>{tool.mem >= 1024 ? `${(tool.mem/1024).toFixed(1)} GB` : `${tool.mem} MB`}</span></div>
                <div className="nt-detail__row"><span>Uptime</span><span>{tool.uptime || "—"}</span></div>
              </>
            )}
            {/* Ports: only show on single-container tools; compose tools show ports on sub-container nodes */}
            {!tool.compose && tool.ports?.length > 0 && (
              <div className="nt-detail__row nt-detail__row--ports">
                <span>Ports</span>
                <span className="nt-detail__ports">
                  {tool.ports.map(p => (
                    <span key={p} className="nt-detail__port-tag">{p}</span>
                  ))}
                </span>
              </div>
            )}
            {tool.compose && tool.containers?.length > 0 && (
              <div className="nt-detail__row">
                <span>Containers</span>
                <span>{tool.containers.length}</span>
              </div>
            )}
            {tool.entrypoint && (
              <div className="nt-detail__row">
                <span>Entry</span>
                <a href={tool.entrypoint} target="_blank" rel="noopener noreferrer">
                  {tool.entrypoint}
                </a>
              </div>
            )}
          </>
        )}

        {/* ── Sub-container node ── */}
        {isCt && (
          <>
            <div className="nt-detail__row">
              <span>Status</span>
              <span className={`nt-detail__status nt-detail__status--${selected.status}`}>
                {(selected.status || "unknown").toUpperCase()}
              </span>
            </div>
            {selected.fullName && (
              <div className="nt-detail__row"><span>Full name</span><span>{selected.fullName}</span></div>
            )}
            {selected.ip && (
              <div className="nt-detail__row"><span>IP Address</span><span>{selected.ip}</span></div>
            )}
            {selected.ports?.length > 0 ? (
              <div className="nt-detail__row nt-detail__row--ports">
                <span>Ports</span>
                <span className="nt-detail__ports">
                  {[...new Set(selected.ports)].map(p => (
                    <span key={p} className="nt-detail__port-tag">{p}</span>
                  ))}
                </span>
              </div>
            ) : (
              <div className="nt-detail__row"><span>Ports</span><span style={{opacity:0.4}}>none exposed</span></div>
            )}
          </>
        )}

        {/* ── Host node ── */}
        {selected.type === "host" && (
          <>
            <div className="nt-detail__row"><span>Networks</span><span>{networks.length}</span></div>
            <div className="nt-detail__row"><span>Containers</span><span>{tools.filter(t => t.status === "running").length} running / {tools.length} total</span></div>
            {hostInfo?.hostname && <div className="nt-detail__row"><span>Hostname</span><span>{hostInfo.hostname}</span></div>}
            {hostInfo?.os       && <div className="nt-detail__row"><span>OS</span><span>{hostInfo.os}</span></div>}
            {hostInfo?.arch     && <div className="nt-detail__row"><span>Arch</span><span>{hostInfo.arch}</span></div>}
            {hostInfo?.cpus     && <div className="nt-detail__row"><span>CPUs</span><span>{hostInfo.cpus}</span></div>}
            {hostInfo?.ram      && <div className="nt-detail__row"><span>RAM</span><span>{hostInfo.ram}</span></div>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="nt-page">
      <TopBar
        title="Network Topology"
        titleIcon="Network"
        onRefresh={handleRefresh}
      />

      <div className="nt-body">
        {/* ── Canvas ────────────────────────────────────────── */}
        <div className="nt-canvas">
          {loading && (
            <div className="nt-loading">
              <RefreshCw size={22} className="nt-loading__icon" />
              <span>Building topology…</span>
            </div>
          )}

          <svg ref={svgRef} className="nt-svg" />

          {/* Zoom controls */}
          <div className="nt-zoom-controls">
            <button className="nt-zoom-btn" onClick={() => zoomBy(1.3)} title="Zoom in">
              <ZoomIn size={14} />
            </button>
            <button className="nt-zoom-btn" onClick={() => zoomBy(0.77)} title="Zoom out">
              <ZoomOut size={14} />
            </button>
            <button className="nt-zoom-btn" onClick={zoomFit} title="Fit to view">
              <Maximize2 size={13} />
            </button>
            <button className="nt-zoom-btn" onClick={exportPng} title="Export as PNG">
              <Download size={13} />
            </button>
          </div>

          {/* Stats badge */}
          <div className="nt-stats">
            <span>{networks.length} network{networks.length !== 1 ? "s" : ""}</span>
            <span className="nt-stats__sep">·</span>
            <span>{tools.length} tool{tools.length !== 1 ? "s" : ""}</span>
            <span className="nt-stats__sep">·</span>
            <span>{nodeCount} nodes</span>
          </div>

          {/* Legend */}
          <div className="nt-legend">
            <LegendItem color="#00e5ff" label="Network"       />
            <LegendItem color="#8b5cf6" label="Compose stack" />
            <LegendItem color="#39ff14" label="Running"       />
            <LegendItem color="#64748b" label="Stopped"       />
            <LegendItem color="#ff2d55" label="Error"         />
            <LegendItem color="#f59e0b" label="Port"          />
          </div>

          {/* Drag hint */}
          <div className="nt-hint">Drag nodes · Scroll to zoom · Click for details</div>

          {/* Export toast */}
          {exportToast && (
            <div className={`nt-export-toast ${exportToast.success === false ? "nt-export-toast--error" : ""}`}>
              <span className="nt-export-toast__icon">{exportToast.success === false ? "✗" : "✓"}</span>
              <div className="nt-export-toast__text">
                {exportToast.success === false ? (
                  <span className="nt-export-toast__title">Export failed</span>
                ) : (
                  <>
                    <span className="nt-export-toast__title">PNG exported</span>
                    <span className="nt-export-toast__file">{exportToast.filename}</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Side panel ────────────────────────────────────── */}
        <div className="nt-sidebar">
          {/* Network list */}
          <div className="nt-sidebar__section">
            <div className="nt-sidebar__heading">
              <Network size={12} /> NETWORKS
            </div>
            {networks.length === 0 ? (
              <p className="nt-sidebar__empty">No networks found.</p>
            ) : networks.map(net => (
              <div key={net.id} className="nt-sidebar__net-item"
                style={{cursor:"pointer"}}
                onClick={() => setSelected({ id: net.id, type: "network", label: net.name })}
              >
                <span className="nt-sidebar__net-dot" />
                <div>
                  <div className="nt-sidebar__net-name">{net.friendly || net.name}</div>
                  <div className="nt-sidebar__net-meta">
                    {net.subnet  && <span><span className="nt-meta-label">subnet</span> {net.subnet}</span>}
                    {net.gateway && <span><span className="nt-meta-label">gw</span> {net.gateway}</span>}
                    {net.hostIp  && <span><span className="nt-meta-label">host ip</span> {net.hostIp}</span>}
                    {!net.subnet && !net.gateway && !net.hostIp && <span className="nt-meta-label">{net.driver}</span>}
                  </div>
                  {NETWORK_DESCRIPTIONS[net.name] && (
                    <div className="nt-sidebar__net-desc">{NETWORK_DESCRIPTIONS[net.name]}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Selected detail */}
          <div className="nt-sidebar__section">
            <div className="nt-sidebar__heading">
              <Info size={12} /> {selected ? "SELECTED NODE" : "NODE DETAIL"}
            </div>
            {selected ? renderDetail() : (
              <p className="nt-sidebar__empty">Click a node in the graph to inspect it.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
