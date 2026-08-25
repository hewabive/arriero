import {
  isWildcardHost,
  WEBAPP_NAME_PATTERN,
  type EnvironmentRecord,
  type Webapp,
  type WebappUpdate,
} from "@arriero/core";
import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  TagsInput,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useState } from "react";

function extraEnvToLines(extraEnv: Record<string, string>): string {
  return Object.entries(extraEnv)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseExtraEnv(
  text: string,
): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return { error: `expected KEY=VALUE, got "${line}"` };
    }
    env[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return { env };
}

export function WebappEditModal({
  webapp,
  environments,
  saving,
  onSave,
  onClose,
}: {
  webapp: Webapp;
  environments: EnvironmentRecord[];
  saving: boolean;
  onSave: (input: WebappUpdate) => void;
  onClose: () => void;
}) {
  const customHost =
    webapp.http.host !== "127.0.0.1" && !isWildcardHost(webapp.http.host);
  const openWebuiSettings =
    webapp.settings.type === "open-webui" ? webapp.settings : null;
  const [name, setName] = useState(webapp.name);
  const [envSpecId, setEnvSpecId] = useState<string | null>(webapp.envSpecId);
  const [port, setPort] = useState<number>(webapp.http.port);
  const [host, setHost] = useState(webapp.http.host);
  const [lan, setLan] = useState(webapp.http.host !== "127.0.0.1");
  const [auth, setAuth] = useState(openWebuiSettings?.auth ?? true);
  const [slim, setSlim] = useState(openWebuiSettings?.slim ?? true);
  const [autostart, setAutostart] = useState(webapp.autostart);
  const [defaultModels, setDefaultModels] = useState<string[]>(
    openWebuiSettings?.defaultModels ?? [],
  );
  const [extraEnvText, setExtraEnvText] = useState(
    extraEnvToLines(webapp.settings.extraEnv),
  );

  const environmentOptions = environments.map((environment) => ({
    value: environment.id,
    label: `${environment.version} (${environment.status})`,
  }));
  if (
    envSpecId &&
    !environmentOptions.some((option) => option.value === envSpecId)
  ) {
    environmentOptions.push({ value: envSpecId, label: envSpecId });
  }

  const parsedExtraEnv = parseExtraEnv(extraEnvText);
  const extraEnvError = "error" in parsedExtraEnv ? parsedExtraEnv.error : null;
  const nameValid = WEBAPP_NAME_PATTERN.test(name);

  function submit() {
    if ("error" in parsedExtraEnv) {
      return;
    }
    onSave({
      name,
      envSpecId: envSpecId ?? webapp.envSpecId,
      http: {
        host: customHost ? host : lan ? "0.0.0.0" : "127.0.0.1",
        port,
      },
      autostart,
      settings: openWebuiSettings
        ? {
            type: "open-webui",
            auth,
            slim,
            defaultModels,
            extraEnv: parsedExtraEnv.env,
          }
        : {
            type: "chat-ui",
            extraEnv: parsedExtraEnv.env,
          },
    });
  }

  return (
    <Modal opened onClose={onClose} title={`Edit ${webapp.name}`} size="lg">
      <Stack gap="sm">
        <Group grow>
          <TextInput
            label="Name"
            value={name}
            error={
              name && !nameValid
                ? "Letters, digits, dots, dashes and underscores only"
                : null
            }
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <NumberInput
            label="Port"
            min={1}
            max={65535}
            value={port}
            onChange={(value) => setPort(typeof value === "number" ? value : 0)}
          />
        </Group>
        <Select
          label="Environment"
          data={environmentOptions}
          value={envSpecId}
          onChange={setEnvSpecId}
        />
        {customHost && (
          <TextInput
            label="Listen host"
            value={host}
            onChange={(event) => setHost(event.currentTarget.value)}
          />
        )}
        <Group gap="lg">
          {!customHost && (
            <Switch
              label="LAN access (listen on 0.0.0.0)"
              checked={lan}
              onChange={(event) => setLan(event.currentTarget.checked)}
            />
          )}
          {openWebuiSettings && (
            <>
              <Switch
                label="Require sign-in"
                checked={auth}
                onChange={(event) => setAuth(event.currentTarget.checked)}
              />
              <Switch
                label="Lightweight mode"
                checked={slim}
                onChange={(event) => setSlim(event.currentTarget.checked)}
              />
            </>
          )}
          <Switch
            label="Start with the manager"
            checked={autostart}
            onChange={(event) => setAutostart(event.currentTarget.checked)}
          />
        </Group>
        {openWebuiSettings && (
          <TagsInput
            label="Default models"
            description="Model IDs preselected for new chats; leave empty to let the app pick"
            value={defaultModels}
            onChange={setDefaultModels}
          />
        )}
        <Textarea
          label="Extra environment variables"
          description="One KEY=VALUE per line; keys owned by the adapter are rejected"
          autosize
          minRows={2}
          value={extraEnvText}
          error={extraEnvError}
          onChange={(event) => setExtraEnvText(event.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!nameValid || Boolean(extraEnvError)}
            loading={saving}
            onClick={submit}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
