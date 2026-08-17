import { parentPort } from "node:worker_threads";

import {
  readGgufFacts,
  readGgufModelTensorTable,
  readGgufParameterCount,
} from "./gguf.js";
import { readSafetensorsFacts } from "./safetensors.js";

export type GgufWorkerOp =
  | "facts"
  | "parameter-count"
  | "tensor-table"
  | "safetensors-facts";

export type GgufWorkerRequest = {
  id: number;
  op: GgufWorkerOp;
  path: string;
};

export type GgufWorkerResponse = {
  id: number;
  data?: unknown;
  error?: string;
};

function runOp(op: GgufWorkerOp, path: string) {
  if (op === "facts") {
    return readGgufFacts(path);
  }
  if (op === "parameter-count") {
    return readGgufParameterCount(path);
  }
  if (op === "safetensors-facts") {
    return readSafetensorsFacts(path);
  }
  return readGgufModelTensorTable(path);
}

const port = parentPort;

if (port) {
  port.on("message", (request: GgufWorkerRequest) => {
    try {
      port.postMessage({
        id: request.id,
        data: runOp(request.op, request.path),
      });
    } catch (error) {
      port.postMessage({ id: request.id, error: (error as Error).message });
    }
  });
}
