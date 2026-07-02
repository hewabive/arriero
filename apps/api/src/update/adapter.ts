import { config } from "../config.js";
import { beginApiProxyDrain } from "../proxy/drain.js";
import { apiProxyInflight } from "../proxy/inflight.js";
import { apiProxyStreamSessions } from "../proxy/stream-session.js";
import { newId } from "../utils/id.js";

export { AppVersionSchema } from "@llama-manager/core";
export type {
  AppRunMode,
  AppVersion,
  UpdateJob,
  UpdateJobStart,
  UpdateJobStatus,
  UpdateJobStep,
  UpdateJobStepName,
  UpdateLogTail,
} from "@llama-manager/core";

export const updateAdapter = {
  appName: "llama-manager",
  rootDir: config.rootDir,
  logsDir: config.logsDir,
  newJobId: (): string => newId(),
  beforeRestart: (): Promise<void> =>
    new Promise((resolve) => {
      beginApiProxyDrain();
      const deadline = Date.now() + config.update.drainTimeoutMs;
      const poll = setInterval(() => {
        const nonResumable =
          apiProxyInflight.activeCount() - apiProxyStreamSessions.size();
        if (nonResumable > 0 && Date.now() < deadline) {
          return;
        }
        clearInterval(poll);
        resolve();
      }, 500);
      poll.unref?.();
    }),
};
