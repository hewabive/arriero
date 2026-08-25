import {
  webappDescriptor,
  type WebappConfigRecord,
  type WebappKind,
  type WebappStopReason,
} from "@arriero/core";

import { runLogPaths } from "../process/log-paths.js";
import {
  shutdownSupervisedChildren,
  SupervisedChild,
  type SupervisedChildState,
  type SupervisedShutdownResult,
} from "../process/supervised-child.js";
import {
  createWebappRun,
  updateWebappRun,
  type WebappRun,
} from "./runs-repository.js";
import { webappLogsDir } from "./paths.js";

type WebappLaunchPlan = {
  name: string;
  kind: WebappKind;
  binaryPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  serializedSnapshot: string;
};

export type WebappRuntimeState = { name: string } & SupervisedChildState;

class WebappSupervisor {
  private readonly processes = new Map<
    string,
    SupervisedChild<WebappStopReason>
  >();

  private createChild(name: string, kind: WebappKind) {
    return new SupervisedChild<WebappStopReason>({
      logLabel: `webapp ${name}`,
      logGrammar: webappDescriptor(kind).logGrammar,
      updateRun: updateWebappRun,
    });
  }

  getState(name: string): WebappRuntimeState | undefined {
    const child = this.processes.get(name);
    if (!child) {
      return undefined;
    }
    return { name, ...child.state() };
  }

  launch(plan: WebappLaunchPlan): WebappRuntimeState {
    const current = this.processes.get(plan.name);
    if (current && !current.isTerminal()) {
      return this.getState(plan.name)!;
    }

    const { logPath, rawLogPath } = runLogPaths(
      webappLogsDir(),
      plan.name,
      Date.now(),
    );
    const child = this.createChild(plan.name, plan.kind);
    this.processes.set(plan.name, child);
    child.launch(
      {
        binaryPath: plan.binaryPath,
        args: plan.args,
        cwd: plan.cwd,
        env: plan.env,
        logPath,
        rawLogPath,
      },
      (input) =>
        createWebappRun({
          webappId: plan.name,
          launchSnapshot: plan.serializedSnapshot,
          ...input,
        }),
    );

    return this.getState(plan.name)!;
  }

  adopt(
    record: Pick<WebappConfigRecord, "name" | "kind">,
    run: WebappRun,
    pid: number,
  ): WebappRuntimeState {
    const current = this.processes.get(record.name);
    if (current && !current.isTerminal()) {
      return this.getState(record.name)!;
    }

    const child = this.createChild(record.name, record.kind);
    this.processes.set(record.name, child);
    child.adopt({
      runId: run.id,
      pid,
      startedAt: run.startedAt,
      logPath: run.logPath,
      rawLogPath: run.rawLogPath,
    });

    return this.getState(record.name)!;
  }

  stop(
    name: string,
    reason: WebappStopReason,
    timeoutMs = 10_000,
  ): WebappRuntimeState | null {
    const child = this.processes.get(name);
    if (!child) {
      return null;
    }
    child.requestStop(reason, timeoutMs);
    return this.getState(name)!;
  }

  async waitForStopped(name: string, timeoutMs: number): Promise<boolean> {
    const child = this.processes.get(name);
    if (!child) {
      return true;
    }
    return child.waitForExit(timeoutMs);
  }

  shutdownAll(timeoutMs = 10_000): Promise<SupervisedShutdownResult> {
    return shutdownSupervisedChildren(
      this.processes.values(),
      "shutdown",
      timeoutMs,
    );
  }
}

export const webappSupervisor = new WebappSupervisor();
