import { activeNodeScopedPath, apiBase } from "./base.js";

export function buildQuery(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value as string)}`,
    );
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function formatApiErrorValue(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(formatApiErrorValue).filter(Boolean).join("; ");
  }
  if (typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  const formErrors = formatApiErrorValue(record.formErrors);
  const fieldErrors =
    record.fieldErrors && typeof record.fieldErrors === "object"
      ? Object.entries(record.fieldErrors as Record<string, unknown>)
          .map(([field, messages]) => {
            const text = formatApiErrorValue(messages);
            return text ? `${field}: ${text}` : null;
          })
          .filter(Boolean)
          .join("; ")
      : null;
  if (formErrors || fieldErrors) {
    return [formErrors, fieldErrors].filter(Boolean).join("; ");
  }
  if (typeof record.message === "string") {
    return record.message;
  }

  return (
    Object.entries(record)
      .map(([key, nested]) => {
        const text = formatApiErrorValue(nested);
        return text ? `${key}: ${text}` : null;
      })
      .filter(Boolean)
      .join("; ") || null
  );
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function nodeRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return request<T>(activeNodeScopedPath(path), init);
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    let parsed: {
      error?: unknown;
      issues?: Array<{ message?: unknown }>;
    } | null = null;
    try {
      parsed = JSON.parse(error) as {
        error?: unknown;
        issues?: Array<{ message?: unknown }>;
      };
    } catch {
      parsed = null;
    }
    if (parsed) {
      const issueText = parsed.issues
        ?.map((issue) => formatApiErrorValue(issue.message))
        .filter(Boolean)
        .join("; ");
      throw new ApiError(
        issueText || formatApiErrorValue(parsed.error) || response.statusText,
        response.status,
        parsed,
      );
    }
    throw new ApiError(error || response.statusText, response.status, null);
  }

  return (await response.json()) as T;
}
