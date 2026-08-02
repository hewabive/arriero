import {
  ActionIcon,
  Button,
  Group,
  JsonInput,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { Plus, Trash2 } from "lucide-react";

import { SecretInput } from "./SecretInput";
import { MANAGED_ENV_KEYS } from "./instance-form-helpers";
import { type InstanceFormController } from "./use-instance-form";

export function InstanceFormEnvSection({ fm }: { fm: InstanceFormController }) {
  const rows = fm.customEnvRows;
  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }

  function keyError(rawKey: string): string | null {
    const key = rawKey.trim();
    if (!key) {
      return null;
    }
    if (MANAGED_ENV_KEYS.has(key)) {
      return "Managed in the sections above";
    }
    if ((keyCounts.get(key) ?? 0) > 1) {
      return "Duplicate variable";
    }
    return null;
  }

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div>
            <Text fw={600} size="sm">
              Environment
            </Text>
            <Text c="dimmed" size="xs">
              Extra variables passed to the process. CUDA_VISIBLE_DEVICES and
              HF_TOKEN are managed by the sections above.
            </Text>
          </div>
          <Group gap="xs">
            <Switch
              size="sm"
              label="Raw JSON"
              checked={fm.showEnvRawJson}
              onChange={(event) =>
                fm.setEnvRawJson(event.currentTarget.checked)
              }
            />
            {!fm.showEnvRawJson && (
              <Button
                size="xs"
                variant="light"
                leftSection={<Plus size={14} />}
                onClick={fm.addEnvRow}
              >
                Add variable
              </Button>
            )}
          </Group>
        </Group>

        {fm.showEnvRawJson ? (
          <JsonInput
            minRows={4}
            formatOnBlur
            {...fm.form.getInputProps("envJson")}
          />
        ) : (
          <>
            {rows.length === 0 && (
              <Text c="dimmed" size="xs">
                No custom environment variables.
              </Text>
            )}
            {rows.map((row) => {
              const secret = fm.isSecretEnvKey(row.key);
              return (
                <Group key={row.id} gap="xs" align="flex-start" wrap="nowrap">
                  <TextInput
                    placeholder="NAME"
                    value={row.key}
                    error={keyError(row.key)}
                    onChange={(event) =>
                      fm.updateEnvRow(row.id, {
                        key: event.currentTarget.value,
                      })
                    }
                    style={{ flex: 1 }}
                  />
                  {secret ? (
                    <SecretInput
                      placeholder="value"
                      value={row.value}
                      onChange={(event) =>
                        fm.updateEnvRow(row.id, {
                          value: event.currentTarget.value,
                        })
                      }
                      style={{ flex: 1 }}
                    />
                  ) : (
                    <TextInput
                      placeholder="value"
                      value={row.value}
                      onChange={(event) =>
                        fm.updateEnvRow(row.id, {
                          value: event.currentTarget.value,
                        })
                      }
                      style={{ flex: 1 }}
                    />
                  )}
                  <Tooltip label="Remove">
                    <ActionIcon
                      aria-label="Remove environment variable"
                      color="red"
                      variant="subtle"
                      mt={4}
                      onClick={() => fm.removeEnvRow(row.id)}
                    >
                      <Trash2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              );
            })}
          </>
        )}
      </Stack>
    </Paper>
  );
}
