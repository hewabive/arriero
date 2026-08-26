import type { NumaNode } from "@arriero/core";
import { readFileSync, readdirSync } from "node:fs";

export function parseCpuListCount(cpulist: string): number {
  let count = 0;
  for (const part of cpulist
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [start, end] = part.split("-");
    const from = Number(start);
    if (end === undefined) {
      if (Number.isInteger(from)) {
        count += 1;
      }
      continue;
    }
    const to = Number(end);
    if (Number.isInteger(from) && Number.isInteger(to) && to >= from) {
      count += to - from + 1;
    }
  }
  return count;
}

export type NodeMeminfo = {
  memTotalBytes: number;
  memFreeBytes: number;
  filePagesBytes: number;
};

const MEM_TOTAL_PATTERN = /MemTotal:\s+(\d+)\s+kB/i;
const MEM_FREE_PATTERN = /MemFree:\s+(\d+)\s+kB/i;
const FILE_PAGES_PATTERN = /FilePages:\s+(\d+)\s+kB/i;

function parseNodeMeminfoField(meminfo: string, pattern: RegExp): number {
  const match = pattern.exec(meminfo);
  return match ? Number(match[1]) * 1024 : 0;
}

export function parseNodeMeminfo(meminfo: string): NodeMeminfo {
  return {
    memTotalBytes: parseNodeMeminfoField(meminfo, MEM_TOTAL_PATTERN),
    memFreeBytes: parseNodeMeminfoField(meminfo, MEM_FREE_PATTERN),
    filePagesBytes: parseNodeMeminfoField(meminfo, FILE_PAGES_PATTERN),
  };
}

export function normalizePciAddress(busId: string): string | null {
  const match = /^([0-9a-f]+):([0-9a-f]{2}):([0-9a-f]{2})\.([0-9a-f])$/.exec(
    busId.trim().toLowerCase(),
  );
  if (!match) {
    return null;
  }
  const domain = match[1]!.slice(-4).padStart(4, "0");
  return `${domain}:${match[2]}:${match[3]}.${match[4]}`;
}

const pciNumaNodes = new Map<string, number | null>();

export function readPciNumaNode(busId: string): number | null {
  const address = normalizePciAddress(busId);
  if (!address) {
    return null;
  }
  const cached = pciNumaNodes.get(address);
  if (cached !== undefined) {
    return cached;
  }
  let node: number | null = null;
  try {
    const raw = readFileSync(
      `/sys/bus/pci/devices/${address}/numa_node`,
      "utf8",
    ).trim();
    const parsed = Number.parseInt(raw, 10);
    node = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    node = null;
  }
  if (pciNumaNodes.size >= 256) {
    pciNumaNodes.clear();
  }
  pciNumaNodes.set(address, node);
  return node;
}

export function numaIsApplicable(topology: NumaNode[]): boolean {
  return topology.length > 1;
}

export function readNumaTopology(): NumaNode[] {
  let entries: string[];
  try {
    entries = readdirSync("/sys/devices/system/node");
  } catch {
    return [];
  }

  const nodes: NumaNode[] = [];
  for (const entry of entries) {
    const match = /^node(\d+)$/.exec(entry);
    if (!match) {
      continue;
    }
    const id = Number(match[1]);
    const base = `/sys/devices/system/node/${entry}`;

    let cpus = "";
    try {
      cpus = readFileSync(`${base}/cpulist`, "utf8").trim();
    } catch {
      cpus = "";
    }

    let meminfo: NodeMeminfo = {
      memTotalBytes: 0,
      memFreeBytes: 0,
      filePagesBytes: 0,
    };
    try {
      meminfo = parseNodeMeminfo(readFileSync(`${base}/meminfo`, "utf8"));
    } catch {
      meminfo = { memTotalBytes: 0, memFreeBytes: 0, filePagesBytes: 0 };
    }

    nodes.push({
      id,
      cpus,
      cpuCount: parseCpuListCount(cpus),
      memoryBytes: meminfo.memTotalBytes,
      memFreeBytes: meminfo.memFreeBytes,
      filePagesBytes: meminfo.filePagesBytes,
      online: true,
    });
  }

  nodes.sort((a, b) => a.id - b.id);
  return nodes;
}
