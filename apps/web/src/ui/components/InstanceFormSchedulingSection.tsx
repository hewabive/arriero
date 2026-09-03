import type { InstanceEvictionPolicy } from "@arriero/core";
import { Select } from "@mantine/core";

import type { InstanceFormController } from "./use-instance-form";

const EVICTION_POLICIES: Array<{
  value: InstanceEvictionPolicy;
  label: string;
}> = [
  { value: "never", label: "Never evict for another request" },
  { value: "idle-only", label: "Evict only when idle" },
  { value: "preemptible", label: "Allow active-request interruption" },
];

export function InstanceFormSchedulingSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  return (
    <Select
      label="Competing-request eviction limit"
      description="Instance-wide upper limit. Proxy targets may make eviction stricter, but cannot override this limit. Idle-unload timers are separate."
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
