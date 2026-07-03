import {
  Badge,
  Box,
  Checkbox,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Switch,
  Text,
} from "@mantine/core";

import { type InstanceFormController } from "./use-instance-form";

export function InstanceFormCudaSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  if (fm.cudaAccelerators.length === 0) {
    return null;
  }
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        {fm.singleCudaAccelerator ? (
          <>
            <Group justify="space-between" align="flex-start">
              <Box>
                <Text fw={600} size="sm">
                  CUDA visibility
                </Text>
                <Text c="dimmed" size="xs">
                  GPU {fm.singleCudaAccelerator.id} ·{" "}
                  {fm.singleCudaAccelerator.name}
                </Text>
              </Box>
              <Switch
                label="Use GPU"
                checked={fm.singleCudaEnabled}
                onChange={(event) =>
                  fm.applySingleCudaVisibility(event.currentTarget.checked)
                }
              />
            </Group>
            <Text c="dimmed" size="xs">
              {fm.singleCudaEnabled
                ? "CUDA_VISIBLE_DEVICES is not set here; the process can use the detected GPU."
                : "CUDA_VISIBLE_DEVICES is empty; CUDA devices are hidden from this process."}
            </Text>
          </>
        ) : (
          <>
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <div>
                <Text fw={600} size="sm">
                  CUDA visibility
                </Text>
                <Text c="dimmed" size="xs">
                  Select GPUs visible to this instance process.
                </Text>
              </div>
              <Badge color="green" variant="light">
                {fm.cudaAccelerators.length} GPU
              </Badge>
            </Group>
            <Checkbox.Group
              value={fm.visibleCudaDeviceIds}
              onChange={fm.applyCudaDevices}
            >
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                {fm.cudaDeviceOptions.map((option) => (
                  <Checkbox
                    key={option.value}
                    value={option.value}
                    label={option.label}
                  />
                ))}
              </SimpleGrid>
            </Checkbox.Group>
            <Text c="dimmed" size="xs">
              {fm.cudaMode === "none"
                ? "CUDA_VISIBLE_DEVICES is empty; CUDA devices are hidden from this process."
                : fm.cudaMode === "all"
                  ? "CUDA_VISIBLE_DEVICES is not set here; all detected GPUs are visible."
                  : `CUDA_VISIBLE_DEVICES=${fm.selectedCudaDevices.join(",")}`}
            </Text>
          </>
        )}
      </Stack>
    </Paper>
  );
}
