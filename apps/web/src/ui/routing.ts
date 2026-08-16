import { useEffect, useState } from "react";

export type AppRoute =
  | "status"
  | "login"
  | "nodes"
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
  | "prerequisites"
  | "benchmark"
  | "api-lab";

export type NavLeaf = {
  route: AppRoute;
  subpath?: string;
  label: string;
  title: string;
  description?: string;
  keywords?: string[];
};

export type NavSection = {
  id: string;
  label: string;
  items: NavLeaf[];
  footer?: boolean;
};

const navSections: NavSection[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        route: "dashboard",
        label: "Overview",
        title: "Overview",
        description:
          "Attention signals, instance issues and API activity over the last hour",
        keywords: ["home", "dashboard", "health", "attention", "activity"],
      },
    ],
  },
  {
    id: "instances",
    label: "Instances",
    items: [
      {
        route: "instances",
        label: "Instances",
        title: "Instances",
        description: "Process control for local inference instances",
        keywords: ["start", "stop", "restart", "launch"],
      },
      {
        route: "diagnostics",
        label: "Diagnostics",
        title: "Diagnostics",
        description: "Runtime state, endpoint probes and logs",
        keywords: ["logs", "probe", "slots", "memory"],
      },
      {
        route: "processes",
        label: "Processes",
        title: "Processes",
        description: "Inspect unmanaged llama-server processes",
        keywords: ["pid", "unmanaged", "stale"],
      },
    ],
  },
  {
    id: "proxy",
    label: "Proxy",
    items: [
      {
        route: "proxy",
        label: "Overview",
        title: "API proxy",
        description: "Live proxy health: loaded targets and request stats",
        keywords: ["stats", "load", "runtime", "activity"],
      },
      {
        route: "proxy",
        subpath: "traces",
        label: "Requests",
        title: "Request history",
        description:
          "Browse, filter and inspect the persisted proxy request history",
        keywords: ["traces", "history", "errors"],
      },
      {
        route: "proxy",
        subpath: "topology",
        label: "Topology",
        title: "Routing topology",
        description:
          "What each published model reaches and a dry-run of the scheduler plan",
        keywords: ["topology", "scheduler", "plan", "routes", "plan check"],
      },
      {
        route: "proxy",
        subpath: "models",
        label: "Models",
        title: "API models",
        description:
          "Published model IDs exposed on /v1/models and where they route",
        keywords: ["v1/models", "published", "visible"],
      },
      {
        route: "proxy",
        subpath: "pipelines",
        label: "Pipelines",
        title: "Pipelines",
        description:
          "Node graphs that transform and conditionally route requests to targets",
        keywords: ["routing", "graph", "cache", "loop guard"],
      },
      {
        route: "proxy",
        subpath: "targets",
        label: "Targets",
        title: "Proxy targets",
        description:
          "Managed instances and external APIs that receive routed requests",
        keywords: ["upstream", "autostart"],
      },
      {
        route: "proxy",
        subpath: "endpoints",
        label: "Endpoints",
        title: "API endpoints",
        description: "Registered external APIs and generated local endpoints",
        keywords: ["external", "provider", "openrouter"],
      },
      {
        route: "proxy",
        subpath: "sources",
        label: "Keys",
        title: "Request sources",
        description:
          "Map API keys to source labels, block sources and control anonymous access",
        keywords: ["api keys", "auth", "token", "bearer"],
      },
      {
        route: "proxy",
        subpath: "resources",
        label: "Memory pools",
        title: "Memory pools",
        description:
          "Memory pools and capacity budgets for instance scheduling",
        keywords: ["resources", "vram", "capacity", "eviction"],
      },
    ],
  },
  {
    id: "files",
    label: "Models & files",
    items: [
      {
        route: "models",
        label: "GGUF files",
        title: "GGUF files",
        description: "Scan GGUF files and reuse them in instances or presets",
        keywords: ["scan", "quantization", "metadata"],
      },
      {
        route: "paths",
        label: "Paths",
        title: "Path catalog",
        description: "Shared binary paths and model directories for instances",
        keywords: ["binary", "directory", "catalog"],
      },
      {
        route: "presets",
        label: "Presets",
        title: "Presets",
        description: "Edit the llama-server --models-preset INI file directly",
        keywords: ["ini", "router", "models-preset"],
      },
    ],
  },
  {
    id: "engines",
    label: "Engines",
    items: [
      {
        route: "args",
        label: "Arguments",
        title: "Arguments",
        description:
          "Engine arguments with engineering help, defaults and source sync",
        keywords: ["flags", "help", "llama.cpp", "vllm", "sglang"],
      },
      {
        route: "build",
        label: "Build",
        title: "Build",
        description: "Update llama.cpp and build llama-server with CMake",
        keywords: ["cmake", "compile", "cuda"],
      },
      {
        route: "environments",
        label: "Environments",
        title: "Python environments",
        description: "Install immutable uv-managed inference engines",
        keywords: ["uv", "venv", "python", "ktransformers"],
      },
      {
        route: "source-sync",
        label: "Sources",
        title: "Source sync",
        description:
          "Clone inference sources, manage origins, and inspect integration drift",
        keywords: ["git", "checkout", "drift", "upstream"],
      },
    ],
  },
  {
    id: "host",
    label: "Host",
    items: [
      {
        route: "system",
        label: "Resources",
        title: "System resources",
        description:
          "Live CPU, RAM, accelerator, disk and network activity for this node",
        keywords: ["cpu", "ram", "gpu", "disk", "network", "numa"],
      },
      {
        route: "prerequisites",
        label: "Prerequisites",
        title: "Environment prerequisites",
        description:
          "Host tooling this node needs, what each missing piece blocks, and how to install it",
        keywords: ["install", "tooling", "driver", "sudo"],
      },
    ],
  },
  {
    id: "lab",
    label: "Lab",
    items: [
      {
        route: "api-lab",
        label: "API lab",
        title: "API lab",
        description: "Manual probes for OpenAI-compatible and llama.cpp APIs",
        keywords: ["probe", "request", "openai", "curl"],
      },
      {
        route: "benchmark",
        label: "Benchmark",
        title: "Inference benchmark",
        description:
          "Measure decode speed under mixed parallel load with prefill/decode phase attribution",
        keywords: ["speed", "tokens", "decode", "prefill"],
      },
    ],
  },
  {
    id: "manager",
    label: "Manager",
    footer: true,
    items: [
      {
        route: "nodes",
        label: "Nodes",
        title: "Nodes",
        description:
          "Register Arriero nodes to manage from one address and update them to the latest revision",
        keywords: ["fleet", "federation", "peer", "update"],
      },
      {
        route: "config-git",
        label: "Configuration",
        title: "Configuration",
        description:
          "Version this node's portable configuration, review file state and apply edits from disk",
        keywords: ["git", "config", "commit", "reload"],
      },
    ],
  },
];

