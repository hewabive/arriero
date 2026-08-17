import type {
  ApiProxyEditRequestOperation,
  ApiProxyOutputLimitConfig,
} from "./pipeline-nodes.js";

export function apiProxyOutputLimitEditOperations(
  config: ApiProxyOutputLimitConfig,
  body: unknown,
): ApiProxyEditRequestOperation[] {
  const record = namedRecord(body);
  const current =
    record && typeof record.max_tokens === "number" ? record.max_tokens : null;
  const next =
    config.mode === "set"
      ? config.maxTokens
      : current === null
        ? config.maxTokens
        : Math.min(current, config.maxTokens);
  if (current === next) {
    return [];
  }
  return [
    { kind: "set-field", enabled: true, path: "max_tokens", value: next },
  ];
}

export type ApiProxyRequestEditOutcome = {
  index: number;
  kind: ApiProxyEditRequestOperation["kind"];
  matched: number;
  toolNames: string[];
  detail: string;
};

export type ApiProxyRequestEditResult = {
  body: unknown;
  outcomes: ApiProxyRequestEditOutcome[];
  changed: boolean;
};

export function namedRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function apiProxyRequestToolName(tool: unknown): string | null {
  const record = namedRecord(tool);
  if (!record) {
    return null;
  }
  const fn = namedRecord(record.function);
  if (fn && typeof fn.name === "string" && fn.name) {
    return fn.name;
  }
  return typeof record.name === "string" && record.name ? record.name : null;
}

function escapeToolNamePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function apiProxyToolNameMatcher(
  pattern: string,
): (name: string) => boolean {
  if (!pattern.includes("*")) {
    return (name) => name === pattern;
  }
  const regex = new RegExp(
    `^${pattern.split("*").map(escapeToolNamePattern).join(".*")}$`,
  );
  return (name) => regex.test(name);
}

export type ApiProxyBodyFieldSegment = string | number;

export function parseApiProxyBodyFieldPath(
  path: string,
): ApiProxyBodyFieldSegment[] | null {
  let rest = path.trim();
  if (!rest) {
    return null;
  }
  const segments: ApiProxyBodyFieldSegment[] = [];
  while (rest.length > 0) {
    if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close === -1) {
        return null;
      }
      const index = rest.slice(1, close);
      if (!/^\d+$/.test(index)) {
        return null;
      }
      segments.push(Number(index));
      rest = rest.slice(close + 1);
    } else {
      const key = /^[^.[\]]+/.exec(rest)?.[0];
      if (!key) {
        return null;
      }
      segments.push(key);
      rest = rest.slice(key.length);
    }
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      if (!rest || rest.startsWith(".") || rest.startsWith("[")) {
        return null;
      }
    } else if (rest.length > 0 && !rest.startsWith("[")) {
      return null;
    }
  }
  return segments;
}

type BodyFieldContainer = Record<string, unknown> | unknown[];

type BodyFieldEditResult = { changed: boolean; detail: string };

function cloneBodyContainer(value: unknown): BodyFieldContainer | null {
  if (Array.isArray(value)) {
    return [...value];
  }
  const record = namedRecord(value);
  return record ? { ...record } : null;
}

