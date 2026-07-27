import type {
  ExternalLlamaProcess,
  ExternalLlamaProcessesResult,
  ExternalProcessKillResult,
} from "@arriero/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isPidAlive } from "./pid.js";
import { listOpenProcessRuns } from "./runs-repository.js";

const execFileAsync = promisify(execFile);

type RawProcess = {
  pid: number;
  ppid: number | null;
  command: string;
  args: string;
};

function nowIso() {
  return new Date().toISOString();
}

function isLlamaServerProcess(processInfo: RawProcess) {
  const commandName = processInfo.command.split(/[\\/]/).pop()?.toLowerCase();
  const firstArg = processInfo.args
    .trim()
    .split(/\s+/)[0]
    ?.split(/[\\/]/)
    .pop()
    ?.toLowerCase();
  return Boolean(
    commandName?.includes("llama-server") || firstArg?.includes("llama-server"),
  );
}

function managedRunByPid() {
  return new Map(
    listOpenProcessRuns()
      .map((run) => {
        const pid = run.pid ? Number(run.pid) : null;
        return pid && Number.isFinite(pid) && isPidAlive(pid)
          ? [
              pid,
              {
                instanceId: run.instanceId,
                status: run.status,
              },
            ]
          : null;
      })
      .filter(
        (item): item is [number, { instanceId: string; status: string }] =>
          Boolean(item),
      ),
  );
}

function toExternalProcess(
  raw: RawProcess,
  managed: Map<number, { instanceId: string; status: string }>,
): ExternalLlamaProcess {
  const managedRun = managed.get(raw.pid);
  return {
    pid: raw.pid,
    ppid: raw.ppid,
    command: raw.command,
    args: raw.args,
    managedInstanceId: managedRun?.instanceId ?? null,
    managedRunStatus: managedRun?.status ?? null,
  };
}

function parsePsOutput(stdout: string): RawProcess[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map<RawProcess | null>((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3]!,
        args: match[4]!,
      };
    })
    .filter((item): item is RawProcess => Boolean(item))
    .filter(isLlamaServerProcess);
}

async function listUnixProcesses() {
  const { stdout } = await execFileAsync("ps", [
    "-eo",
    "pid=,ppid=,comm=,args=",
  ]);
  return parsePsOutput(stdout);
}

async function listWindowsProcesses() {
  const command = [
    "$items = Get-CimInstance Win32_Process |",
    "Where-Object { $_.Name -like '*llama-server*' -or $_.CommandLine -like '*llama-server*' } |",
    "Select-Object ProcessId,ParentProcessId,Name,CommandLine;",
    "$items | ConvertTo-Json -Compress",
  ].join(" ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    command,
  ]);
  if (!stdout.trim()) {
    return [];
  }
  const parsed = JSON.parse(stdout) as
    | {
        ProcessId: number;
        ParentProcessId: number | null;
        Name: string | null;
        CommandLine: string | null;
      }
    | Array<{
        ProcessId: number;
        ParentProcessId: number | null;
        Name: string | null;
        CommandLine: string | null;
      }>;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .map((item) => ({
      pid: Number(item.ProcessId),
      ppid:
        item.ParentProcessId === null ||
        !Number.isFinite(Number(item.ParentProcessId))
          ? null
          : Number(item.ParentProcessId),
      command: item.Name ?? "",
      args: item.CommandLine ?? item.Name ?? "",
    }))
    .filter((item) => Number.isFinite(item.pid))
    .filter(isLlamaServerProcess);
}

export async function listExternalLlamaProcesses(): Promise<ExternalLlamaProcessesResult> {
  const managed = managedRunByPid();
  try {
    const raw =
      process.platform === "win32"
        ? await listWindowsProcesses()
        : await listUnixProcesses();
    return {
      processes: raw
        .filter((item) => item.pid !== process.pid)
        .map((item) => toExternalProcess(item, managed))
        .sort((left, right) => left.pid - right.pid),
      scannedAt: nowIso(),
      unsupported: false,
      error: null,
    };
  } catch (error) {
    return {
      processes: [],
      scannedAt: nowIso(),
      unsupported: true,
      error: (error as Error).message,
    };
  }
}

export async function killExternalLlamaProcess(
  pid: number,
  force: boolean,
): Promise<ExternalProcessKillResult> {
  if (pid === process.pid) {
    throw new Error("Refusing to terminate the arriero API process");
  }

  const processes = await listExternalLlamaProcesses();
  if (processes.unsupported) {
    throw new Error(processes.error ?? "Process discovery is unsupported");
  }

  const target = processes.processes.find((item) => item.pid === pid);
  if (!target) {
    throw new Error(`llama-server process not found: pid=${pid}`);
  }
  if (target.managedInstanceId) {
    throw new Error("Use instance controls for processes known to arriero");
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  process.kill(pid, signal);
  return {
    pid,
    signal,
    killed: true,
  };
}
