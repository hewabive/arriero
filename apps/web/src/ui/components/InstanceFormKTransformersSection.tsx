import type { KTransformersMethod } from "@arriero/core";
import {
  Autocomplete,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";

import type { InstanceFormController } from "./use-instance-form";

const METHODS: KTransformersMethod[] = [
  "AMXINT4",
  "AMXINT8",
  "RAWINT4",
  "FP8",
  "FP8_PERCHANNEL",
  "BF16",
  "LLAMAFILE",
];

export function InstanceFormKTransformersSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <div>
          <Text fw={600} size="sm">
            KTransformers model bundle
          </Text>
          <Text c="dimmed" size="xs">
            The SGLang/Hugging Face model and CPU expert weights are managed
            fields. Advanced SGLang and --kt-* options remain below.
          </Text>
        </div>
        <Autocomplete
          label="Model"
          required
          description="Hugging Face owner/model id or an existing local model directory"
          placeholder="deepseek-ai/DeepSeek-V3"
          data={fm.safetensorsPathOptions}
          limit={20}
          value={fm.modelReference}
          onChange={fm.setModelReference}
        />
        <TextInput
          label="CPU weights"
          required
          description="Existing converted weights, native weights, or LLAMAFILE/GGUF directory"
          placeholder="/models/deepseek-v3-cpu"
          value={fm.ktransformersCpuWeights}
          onChange={(event) =>
            fm.setKTransformersCpuWeights(event.currentTarget.value)
          }
        />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label="CPU method"
            required
            data={METHODS}
            value={fm.ktransformersMethod}
            onChange={(value) =>
              fm.setKTransformersMethod((value ?? "FP8") as KTransformersMethod)
            }
          />
          <TextInput
            label="Served model name"
            description="Optional stable public model identity"
            placeholder="deepseek-v3"
            value={fm.ktransformersServedModelName}
            onChange={(event) =>
              fm.setKTransformersServedModelName(event.currentTarget.value)
            }
          />
        </SimpleGrid>
        {fm.cudaAccelerators.length === 0 && (
          <Text c="red" size="xs">
            No supported NVIDIA GPU was detected. The configuration can be saved
            for another host, but preflight will block launch here.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
