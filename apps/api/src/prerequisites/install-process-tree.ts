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
    const selected = new Set(
      table
        .filter((entry) =>
          this.known === null
            ? entry.pid === this.pid || entry.group === this.pid
            : this.known.some(
                (known) =>
                  known.pid === entry.pid && known.started === entry.started,
              ),
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
    return this.known.filter(
      (entry) => entry.state !== "Z" && entry.state !== "X",
    );
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
    let remaining = await this.remaining();
    await this.signal(remaining, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (
      (remaining = await this.remaining()).length > 0 &&
      Date.now() < deadline
    ) {
      await setTimeout(50);
    }
    if (remaining.length === 0) return;
    await this.signal(remaining, "SIGKILL");
    const killDeadline = Date.now() + 1000;
    while (
      (remaining = await this.remaining()).length > 0 &&
      Date.now() < killDeadline
    ) {
      await setTimeout(50);
    }
    if (remaining.length > 0)
      throw new Error(
        `Installation processes are still alive: ${remaining.map((entry) => entry.pid).join(", ")}`,
      );
  }
}
