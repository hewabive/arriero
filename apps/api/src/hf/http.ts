import { Agent, fetch as undiciFetch } from "undici";

const HF_HEADERS_TIMEOUT_MS = 30_000;
const HF_BODY_IDLE_TIMEOUT_MS = 45_000;

const hfDownloadDispatcher = new Agent({
  headersTimeout: HF_HEADERS_TIMEOUT_MS,
  bodyTimeout: HF_BODY_IDLE_TIMEOUT_MS,
});

export function hfDownloadFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...init,
      dispatcher: hfDownloadDispatcher,
    } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
}
