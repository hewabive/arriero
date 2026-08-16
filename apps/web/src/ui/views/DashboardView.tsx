import type { Instance, InstanceHealthSummary } from "@arriero/core";
import { SimpleGrid, Stack } from "@mantine/core";

import { AttentionSignalsCard } from "../dashboard/AttentionSignalsCard";
import { ProblemInstancesCard } from "../dashboard/ProblemInstancesCard";
import { ProxyActivityCard } from "../dashboard/ProxyActivityCard";

export function DashboardView(props: {
  instances: Instance[];
  healthByInstanceId: Map<string, InstanceHealthSummary>;
  onOpenDiagnostics: (instance: Instance) => void;
}) {
  return (
    <Stack gap="md">
      <AttentionSignalsCard />
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <ProblemInstancesCard
          instances={props.instances}
          healthByInstanceId={props.healthByInstanceId}
          onOpenDiagnostics={props.onOpenDiagnostics}
        />
        <ProxyActivityCard />
      </SimpleGrid>
    </Stack>
  );
}
