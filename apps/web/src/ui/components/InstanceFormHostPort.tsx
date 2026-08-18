import { NumberInput, SimpleGrid, TextInput } from "@mantine/core";

import { HostPicker } from "./HostPicker";
import { upsertArgRow } from "./InstanceArgumentRows";
import { type InstanceFormController } from "./use-instance-form";

export function InstanceFormHostPort({ fm }: { fm: InstanceFormController }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
      {fm.kind === "ktransformers" || fm.kind === "sglang" ? (
        <TextInput
          label="Host"
          description="Public access terminates at arriero"
          value="127.0.0.1"
          disabled
        />
      ) : (
        <HostPicker
          label="Host"
          value={fm.hostValue}
          onChange={(value) =>
            fm.setArgRows((rows) =>
              upsertArgRow(rows, "--host", value, "string"),
            )
          }
        />
      )}
      <NumberInput
        label="Port"
        min={1}
        max={65535}
        value={
          typeof fm.portValue === "number" && Number.isFinite(fm.portValue)
            ? fm.portValue
            : ""
        }
        onChange={(value) =>
          fm.setArgRows((rows) =>
            upsertArgRow(
              rows,
              "--port",
              typeof value === "number" ? String(value) : "",
              "number",
            ),
          )
        }
      />
    </SimpleGrid>
  );
}
