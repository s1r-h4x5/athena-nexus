// ═══════════════════════════════════════════════════════════
// lib/container.js — Frontend bridge to Tauri container runtime commands
//
// IS_TAURI = true  → calls real Tauri commands via invoke()
// IS_TAURI = false → returns mock data for browser dev
// ═══════════════════════════════════════════════════════════

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

async function invoke(cmd, args = {}) {
  if (IS_TAURI) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke(cmd, args);
  }
  return mockInvoke(cmd, args);
}

// ── Mock data for browser dev ────────────────────────────── //

let _mockTick = 0;
function mockContainers() {
  _mockTick++;
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      Id: "aaa111", Names: ["/openvas"],    Image: "greenbone/community-edition:latest",
      State: "running", Status: "Up 3 days (healthy)",
      StartedAt: now - 3 * 86400, Ports: [{ PublicPort: 9392, PrivatePort: 9392, Type: "tcp" }],
    },
    {
      Id: "bbb222", Names: ["/wazuh-manager-1"], Image: "wazuh/wazuh-manager:4.7.0",
      State: "running", Status: "Up 1 day (healthy)",
      StartedAt: now - 86400, Ports: [{ PublicPort: 443, PrivatePort: 443, Type: "tcp" }],
    },
    {
      Id: "ccc333", Names: ["/wazuh-indexer-1"], Image: "wazuh/wazuh-indexer:4.7.0",
      State: "running", Status: "Up 1 day (healthy)",
      StartedAt: now - 86400, Ports: [],
    },
    {
      Id: "ddd444", Names: ["/cyberchef"], Image: "mpepping/cyberchef:latest",
      State: "running", Status: "Up 7 days (healthy)",
      StartedAt: now - 7 * 86400, Ports: [{ PublicPort: 8080, PrivatePort: 8080, Type: "tcp" }],
    },
    {
      Id: "eee555", Names: ["/misp"], Image: "coolacid/misp-docker:latest",
      State: "exited",  Status: "Exited (1) 2 hours ago",
      StartedAt: 0, Ports: [],
    },
    {
      Id: "fff666", Names: ["/portainer"], Image: "portainer/portainer-ce:latest",
      State: "running", Status: "Up 2 days (healthy)",
      StartedAt: now - 2 * 86400, Ports: [{ PublicPort: 9443, PrivatePort: 9443, Type: "tcp" }],
    },
  ];
}

function mockStats(containerId) {
  const base = { aaa111: 12, bbb222: 8, ccc333: 4, ddd444: 0.2, fff666: 1.5 };
  const mem  = { aaa111: 1024*1024*1024, bbb222: 2048*1024*1024, ccc333: 512*1024*1024, ddd444: 64*1024*1024, fff666: 128*1024*1024 };
  const cpu  = (base[containerId] || 0) + (Math.random() * 2 - 1);
  const usage = mem[containerId] || 0;
  return {
    cpu_stats:    { cpu_usage: { total_usage: cpu * 1e9 }, system_cpu_usage: 1e12, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: (cpu - 1) * 1e9 }, system_cpu_usage: 1e12 - 1e9 },
    memory_stats: { usage, limit: 16 * 1024 * 1024 * 1024 },
  };
}

