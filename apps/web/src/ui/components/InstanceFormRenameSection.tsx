import { Alert, Stack, Text } from "@mantine/core";

import { countLabel } from "../utils/plural";
import { SkipCheckbox } from "./SkipCheckbox";
import type { InstanceFormController } from "./use-instance-form";

export function InstanceFormRenameSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  const cascade = fm.renameCascade;
  if (!cascade) {
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
          <SkipCheckbox
            key={`target:${item.id}`}
            label={`Rename proxy target "${item.from}" to "${item.to}"`}
            skipped={Boolean(fm.renameSkips[`target:${item.id}`])}
            onSkipChange={(skip) => fm.setRenameSkip(`target:${item.id}`, skip)}
          />
        ))}
        {cascade.modelRenames.map((item) => (
          <SkipCheckbox
            key={`model:${item.id}`}
            label={`Rename public model id "${item.from}" to "${item.to}"`}
            description="Clients configured with the old model id will stop resolving it"
            skipped={Boolean(fm.renameSkips[`model:${item.id}`])}
            onSkipChange={(skip) => fm.setRenameSkip(`model:${item.id}`, skip)}
          />
        ))}
      </Stack>
    </Alert>
  );
}