const publicStatusSection: NavSection = {
  id: "public-status",
  label: "Public status",
  items: [
    {
      route: "status",
      label: "Status",
      title: "Public status",
      description: "Redacted diagnostics for this Arriero node",
      keywords: ["public", "redacted", "share"],
    },
  ],
};

const loginSection: NavSection = {
  id: "login",
  label: "Sign in",
  items: [
    {
      route: "login",
      label: "Sign in",
      title: "Sign in",
      description: "Admin access unlocks everything except the public status",
    },
  ],
};

export const paletteSections: NavSection[] = [
  ...navSections,
  publicStatusSection,
];

export function sidebarSections(canUseAdmin: boolean): NavSection[] {
  return canUseAdmin ? navSections : [publicStatusSection, loginSection];
}

const allSections = [...navSections, publicStatusSection, loginSection];
const navLeaves = allSections.flatMap((section) => section.items);
const routeIds = new Set<AppRoute>(navLeaves.map((leaf) => leaf.route));

const legacyAlias: Record<string, { route: AppRoute; subpath: string }> = {
  update: { route: "nodes", subpath: "" },
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

export function activeLeaf(route: AppRoute, subpath: string): NavLeaf {
  const head = subpath.split("/")[0] ?? "";
  const exact = navLeaves.find(
    (leaf) => leaf.route === route && (leaf.subpath ?? "") === head,
  );
  if (exact) {
    return exact;
  }
  return navLeaves.find((leaf) => leaf.route === route) ?? navLeaves[0]!;
}

export function isLeafActive(
  leaf: NavLeaf,
  route: AppRoute,
  subpath: string,
): boolean {
  return activeLeaf(route, subpath) === leaf;
}

export function activeSection(route: AppRoute, subpath: string): NavSection {
  const leaf = activeLeaf(route, subpath);
  return (
    allSections.find((section) => section.items.includes(leaf)) ??
    allSections[0]!
  );
}
