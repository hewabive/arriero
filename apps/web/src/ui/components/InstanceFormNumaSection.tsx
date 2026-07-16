import {
  Box,
  Checkbox,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";

import { TouchSelect } from "./TouchCombobox";
import { type InstanceFormController } from "./use-instance-form";

type NumaMode = "none" | "bind" | "interleave";

export function InstanceFormNumaSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  if (fm.numaNodes.length <= 1) {
    return null;
  }

  const modeData = [
    { value: "none", label: "None" },
    { value: "bind", label: "Bind", disabled: !fm.numaBind },
    ...(fm.kind === "ktransformers"
      ? []
      : [
          {
            value: "interleave",
            label: "Interleave",
            disabled: !fm.numaInterleave,
          },
        ]),
  ];
  const nodeOptions = fm.numaNodes.map((node) => ({
    value: String(node.id),
    label: `node ${node.id} · ${node.cpuCount} cores`,
  }));

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Box>
          <Text fw={600} size="sm">
            NUMA placement
          </Text>
          <Text c="dimmed" size="xs">
            {fm.kind === "ktransformers"
              ? "Outer binding confines the complete process tree. Configure internal KT thread pools with --kt-threadpool-count and --kt-numa-nodes; manager interleave is intentionally unavailable."
              : "Bind confines CPUs+memory to one node (locality / co-tenancy; needs a delegated cgroup v2 cpuset). Interleave spreads memory across nodes for full bandwidth on big CPU models (needs numactl)."}
          </Text>
        </Box>

        <SegmentedControl
          value={fm.numaMode}
          onChange={(value) => fm.setNumaMode(value as NumaMode)}
          data={modeData}
        />

        {fm.numaMode === "bind" && (
          <>
            <TouchSelect
              label="Node"
              placeholder="Select a node"
              value={fm.numaBindNode === null ? null : String(fm.numaBindNode)}
              onChange={(value) =>
                fm.setNumaBindNode(value === null ? null : Number(value))
              }
              data={nodeOptions}
            />
            {!fm.numaBind && (
              <Text c="yellow" size="xs">
                Pinning is unavailable here (needs cgroup v2 with a delegated
                cpuset controller, manager running inside the user session). The
                binding is stored but not enforced.
              </Text>
            )}
          </>
        )}

        {fm.numaMode === "interleave" && (
          <>
            <Text c="dimmed" size="xs">
              Nodes to interleave across (none selected = all nodes):
            </Text>
            <Checkbox.Group
              value={fm.numaInterleaveNodes.map(String)}
              onChange={(values) =>
                fm.setNumaInterleaveNodes(values.map(Number))
              }
            >
              <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
                {nodeOptions.map((option) => (
                  <Checkbox
                    key={option.value}
                    value={option.value}
                    label={`node ${option.value}`}
                  />
                ))}
              </SimpleGrid>
            </Checkbox.Group>
            <Text c="dimmed" size="xs">
              Tip: also add <code>--numa distribute</code> to arguments for best
              interleave throughput.
            </Text>
            {!fm.numaInterleave && (
              <Text c="yellow" size="xs">
                numactl was not found on this host; interleave is stored but not
                applied.
              </Text>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}
