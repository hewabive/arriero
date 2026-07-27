function deriveBasePath(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname
    .replace(/\/index\.html$/, "")
    .replace(/\/+$/, "");
}

export const apiBase = deriveBasePath();

export function absoluteUrl(path: string): string {
  return `${window.location.origin}${apiBase}${path}`;
}

export function nodeScopedPath(
  nodeId: string | undefined,
  path: string,
): string {
  if (!nodeId || nodeId === "self") {
    return path;
  }
  return `/api/nodes/${nodeId}${path.replace(/^\/api/, "")}`;
}

export const SELF_NODE_ID = "self";
const ACTIVE_NODE_STORAGE_KEY = "arriero-active-node";

function readStoredActiveNode(): string {
  if (typeof window === "undefined") return SELF_NODE_ID;
  return window.localStorage.getItem(ACTIVE_NODE_STORAGE_KEY) ?? SELF_NODE_ID;
}

let activeNodeId = readStoredActiveNode();

export function getActiveNodeId(): string {
  return activeNodeId;
}

export function setActiveNodeId(nodeId: string): void {
  activeNodeId = nodeId || SELF_NODE_ID;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ACTIVE_NODE_STORAGE_KEY, activeNodeId);
  }
}

export function activeNodeScopedPath(path: string): string {
  return nodeScopedPath(activeNodeId, path);
}
