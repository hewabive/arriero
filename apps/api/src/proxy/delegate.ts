import type { ApiProxyServeRequest, FleetNode } from "@arriero/core";

import { nodeApiUrl } from "../nodes/remote.js";
import { nodeToken } from "../nodes/repository.js";
import { proxyUpstreamFetch } from "./http.js";

const STRIPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
];

export async function delegateApiProxyServe(input: {
  node: FleetNode;
  payload: ApiProxyServeRequest;
  signal: AbortSignal;
}): Promise<{ upstream: Response; headers: Headers }> {
  const headers = new Headers({ "content-type": "application/json" });
  const token = nodeToken(input.node.id);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const upstream = await proxyUpstreamFetch(
    nodeApiUrl(input.node, "proxy/serve"),
    {
      method: "POST",
      headers,
      body: JSON.stringify(input.payload),
      signal: input.signal,
    },
  );
  const responseHeaders = new Headers(upstream.headers);
  for (const header of STRIPPED_RESPONSE_HEADERS) {
    responseHeaders.delete(header);
  }
  return { upstream, headers: responseHeaders };
}
