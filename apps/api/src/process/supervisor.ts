import {
  engineDescriptor,
  isActiveProcessStatus,
  type Instance,
  type InstanceKind,
  type ProcessEvent,
  type RuntimeState,
} from "@arriero/core";
import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";

import { config } from "../config.js";
import {
  instanceCgroupDir,
  instanceCgroupExists,
  removeNumaCgroup,
  resolveNumaLaunch,
} from "../numa/index.js";
import { probeRequestLogGrammar } from "./log-filter.js";
import { runLogPaths } from "./log-paths.js";
import {
  buildLaunchSnapshot,
  managedSlotSavePath,
  serializeLaunchSnapshot,
} from "./launch-snapshot.js";
import {
  ProcessPreflightError,
  validateInstancePreflight,
} from "./preflight.js";
import {
  shutdownSupervisedChildren,
  SupervisedChild,
  type SupervisedShutdownResult,
} from "./supervised-child.js";
import {
  createProcessRun,
  updateProcessRun,
  type ProcessRun,
  type ProcessStopReason,
} from "./runs-repository.js";

type ProcessState = RuntimeState;

export function managedSignalPid(
  kind: InstanceKind,
  pid: number,
  platform: NodeJS.Platform = process.platform,
) {
  return platform !== "win32" &&
    engineDescriptor(kind).processTree === "all-descendants"
    ? -pid
    : pid;
}

const ENGINE_CACHE_ENV: Record<
  InstanceKind,
  { name: string; dir: string } | null
> = {
  "llama-server": null,
  "rpc-worker": null,
  vllm: { name: "VLLM_CACHE_ROOT", dir: config.vllmCacheDir },
  sglang: null,
  ktransformers: null,
};

export function managedProcessEnvironment(
  instance: Instance,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...parent, ...instance.env };
  const cacheEnv = ENGINE_CACHE_ENV[instance.kind];
  if (cacheEnv && env[cacheEnv.name] === undefined) {
    env[cacheEnv.name] = cacheEnv.dir;
  }
  return env;
}

function nowIso() {
  return new Date().toISOString();
}

export class ProcessSupervisor extends EventEmitter {
  private readonly processes = new Map<
    string,
    SupervisedChild<ProcessStopReason>
  >();
  private readonly startingInstances = new Map<string, Promise<ProcessState>>();

  constructor(private readonly preflightValidator = validateInstancePreflight) {
    super();
  }

  getState(instanceId: string): ProcessState | undefined {
    const child = this.processes.get(instanceId);
    if (!child) {
      return undefined;
    }
    return { instanceId, ...child.state() };
  }

  listStates(): ProcessState[] {
    return [...this.processes.keys()]
      .map((instanceId) => this.getState(instanceId))
      .filter((state): state is ProcessState => state !== undefined);
  }

  private assertRpcWorkersRunning(instance: Instance): void {
    for (const ref of instance.rpcWorkers) {
      if (ref.nodeId !== null) {
        continue;
      }
      const state = this.processes.get(ref.instanceName);
      if (!state || state.state().status !== "running") {
        throw new Error(
          `RPC worker "${ref.instanceName}" must be running before this instance can start`,
        );
      }
    }
  }

  async start(
    instance: Instance,
    rpcArgs: string[] = [],
  ): Promise<ProcessState> {
    const current = this.processes.get(instance.name);
    if (current && isActiveProcessStatus(current.state().status)) {
      return this.getState(instance.name)!;
    }
    const inFlight = this.startingInstances.get(instance.name);
    if (inFlight) {
      return inFlight;
    }
    const starting = this.launch(instance, rpcArgs).finally(() => {
      this.startingInstances.delete(instance.name);
    });
    this.startingInstances.set(instance.name, starting);
    return starting;
  }

  private createChild(
    instanceName: string,
    kind: InstanceKind,
    cgroupDir: string | null,
  ) {
    return new SupervisedChild<ProcessStopReason>({
      logLabel: instanceName,
      logGrammar: probeRequestLogGrammar(kind),
      signalPid: (pid) => managedSignalPid(kind, pid),
      updateRun: updateProcessRun,
      onEvent: (type, message) => this.emitEvent(type, instanceName, message),
      onFinalized: () => removeNumaCgroup(cgroupDir),
    });
  }

  private async launch(
    instance: Instance,
    rpcArgs: string[],
  ): Promise<ProcessState> {
    const preflight = await this.preflightValidator(instance);
    if (!preflight.ok) {
      throw new ProcessPreflightError(preflight);
    }
    this.assertRpcWorkersRunning(instance);

    const snapshot = buildLaunchSnapshot(instance);
    const slotSavePath = managedSlotSavePath(instance);
    if (slotSavePath) {
      mkdirSync(slotSavePath, { recursive: true });
    }
    const launch = resolveNumaLaunch(instance, snapshot.binaryPath, [
      ...snapshot.cliArgs,
      ...rpcArgs,
    ]);
    const { logPath, rawLogPath } = runLogPaths(
      config.logsDir,
      instance.name,
      Date.now(),
    );

    const child = this.createChild(
      instance.name,
      instance.kind ?? "llama-server",
      launch.cgroupDir,
    );
    this.processes.set(instance.name, child);
    child.launch(
      {
        binaryPath: launch.binary,
        args: launch.args,
        cwd: snapshot.cwd,
        env: managedProcessEnvironment(instance),
        logPath,
        rawLogPath,
      },
      (input) =>
        createProcessRun({
          instanceId: instance.name,
          launchSnapshot: serializeLaunchSnapshot(snapshot),
          ...input,
        }),
    );

    return this.getState(instance.name)!;
  }

  adopt(instance: Instance, run: ProcessRun, pid: number): ProcessState {
    const current = this.processes.get(instance.name);
    if (current && !current.isTerminal()) {
      return this.getState(instance.name)!;
    }

    const cgroupDir = instanceCgroupExists(instance.name)
      ? instanceCgroupDir(instance.name)
      : null;
    const child = this.createChild(
      instance.name,
      instance.kind ?? "llama-server",
      cgroupDir,
    );
    this.processes.set(instance.name, child);
    child.adopt({
      runId: run.id,
      pid,
      startedAt: run.startedAt,
      logPath: run.logPath,
      rawLogPath: run.rawLogPath,
    });

    return this.getState(instance.name)!;
  }

  stop(
    instanceId: string,
    reason: ProcessStopReason,
    timeoutMs = 10_000,
  ): ProcessState | null {
    const child = this.processes.get(instanceId);
    if (!child) {
      return null;
    }
    child.requestStop(reason, timeoutMs);
    return this.getState(instanceId)!;
  }

  shutdownAll(timeoutMs = 10_000): Promise<SupervisedShutdownResult> {
    return shutdownSupervisedChildren(
      this.processes.values(),
      "shutdown",
      timeoutMs,
    );
  }

  async restart(
    instance: Instance,
    rpcArgs: string[],
    stopReason: ProcessStopReason,
  ): Promise<ProcessState> {
    const child = this.processes.get(instance.name);
    if (child && !child.isTerminal()) {
      child.requestStop(stopReason, 5_000);
      await child.waitForExit(7_000);
    }
    return this.start(instance, rpcArgs);
  }

  private emitEvent(
    type: ProcessEvent["type"],
    instanceId: string,
    message: string,
  ) {
    const event: ProcessEvent = {
      type,
      instanceId,
      message,
      timestamp: nowIso(),
    };
    this.emit("event", event);
    this.emit(`event:${instanceId}`, event);
  }
}

export const supervisor = new ProcessSupervisor();
