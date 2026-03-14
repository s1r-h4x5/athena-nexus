// lib/imageUtils.js — helpers for assembling container image refs.

const DEFAULT_REGISTRY = "docker.io";

/**
 * Build the full pull reference from a tool object.
 * Works with both new nested format (tool.source.image) and
 * flat legacy format (tool.image) for user-defined tools.
 */
export function fullImage(tool) {
  if (!tool) return "";
  // New nested format
  const src = tool.source;
  if (src?.image) {
    const registry = src.registry || DEFAULT_REGISTRY;
    const version  = src.version  || "latest";
    return `${registry}/${src.image}:${version}`;
  }
  // Legacy flat format (user-defined tools)
  if (tool.image) {
    const registry = tool.registry || DEFAULT_REGISTRY;
    const version  = tool.version  || "latest";
    return `${registry}/${tool.image}:${version}`;
  }
  return "";
}

/**
 * Short display name shown on the card (no registry prefix).
 * e.g. "projectdiscovery/nuclei:latest"
 */
export function displayImage(tool) {
  if (!tool) return "";
  const src = tool.source;
  if (src?.image) return `${src.image}:${src.version || "latest"}`;
  if (tool.image)  return `${tool.image}:${tool.version || "latest"}`;
  return "";
}
