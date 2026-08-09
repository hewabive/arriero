import { Alert, Checkbox, Stack, Text } from "@mantine/core";

import { countLabel } from "../utils/plural";
import type { InstanceFormController } from "./use-instance-form";

export function InstanceFormRenameSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  const cascade = fm.renameCascade;
  if (!fm.isEdit || !cascade) {
    return null;
  }
  const live =
    cascade.instanceStatus === "running" ||
    cascade.instanceStatus === "starting" ||
    cascade.instanceStatus === "stopping" ||
    cascade.instanceStatus === "stale";
  return (
    <Alert color="blue" variant="light" p="sm">
      <Stack gap="xs">
        {cascade.nameChanged && (
          <Text size="xs">
            Renaming re-points{" "}
            {countLabel(cascade.referencingTargetCount, "proxy target")}, run
            history and saved slots to the new name automatically.
          </Text>
        )}
        {cascade.nameChanged && live && (
          <Text size="xs" c="yellow">
            The instance is {cascade.instanceStatus} — stop it first, renaming a
            live instance is rejected.
          </Text>
        )}
        {cascade.targetRenames.map((item) => (
          <Checkbox
            key={`target:${item.id}`}
            size="xs"
            label={`Rename proxy target "${item.from}" to "${item.to}"`}
            checked={!fm.renameSkips[`target:${item.id}`]}
            onChange={(event) => {
              const skip = !event.currentTarget.checked;
              fm.setRenameSkip(`target:${item.id}`, skip);
            }}
          />
        ))}
        {cascade.modelRenames.map((item) => (
          <Checkbox
            key={`model:${item.id}`}
            size="xs"
            label={`Rename public model id "${item.from}" to "${item.to}"`}
            description="Clients configured with the old model id will stop resolving it"
            checked={!fm.renameSkips[`model:${item.id}`]}
            onChange={(event) => {
              const skip = !event.currentTarget.checked;
              fm.setRenameSkip(`model:${item.id}`, skip);
            }}
          />
        ))}
      </Stack>
    </Alert>
  );
}
