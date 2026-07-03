import {
  engineDescriptor,
  type EngineLogParserId,
  type InstanceKind,
} from "@llama-manager/core";

import { llamaLogParser } from "./llama.js";
import type { EngineLogParser } from "./types.js";

const ENGINE_LOG_PARSERS: Record<EngineLogParserId, EngineLogParser> = {
  llama: llamaLogParser,
};

export function engineLogParser(kind: InstanceKind): EngineLogParser {
  return ENGINE_LOG_PARSERS[engineDescriptor(kind).logs.parser];
}

export * from "./types.js";
