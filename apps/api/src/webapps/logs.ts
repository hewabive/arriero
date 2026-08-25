import type { WebappLogTail } from "@arriero/core";

import { tailRunLog } from "../process/logs.js";
import { latestWebappRun } from "./runs-repository.js";
import type { WebappRuntimeState } from "./supervisor.js";

export function tailWebappLog(input: {
  name: string;
  runtime: WebappRuntimeState | undefined;
  lines: number;
  source?: "filtered" | "raw" | undefined;
}): WebappLogTail {
  return {
    name: input.name,
    ...tailRunLog({
      runtime: input.runtime,
      latestRun: () => latestWebappRun(input.name),
      lines: input.lines,
      source: input.source,
    }),
  };
}
