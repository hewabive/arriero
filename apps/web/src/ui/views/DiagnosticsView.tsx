import type { Instance, InstanceHealthSummary } from "@arriero/core";
import { Stack } from "@mantine/core";

import { InstanceDetails } from "../components/InstanceDetails";
import { TouchSelect } from "../components/TouchCombobox";
import type { LaunchMonitor } from "../utils/launch";

export function DiagnosticsView(props: {
  instances: Instance[];
  selectedInstance: Instance | null;
  selectedHealth: InstanceHealthSummary | null | undefined;
  launchMonitor: LaunchMonitor | null;
  monitorNowMs: number;
  onSelect: (instanceId: string) => void;
  onLaunchStopped: (instance: Instance) => void;
}) {
  return (
    <Stack gap="md">
      <TouchSelect
        label="Instance"
        data={props.instances.map((instance) => ({
          value: instance.name,
          label: instance.name,
        }))}
        value={props.selectedInstance?.name ?? null}
        searchable
        disabled={props.instances.length === 0}
        onChange={(value) => {
          if (value) {
            props.onSelect(value);
          }
        }}
      />

      <InstanceDetails
        instance={props.selectedInstance}
        health={props.selectedHealth}
        launchMonitor={props.launchMonitor}
        monitorNowMs={props.monitorNowMs}
        onLaunchStopped={props.onLaunchStopped}
      />
    </Stack>
  );
}
