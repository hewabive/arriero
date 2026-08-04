import type { Instance, NumaNode } from "@arriero/core";

import { detectNumaBind, detectNumaInterleave } from "./capability.js";
import { applyNumaPin, buildPinnedShimArgs } from "./cgroup.js";
import { numaIsApplicable, readNumaTopology } from "./topology.js";

type NumaLaunch = {
  binary: string;
  args: string[];
  cgroupDir: string | null;
};

function plain(binary: string, args: string[]): NumaLaunch {
  return { binary, args, cgroupDir: null };
}

export function interleaveSpec(nodes: number[]): string {
  return nodes.length > 0 ? nodes.join(",") : "all";
}

export function buildInterleaveArgs(
  nodes: number[],
  binary: string,
  cliArgs: string[],
): string[] {
  return [`--interleave=${interleaveSpec(nodes)}`, "--", binary, ...cliArgs];
}

export function resolveNumaLaunch(
  instance: Instance,
  binary: string,
  cliArgs: string[],
  topology: NumaNode[] = readNumaTopology(),
): NumaLaunch {
  const numa = instance.numa;
  if (!numa || !numaIsApplicable(topology)) {
    return plain(binary, cliArgs);
  }

  if (numa.mode === "bind") {
    if (!detectNumaBind()) {
      return plain(binary, cliArgs);
    }
    const node = topology.find((entry) => entry.id === numa.node);
    if (!node) {
      throw new Error(`NUMA node ${numa.node} is not present on this host`);
    }
    const cgroupDir = applyNumaPin(instance.name, node);
    return {
      binary: "sh",
      args: buildPinnedShimArgs(`${cgroupDir}/cgroup.procs`, binary, cliArgs),
      cgroupDir,
    };
  }

  if (!detectNumaInterleave()) {
    return plain(binary, cliArgs);
  }
  return {
    binary: "numactl",
    args: buildInterleaveArgs(numa.nodes, binary, cliArgs),
    cgroupDir: null,
  };
}
