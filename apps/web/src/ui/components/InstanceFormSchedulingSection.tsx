import type { InstanceEvictionPolicy } from "@arriero/core";
import { Select } from "@mantine/core";

import type { InstanceFormController } from "./use-instance-form";

const EVICTION_POLICIES: Array<{
  value: InstanceEvictionPolicy;
  label: string;
}> = [
  { value: "idle-only", label: "Idle only" },
  { value: "never", label: "Never evict" },
  { value: "preemptible", label: "Preemptible" },
];

export function InstanceFormSchedulingSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  return (
    <Select
      label="Eviction policy"
      description="Whether the proxy scheduler may stop this process for a competing target: idle-only drains active requests first, preemptible allows immediate takeover, never keeps it running"
      data={EVICTION_POLICIES}
      value={fm.evictionPolicy}
      onChange={(value) =>
        fm.setEvictionPolicy(
          (value ?? fm.evictionPolicy) as InstanceEvictionPolicy,
        )
      }
    />
  );
}