function formatBodyFieldValue(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function bodyFieldPathPrefix(
  segments: ApiProxyBodyFieldSegment[],
  count: number,
): string {
  let prefix = "";
  for (const segment of segments.slice(0, count)) {
    prefix +=
      typeof segment === "number"
        ? `[${segment}]`
        : prefix
          ? `.${segment}`
          : segment;
  }
  return prefix || "request body";
}

function setBodyField(
  root: Record<string, unknown>,
  segments: ApiProxyBodyFieldSegment[],
  value: unknown,
  path: string,
): BodyFieldEditResult {
  let parent: BodyFieldContainer = root;
  const lastIndex = segments.length - 1;
  for (const [position, segment] of segments.entries()) {
    const at = bodyFieldPathPrefix(segments, position);
    if (typeof segment === "number") {
      if (!Array.isArray(parent)) {
        return {
          changed: false,
          detail: `cannot set ${path}: ${at} is not an array`,
        };
      }
      if (segment > parent.length - (position === lastIndex ? 0 : 1)) {
        return {
          changed: false,
          detail: `cannot set ${path}: index ${segment} is out of range at ${at}`,
        };
      }
      if (position === lastIndex) {
        const appended = segment === parent.length;
        const previous = appended
          ? ""
          : ` (was ${formatBodyFieldValue(parent[segment])})`;
        parent[segment] = value;
        return {
          changed: true,
          detail: `set ${path} = ${formatBodyFieldValue(value)}${previous}`,
        };
      }
      const child = cloneBodyContainer(parent[segment]);
      if (!child) {
        return {
          changed: false,
          detail: `cannot set ${path}: ${bodyFieldPathPrefix(segments, position + 1)} is not an object or array`,
        };
      }
      parent[segment] = child;
      parent = child;
      continue;
    }
    if (Array.isArray(parent)) {
      return {
        changed: false,
        detail: `cannot set ${path}: ${at} is an array, expected an object`,
      };
    }
    if (position === lastIndex) {
      const previous =
        segment in parent
          ? ` (was ${formatBodyFieldValue(parent[segment])})`
          : "";
      parent[segment] = value;
      return {
        changed: true,
        detail: `set ${path} = ${formatBodyFieldValue(value)}${previous}`,
      };
    }
    const existing = parent[segment];
    const child = existing === undefined ? {} : cloneBodyContainer(existing);
    if (!child) {
      return {
        changed: false,
        detail: `cannot set ${path}: ${bodyFieldPathPrefix(segments, position + 1)} is not an object or array`,
      };
    }
    parent[segment] = child;
    parent = child;
  }
  return { changed: false, detail: `cannot set ${path}` };
}

function removeBodyField(
  root: Record<string, unknown>,
  segments: ApiProxyBodyFieldSegment[],
  path: string,
): BodyFieldEditResult {
  const notPresent = { changed: false, detail: `${path} is not present` };
  let parent: BodyFieldContainer = root;
  const lastIndex = segments.length - 1;
  for (const [position, segment] of segments.entries()) {
    if (position === lastIndex) {
      if (typeof segment === "number") {
        if (!Array.isArray(parent) || segment >= parent.length) {
          return notPresent;
        }
        const previous = formatBodyFieldValue(parent[segment]);
        parent.splice(segment, 1);
        return { changed: true, detail: `removed ${path} (was ${previous})` };
      }
      if (Array.isArray(parent) || !(segment in parent)) {
        return notPresent;
      }
      const previous = formatBodyFieldValue(parent[segment]);
      delete parent[segment];
      return { changed: true, detail: `removed ${path} (was ${previous})` };
    }
    const existing =
      typeof segment === "number"
        ? Array.isArray(parent)
          ? parent[segment]
          : undefined
        : Array.isArray(parent)
          ? undefined
          : parent[segment];
    const child = cloneBodyContainer(existing);
    if (!child) {
      return notPresent;
    }
    if (typeof segment === "number") {
      (parent as unknown[])[segment] = child;
    } else {
      (parent as Record<string, unknown>)[segment] = child;
    }
    parent = child;
  }
  return notPresent;
}

export function applyApiProxyRequestEdits(
  body: unknown,
  operations: ApiProxyEditRequestOperation[],
): ApiProxyRequestEditResult {
  const outcomes: ApiProxyRequestEditOutcome[] = [];
  const active = operations
    .map((operation, index) => ({ operation, index }))
    .filter((item) => item.operation.enabled);
  if (active.length === 0) {
    return { body, outcomes, changed: false };
  }

  const record = namedRecord(body);
  if (!record) {
    for (const { operation, index } of active) {
      outcomes.push({
        index,
        kind: operation.kind,
        matched: 0,
        toolNames: [],
        detail: "request body is not a JSON object",
      });
    }
    return { body, outcomes, changed: false };
  }

  const next: Record<string, unknown> = { ...record };
  let changed = false;

  for (const { operation, index } of active) {
    const outcome = (
      matched: number,
      toolNames: string[],
      detail: string,
    ): void => {
      outcomes.push({
        index,
        kind: operation.kind,
        matched,
        toolNames,
        detail,
      });
    };

    if (operation.kind === "set-field" || operation.kind === "remove-field") {
      const segments = parseApiProxyBodyFieldPath(operation.path);
      if (!segments) {
        outcome(0, [], `invalid field path "${operation.path}"`);
        continue;
      }
      const edit =
        operation.kind === "set-field"
          ? setBodyField(next, segments, operation.value, operation.path)
          : removeBodyField(next, segments, operation.path);
      if (edit.changed) {
        changed = true;
      }
      outcome(edit.changed ? 1 : 0, [], edit.detail);
      continue;
    }

    const tools = next.tools;

    if (operation.kind === "add-tool") {
      if (tools !== undefined && !Array.isArray(tools)) {
        outcome(0, [], "tools is not an array");
        continue;
      }
      const name = apiProxyRequestToolName(operation.value);
      next.tools = [...(Array.isArray(tools) ? tools : []), operation.value];
      changed = true;
      outcome(
        1,
        name ? [name] : [],
        name ? `added tool "${name}"` : "added 1 tool",
      );
      continue;
    }

    if (!Array.isArray(tools)) {
      outcome(
        0,
        [],
        tools === undefined
          ? "request has no tools array"
          : "tools is not an array",
      );
      continue;
    }
    const matches = apiProxyToolNameMatcher(operation.toolName);

    if (operation.kind === "remove-tool") {
      const removed: string[] = [];
      const kept = tools.filter((tool) => {
        const name = apiProxyRequestToolName(tool);
        if (name !== null && matches(name)) {
          removed.push(name);
          return false;
        }
        return true;
      });
      if (removed.length === 0) {
        outcome(0, [], `no tool matches "${operation.toolName}"`);
        continue;
      }
      if (kept.length > 0) {
        next.tools = kept;
      } else {
        delete next.tools;
      }
      changed = true;
      let detail = `removed ${removed.length} tool(s): ${removed.join(", ")}`;
      const choiceName = apiProxyRequestToolName(next.tool_choice);
      if (choiceName !== null && removed.includes(choiceName)) {
        delete next.tool_choice;
        detail += `; dropped tool_choice "${choiceName}"`;
      }
      outcome(removed.length, removed, detail);
      continue;
    }

    const replaced: string[] = [];
    const mapped = tools.map((tool) => {
      const name = apiProxyRequestToolName(tool);
      if (name !== null && matches(name)) {
        replaced.push(name);
        return operation.value;
      }
      return tool;
    });
    if (replaced.length === 0) {
      outcome(0, [], `no tool matches "${operation.toolName}"`);
      continue;
    }
    next.tools = mapped;
    changed = true;
    const newName = apiProxyRequestToolName(operation.value);
    outcome(
      replaced.length,
      replaced,
      `replaced ${replaced.length} tool(s) ${replaced.join(", ")}${newName ? ` with "${newName}"` : ""}`,
    );
  }

  return { body: changed ? next : body, outcomes, changed };
}
