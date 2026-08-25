import type { Instance, InstanceResourceProfile } from "@arriero/core";
import { Badge, Group, Stack, Tooltip } from "@mantine/core";

import { hasConfiguredArg, launchModeFromArgs } from "./instance-form-helpers";

type RoleBadge = { label: string; color: string; tooltip: string };

function instanceRole(instance: Instance): RoleBadge {
  if (instance.kind === "rpc-worker") {
    return {
      label: "rpc-worker",
      color: "indigo",
      tooltip: "RPC backend worker",
    };
  }
  const mode = launchModeFromArgs(instance.args);
  if (mode === "router") {
    return {
      label: "router",
      color: "teal",
      tooltip: "Preset router (--models-preset)",
    };
  }
  if (mode === "remote") {
    if (hasConfiguredArg(instance.args, "--hf-repo")) {
      return {
        label: "HF",
        color: "grape",
        tooltip: "Remote HuggingFace model (--hf-repo)",
      };
    }
    return {
      label: "URL",
      color: "grape",
      tooltip: "Remote model URL (--model-url)",
    };
  }
  return {
    label: "single",
    color: "blue",
    tooltip: "Single local model (--model)",
  };
}

type Chip = { key: string; label: string; tooltip: string };

function computeChips(profile: InstanceResourceProfile | undefined): Chip[] {
  if (!profile) {
    return [];
  }
  const chips: Chip[] = profile.gpuPools.map((pool) => ({
    key: `gpu:${pool.poolId ?? pool.label}`,
    label: pool.label,
    tooltip: pool.poolId ? `GPU pool ${pool.poolId}` : pool.label,
  }));
  if (profile.placement === "cpu" || profile.usesHost) {
    chips.push({
      key: "cpu",
      label: "CPU",
      tooltip: profile.cpuReason ?? "Host compute",
    });
  }
  return chips;
}

function numaChip(instance: Instance): Chip | null {
  const numa = instance.numa;
  if (!numa) {
    return null;
  }
  if (numa.mode === "bind") {
    return {
      key: "numa",
      label: `numa bind ${numa.node}`,
      tooltip: `NUMA: CPUs and memory bound to node ${numa.node}`,
    };
  }
  const nodes = numa.nodes.length > 0 ? numa.nodes.join("/") : "all";
  return {
    key: "numa",
    label: `numa il ${nodes}`,
    tooltip: `NUMA: memory interleaved across ${
      nodes === "all" ? "all nodes" : `nodes ${nodes}`
    }`,
  };
}

function envChip(instance: Instance): Chip | null {
  const keys = Object.keys(instance.env);
  if (keys.length === 0) {
    return null;
  }
  return {
    key: "env",
    label: `env ×${keys.length}`,
    tooltip: keys.join(", "),
  };
}

export function InstanceTypeCell(props: {
  instance: Instance;
  profile: InstanceResourceProfile | undefined;
}) {
  const role = instanceRole(props.instance);
  const chips = [
    ...computeChips(props.profile),
    numaChip(props.instance),
    envChip(props.instance),
  ].filter((chip): chip is Chip => chip !== null);

  return (
    <Stack className="instance-type-cell" gap={4} align="flex-start">
      <Tooltip label={role.tooltip} withArrow>
        <Badge color={role.color} variant="light" tt="none">
          {role.label}
        </Badge>
      </Tooltip>
      <Group className="instance-type-chips" gap={4}>
        {chips.map((chip) => (
          <Tooltip
            key={chip.key}
            label={chip.tooltip}
            withArrow
            multiline
            maw={360}
            interactive
          >
            <Badge variant="default" size="xs" tt="none">
              {chip.label}
            </Badge>
          </Tooltip>
        ))}
      </Group>
    </Stack>
  );
}
