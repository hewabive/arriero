import { useEffect, useState } from "react";

export type AppRoute =
  | "status"
  | "nodes"
  | "update"
  | "config-git"
  | "dashboard"
  | "instances"
  | "diagnostics"
  | "processes"
  | "proxy"
  | "models"
  | "presets"
  | "paths"
  | "args"
  | "build"
  | "environments"
  | "source-sync"
  | "system"
  | "api-lab";

export type NavLeaf = {
  route: AppRoute;
  subpath?: string;
  label: string;
  title: string;
  description?: string;
};

export type NavSection = {
  id: string;
  label?: string;
  items: NavLeaf[];
};

export const navSections: NavSection[] = [
  {
    id: "overview",
    items: [
      {
        route: "status",
        label: "Status",
        title: "Public Status",
        description: "Redacted diagnostics for this llama-manager node",
      },
      {
        route: "nodes",
        label: "Nodes",
        title: "Nodes",
        description: "Register llama-manager nodes to manage from one address",
      },
      {
        route: "update",
        label: "Updates",
        title: "Manager Updates",
        description:
          "Per-node version across the fleet and one-click update to the latest revision",
      },
      {
        route: "config-git",
        label: "Configuration Git",
        title: "Configuration repository",
        description:
          "Clone, review, version and synchronize this node's portable configuration",
      },
    ],
  },
  {
    id: "instances",
    label: "Instances",
    items: [
      {
        route: "dashboard",
        label: "Dashboard",
        title: "Dashboard",
        description: "At-a-glance health of every configured instance",
      },
      {
        route: "instances",
        label: "Instances",
        title: "Instances",
        description: "Process control for local inference instances",
      },
      {
        route: "diagnostics",
        label: "Diagnostics",
        title: "Diagnostics",
        description: "Runtime state, endpoint probes and logs",
      },
      {
        route: "processes",
        label: "Processes",
        title: "Processes",
        description: "Inspect unmanaged llama-server processes",
      },
    ],
  },
  {
    id: "proxy",
    label: "Proxy",
    items: [
      {
        route: "proxy",
        label: "Dashboard",
        title: "API Proxy",
        description: "Live proxy health: topology, scheduler plans, stats",
      },
      {
        route: "proxy",
        subpath: "models",
        label: "API models",
        title: "API models",
        description:
          "Published model IDs exposed on /v1/models and where they route",
      },
      {
        route: "proxy",
        subpath: "pipelines",
        label: "Pipelines",
        title: "Pipelines",
        description:
          "Node graphs that transform and conditionally route requests to targets",
      },
      {
        route: "proxy",
        subpath: "targets",
        label: "Targets",
        title: "Proxy Targets",
        description:
          "Managed instances and external APIs that receive routed requests",
      },
      {
        route: "proxy",
        subpath: "endpoints",
        label: "Endpoints",
        title: "API Endpoints",
        description: "Registered external APIs and generated local endpoints",
      },
      {
        route: "proxy",
        subpath: "sources",
        label: "Sources",
        title: "Request Sources",
        description:
          "Label proxy requests by API key to track and route by origin",
      },
      {
        route: "proxy",
        subpath: "resources",
        label: "Resources",
        title: "Resources",
        description:
          "Memory pools and capacity budgets for instance scheduling",
      },
    ],
  },
  {
    id: "source",
    label: "Source & Build",
    items: [
      {
        route: "models",
        label: "GGUF files",
        title: "GGUF files",
        description: "Scan GGUF files and reuse them in instances or presets",
      },
      {
        route: "presets",
        label: "Presets",
        title: "Presets",
        description: "Edit the llama-server --models-preset INI file directly",
      },
      {
        route: "paths",
        label: "Paths",
        title: "Path Catalog",
        description: "Shared binary paths for instances",
      },
      {
        route: "args",
        label: "Arguments",
        title: "Arguments",
      },
      {
        route: "build",
        label: "Build",
        title: "Build",
        description: "Update llama.cpp and build llama-server with CMake",
      },
      {
        route: "environments",
        label: "Environments",
        title: "Python environments",
        description: "Install immutable uv-managed inference engines",
      },
      {
        route: "source-sync",
        label: "Source Sync",
        title: "Source Sync",
        description:
          "Clone inference sources, manage origins, and inspect integration drift",
      },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    items: [
      {
        route: "system",
        label: "System",
        title: "System resources",
        description: "Live RAM, accelerator, and disk activity for this node",
      },
      {
        route: "api-lab",
        label: "API Lab",
        title: "API Lab",
        description: "Manual probes for OpenAI-compatible and llama.cpp APIs",
      },
    ],
  },
];

const navLeaves = navSections.flatMap((section) => section.items);
const routeIds = new Set<AppRoute>(navLeaves.map((leaf) => leaf.route));

const legacyAlias: Record<string, { route: AppRoute; subpath: string }> = {
  routing: { route: "proxy", subpath: "pipelines" },
  endpoints: { route: "proxy", subpath: "endpoints" },
  sources: { route: "proxy", subpath: "sources" },
  resources: { route: "proxy", subpath: "resources" },
};

function parseHash(): { route: AppRoute; subpath: string } {
  const path = window.location.hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  const head = segments[0] ?? "";
  const rest = segments.slice(1).join("/");
  const alias = legacyAlias[head];
  if (alias) {
    return {
      route: alias.route,
      subpath: rest ? `${alias.subpath}/${rest}` : alias.subpath,
    };
  }
  if (routeIds.has(head as AppRoute)) {
    return { route: head as AppRoute, subpath: rest };
  }
  return { route: "status", subpath: "" };
}

function routeFromHash(): AppRoute {
  return parseHash().route;
}

export function useHashRoute() {
  const [route, setRouteState] = useState<AppRoute>(() => routeFromHash());

  useEffect(() => {
    const onHashChange = () => setRouteState(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function setRoute(nextRoute: AppRoute) {
    window.location.hash = `/${nextRoute}`;
    setRouteState(nextRoute);
  }

  return [route, setRoute] as const;
}

function subpathFromHash(route: AppRoute): string {
  const parsed = parseHash();
  return parsed.route === route ? parsed.subpath : "";
}

export function useHashSubpath(route: AppRoute) {
  const [subpath, setSubpathState] = useState(() => subpathFromHash(route));

  useEffect(() => {
    const onHashChange = () => setSubpathState(subpathFromHash(route));
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [route]);

  function setSubpath(next: string) {
    window.location.hash = next ? `/${route}/${next}` : `/${route}`;
    setSubpathState(subpathFromHash(route));
  }

  return [subpath, setSubpath] as const;
}

export function navigateToLeaf(leaf: NavLeaf) {
  window.location.hash = leaf.subpath
    ? `/${leaf.route}/${leaf.subpath}`
    : `/${leaf.route}`;
}

export function navigateProxy(subpath: string) {
  window.location.hash = subpath ? `/proxy/${subpath}` : "/proxy";
}

export function isLeafActive(
  leaf: NavLeaf,
  route: AppRoute,
  subpath: string,
): boolean {
  if (leaf.route !== route) {
    return false;
  }
  const head = subpath.split("/")[0] ?? "";
  return (leaf.subpath ?? "") === head;
}

export function activeLeaf(route: AppRoute, subpath: string): NavLeaf {
  const match = navLeaves.find((leaf) => isLeafActive(leaf, route, subpath));
  if (match) {
    return match;
  }
  return navLeaves.find((leaf) => leaf.route === route) ?? navLeaves[0]!;
}