function mockInvoke(cmd, args) {
  switch (cmd) {
    case "check_connection":
      return Promise.resolve({
        success: true,
        message: "Connected (mock)",
        data: {
          version: { Version: "4.9.0-mock" },
          host: { remoteSocket: { path: "/run/user/1000/podman/podman.sock" } },
        },
      });

    case "get_runtime_info":
      return Promise.resolve({
        version: { Version: "4.9.0-mock" },
        host: {
          os: "linux",
          arch: "amd64",
          rootless: true,
          remoteSocket: { path: "/run/user/1000/podman/podman.sock" },
        },
        store: { configFile: "/home/user/.config/containers/storage.conf" },
      });

    case "list_containers":
      return Promise.resolve(mockContainers());

    case "get_container_stats":
      return new Promise(res =>
        setTimeout(() => res(mockStats(args.containerId)), 100)
      );

    case "get_container_logs":
      return Promise.resolve(
        Array.from({ length: 80 }, (_, i) => {
          const ts = new Date(Date.now() - (80 - i) * 2500).toISOString();
          const pool = [
            ["INFO",  "Service started successfully on port 9392"],
            ["INFO",  "Listening on 0.0.0.0:9392 (TLS 1.3)"],
            ["INFO",  "Health check passed — 200 OK /health"],
            ["INFO",  "Connection accepted from 192.168.1.100:52311"],
            ["INFO",  "Database sync complete — 1,247 records updated"],
            ["INFO",  "Feed update complete: NVT 2024-03-05 (14,382 checks)"],
            ["INFO",  "Scheduled scan enqueued: full-network-sweep"],
            ["INFO",  "TLS handshake completed in 42ms"],
            ["DEBUG", "Allocating worker pool: 4 threads"],
            ["DEBUG", "Cache hit ratio: 0.94 (last 1000 requests)"],
            ["DEBUG", "Heartbeat sent to manager node"],
            ["DEBUG", "gRPC stream opened: scan_id=48a1f2c"],
            ["DEBUG", "Config reloaded — no changes detected"],
            ["WARN",  "Rate limit approaching: 980/1000 rps"],
            ["WARN",  "Slow query detected: 3.2s on nvt_metadata table"],
            ["WARN",  "Certificate expires in 14 days — schedule renewal"],
            ["WARN",  "Memory usage at 78% — consider increasing limit"],
            ["ERROR", "Failed to reach feed server: connection timeout (30s)"],
            ["ERROR", "Scan aborted: target 10.0.0.50 unreachable (ICMP filtered)"],
          ];
          const [level, msg] = pool[i % pool.length];
          return `${ts} [${level}] ${msg}`;
        }).join("\n")
      );

    case "start_container":
    case "stop_container":
    case "restart_container":
      return new Promise(res =>
        setTimeout(() => res({ success: true, message: `${cmd} ok (mock)` }), 800)
      );

    case "pull_image":
      return new Promise(res =>
        setTimeout(() => res({ success: true, message: "Pull complete (mock)" }), 2500)
      );

    case "list_networks":
      return Promise.resolve([
        { Id: "net0", Name: "podman",        Driver: "bridge", Subnets: [{ Subnet: "10.88.0.0/16"      }] },
        { Id: "net1", Name: "athena-mgmt",   Driver: "bridge", Subnets: [{ Subnet: "172.20.0.0/24"     }] },
        { Id: "net2", Name: "isolated-scan", Driver: "bridge", Subnets: [{ Subnet: "192.168.100.0/24"  }] },
      ]);

    case "load_registry":
      return Promise.resolve([]);

    case "registry_file_path":
      return Promise.resolve("~/.config/athena-nexus/tools.json");

    case "check_health":
      return Promise.resolve(
        args.cliTool
          ? { status: "ready",   detail: null }
          : { status: "healthy", detail: "HTTP 200" }
      );

    case "set_registry_path":
      return Promise.resolve(args.path || "~/.config/athena-nexus/tools.json");

    case "check_data_dir_writable":
      return Promise.resolve(true);

    case "get_disk_free_mb":
      return Promise.resolve(8192);

    default:
      return Promise.resolve(null);
  }
}

// ── Public API ───────────────────────────────────────────── //

export const runtime = {
  checkConnection: ()             => invoke("check_connection"),
  getInfo:         ()             => invoke("get_runtime_info"),
  inspectNetwork:  (networkName) => invoke("inspect_network", { networkName }),
  listContainers:  (all = true)   => invoke("list_containers", { all }),
  start:           (id)           => invoke("start_container",   { containerId: id }),
  stop:            (id, timeout)  => invoke("stop_container",    { containerId: id, timeout }),
  restart:         (id)           => invoke("restart_container", { containerId: id }),
  remove:          (id, force)    => invoke("remove_container",  { containerId: id, force }),
  getStats:        (id)           => invoke("get_container_stats", { containerId: id }),
  getLogs:         (id, tail=100, since=0) => invoke("get_container_logs", { containerId: id, tail, since }),
  pullImage:       (image)        => invoke("pull_image",   { image }),
  listImages:      ()             => invoke("list_images"),
  listNetworks:    ()             => invoke("list_networks"),
  createNetwork:   (name, opts={}) => invoke("create_network", { name, ...opts }),
};

export const config = {
  load: ()    => invoke("load_config"),
  save: (cfg) => invoke("save_config", { config: cfg }),
};

export const registry = {
  load: () => invoke("load_registry"),
};

export { IS_TAURI };
