import type { PrerequisiteInstallCapability } from "@arriero/core";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ProcessIdentity = {
  pid: number;
  parent: number;
  group: number;
  started: string;
  state: string;
};

function isLive(entry: ProcessIdentity): boolean {
  return entry.state !== "Z" && entry.state !== "X";
}

function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function readProcess(pid: number): Promise<ProcessIdentity | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const started = fields[19];
    if (!state || !started) throw new Error(`Invalid process stat for ${pid}`);
    return {
      pid,
      parent: Number(fields[1]),
      group: Number(fields[2]),
      started,
      state,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw error;
  }
}

export class InstallProcessTree {
  private known: ProcessIdentity[] | null = null;

  constructor(
    private readonly pid: number,
    private readonly method: PrerequisiteInstallCapability["method"],
  ) {}

  private async remaining(): Promise<ProcessIdentity[]> {
    const entries = await readdir("/proc");
    const table = (
      await Promise.all(
        entries
          .filter((entry) => /^\d+$/.test(entry))
          .map((entry) => readProcess(Number(entry))),
      )
    ).filter((entry): entry is ProcessIdentity => entry !== null);
    const knownStarts =
      this.known === null
        ? null
        : new Map(this.known.map((known) => [known.pid, known.started]));
    const selected = new Set(
      table
        .filter((entry) =>
          knownStarts === null
            ? entry.pid === this.pid || entry.group === this.pid
            : knownStarts.get(entry.pid) === entry.started,
        )
        .map((entry) => entry.pid),
    );
    const groups = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of table) {
        if (
          selected.has(entry.pid) ||
          selected.has(entry.parent) ||
          groups.has(entry.group)
        ) {
          if (!selected.has(entry.pid) || !groups.has(entry.group))
            changed = true;
          selected.add(entry.pid);
          groups.add(entry.group);
        }
      }
    }
    this.known = table.filter((entry) => selected.has(entry.pid));
    return this.known.filter(isLive);
  }

  private async anyAlive(processes: ProcessIdentity[]): Promise<boolean> {
    const current = await Promise.all(
      processes.map((entry) => readProcess(entry.pid)),
    );
    if (
      current.some(
        (entry, index) =>
          entry !== null &&
          entry.started === processes[index]?.started &&
          isLive(entry),
      )
    )
      return true;
    return [...new Set(processes.map((entry) => entry.group))].some(
      groupExists,
    );
  }

  private async waitForExit(
    processes: ProcessIdentity[],
    ms: number,
  ): Promise<ProcessIdentity[]> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && (await this.anyAlive(processes))) {
      await setTimeout(50);
    }
    return this.remaining();
  }

  private async signal(
    processes: ProcessIdentity[],
    signal: NodeJS.Signals,
  ): Promise<void> {
    const groups = [
      ...new Set(processes.map((entry) => entry.group)),
    ].reverse();
    for (const group of groups) {
      try {
        if (this.method === "passwordless-sudo") {
          await execFileAsync(
            "sudo",
            ["-n", "kill", "-s", signal, "--", String(-group)],
            { timeout: 5000 },
          );
        } else {
          process.kill(-group, signal);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
        if (!(await this.remaining()).some((entry) => entry.group === group))
          continue;
        throw error;
      }
    }
  }

  async terminate(): Promise<void> {
    const running = await this.remaining();
    await this.signal(running, "SIGTERM");
    const surviving = await this.waitForExit(running, 3000);
    if (surviving.length === 0) return;
    await this.signal(surviving, "SIGKILL");
    const remaining = await this.waitForExit(surviving, 1000);
    if (remaining.length > 0)
      throw new Error(
        `Installation processes are still alive: ${remaining.map((entry) => entry.pid).join(", ")}`,
      );
  }
}
