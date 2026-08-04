import type { EnvironmentRepositorySettings } from "@arriero/core";
import {
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useState } from "react";

export function EnvironmentRepositorySettingsForm({
  settings,
  running,
  saving,
  onSave,
}: {
  settings: EnvironmentRepositorySettings;
  running: boolean;
  saving: boolean;
  onSave: (settings: EnvironmentRepositorySettings) => void;
}) {
  const [packageIndexUrl, setPackageIndexUrl] = useState(
    settings.packageIndexUrl ?? "",
  );
  const [pythonMirrorUrl, setPythonMirrorUrl] = useState(
    settings.pythonMirrorUrl ?? "",
  );

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="md">
        <div>
          <Text fw={600}>Python repositories</Text>
          <Text size="xs" c="dimmed">
            One site-level source profile is used by every new environment and
            rebuild.
          </Text>
        </div>
        <Button
          size="xs"
          loading={saving}
          disabled={running}
          onClick={() =>
            onSave({
              packageIndexUrl: packageIndexUrl.trim() || null,
              pythonMirrorUrl: pythonMirrorUrl.trim() || null,
            })
          }
        >
          Save repositories
        </Button>
      </Group>

      <Stack gap="sm">
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <TextInput
            label="Python package index"
            description="Simple API index used for roots and dependencies; leave blank for uv's default"
            placeholder="https://packages.example/simple"
            value={packageIndexUrl}
            onChange={(event) => setPackageIndexUrl(event.currentTarget.value)}
          />
          <TextInput
            label="Managed Python mirror"
            description="uv python-build-standalone mirror; leave blank for uv's default"
            placeholder="https://python.example/python-build-standalone"
            value={pythonMirrorUrl}
            onChange={(event) => setPythonMirrorUrl(event.currentTarget.value)}
          />
        </SimpleGrid>
        {running && (
          <Text size="xs" c="orange">
            Repository settings cannot change while an environment job is
            running.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
