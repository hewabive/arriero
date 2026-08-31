import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import https from "node:https";

const HF_HEADERS_TIMEOUT_MS = 30_000;
const HF_BODY_IDLE_TIMEOUT_MS = 45_000;
const HF_MAX_REDIRECTS = 5;
const HF_MAX_ERROR_BODY_BYTES = 64 * 1024;

const hfDownloadAgent = new https.Agent({
  keepAlive: true,
  maxFreeSockets: 8,
  maxSockets: 16,
  timeout: 60_000,
});

export type HfDownloadResponse = {
  body: AsyncIterable<Uint8Array> | null;
  discard: () => Promise<void>;
  headers: Headers;
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  url: string;
};

type HfDownloadRequestInit = {
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
};

export type HfDownloadImpl = (
  input: string | URL,
  init?: HfDownloadRequestInit,
) => Promise<HfDownloadResponse>;

function responseHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function responseText(response: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = HF_MAX_ERROR_BODY_BYTES - length;
    if (remaining > 0) {
      const part = chunk.subarray(0, remaining);
      parts.push(part);
      length += part.length;
    }
  }
  return Buffer.concat(parts, length).toString("utf8");
}

export function hfRedirectedDownloadHeaders(
  headers: Record<string, string>,
  from: URL,
  to: URL,
): Record<string, string> {
  if (from.origin === to.origin) {
    return headers;
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !["authorization", "cookie", "proxy-authorization"].includes(
          name.toLowerCase(),
        ),
    ),
  );
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function requestOnce(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        agent: hfDownloadAgent,
        headers,
        method: "GET",
        signal,
      },
      (response) => {
        clearTimeout(headersTimer);
        const socket = response.socket;
        response.setTimeout(HF_BODY_IDLE_TIMEOUT_MS, () => {
          response.destroy(new Error("HuggingFace download body timed out"));
        });
        response.once("end", () => socket.setTimeout(0));
        response.once("close", () => socket.setTimeout(0));
        resolve(response);
      },
    );
    const headersTimer = setTimeout(() => {
      request.destroy(new Error("HuggingFace download headers timed out"));
    }, HF_HEADERS_TIMEOUT_MS);
    headersTimer.unref();
    request.once("error", (error) => {
      clearTimeout(headersTimer);
      reject(error);
    });
    request.end();
  });
}

async function requestFollowingRedirects(
  input: URL,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  redirects: number,
): Promise<HfDownloadResponse> {
  if (input.protocol !== "https:") {
    throw new Error(
      `refusing non-HTTPS HuggingFace download URL: ${input.href}`,
    );
  }
  const response = await requestOnce(input, headers, signal);
  const status = response.statusCode ?? 0;
  const location = response.headers.location;
  if (isRedirect(status) && location) {
    if (redirects >= HF_MAX_REDIRECTS) {
      response.resume();
      throw new Error("too many HuggingFace download redirects");
    }
    const target = new URL(location, input);
    if (target.protocol !== "https:") {
      response.resume();
      throw new Error(`refusing HuggingFace redirect to ${target.protocol}`);
    }
    await new Promise<void>((resolve, reject) => {
      response.once("end", resolve);
      response.once("error", reject);
      response.resume();
    });
    return requestFollowingRedirects(
      target,
      hfRedirectedDownloadHeaders(headers, input, target),
      signal,
      redirects + 1,
    );
  }
  return {
    body: response,
    discard: async () => {
      response.destroy();
    },
    headers: responseHeaders(response.headers),
    ok: status >= 200 && status < 300,
    status,
    text: () => responseText(response),
    url: input.href,
  };
}

export const hfDownloadRequest: HfDownloadImpl = async (input, init) => {
  return requestFollowingRedirects(
    new URL(input),
    { ...init?.headers },
    init?.signal,
    0,
  );
};

export function fetchDownloadImpl(fetchImpl: typeof fetch): HfDownloadImpl {
  return async (input, init) => {
    const requestInit: RequestInit = { redirect: "follow" };
    if (init?.headers) {
      requestInit.headers = init.headers;
    }
    if (init?.signal) {
      requestInit.signal = init.signal;
    }
    const response = await fetchImpl(input, requestInit);
    return {
      body: response.body as unknown as AsyncIterable<Uint8Array> | null,
      discard: async () => {
        await response.body?.cancel();
      },
      headers: response.headers,
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      url: response.url,
    };
  };
}
