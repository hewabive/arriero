import {
  OPEN_WEBUI_DEFAULT_PYTHON_VERSION,
  WEBAPP_NAME_PATTERN,
  webappDescriptor,
  type EnvironmentRecord,
  type WebappCreate,
} from "@arriero/core";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { listEnvironmentIndexVersions } from "../../api/client";

const OPEN_WEBUI = webappDescriptor("open-webui");

export type WebappCreateSubmit = {
  input: Omit<WebappCreate, "envSpecId">;
  env:
    | { kind: "existing"; envSpecId: string }
    | { kind: "install"; version: string };
};

export function WebappCreateForm({
  environments,
  submitting,
  onSubmit,
}: {
  environments: EnvironmentRecord[];
  submitting: boolean;
  onSubmit: (submit: WebappCreateSubmit) => void;
}) {
  const [name, setName] = useState("open-webui");
  const [envMode, setEnvMode] = useState<"existing" | "install">(
    environments.length > 0 ? "existing" : "install",
  );
  const [envSpecId, setEnvSpecId] = useState<string | null>(
    environments[0]?.id ?? null,
  );
  const [version, setVersion] = useState("");
  const [port, setPort] = useState<number>(OPEN_WEBUI.http.defaultPort);
  const [lan, setLan] = useState(false);
  const [auth, setAuth] = useState(true);
  const [slim, setSlim] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [createProxySource, setCreateProxySource] = useState(true);

  const versionsQuery = useQuery({
    queryKey: ["webapp-index-versions", OPEN_WEBUI.environmentEngine],
    queryFn: () =>
      listEnvironmentIndexVersions(
        OPEN_WEBUI.environmentEngine,
        OPEN_WEBUI_DEFAULT_PYTHON_VERSION,
      ),
    enabled: envMode === "install",
    staleTime: 120_000,
  });
  const versionOptions = useMemo(
    () =>
      (versionsQuery.data?.data.versions ?? [])
        .filter((entry) => !entry.preRelease)
        .map((entry) => ({ value: entry.version, label: entry.version })),
    [versionsQuery.data],
  );

  const environmentOptions = environments.map((environment) => ({
    value: environment.id,
    label: `${environment.version} (${environment.status})`,
  }));

  const nameValid = WEBAPP_NAME_PATTERN.test(name);
  const envValid =
    envMode === "existing" ? Boolean(envSpecId) : Boolean(version.trim());
  const canSubmit = nameValid && envValid && port >= 1 && port <= 65535;

  function submit() {
    const input: Omit<WebappCreate, "envSpecId"> = {
      name,
      kind: "open-webui",
      http: { host: lan ? "0.0.0.0" : "127.0.0.1", port },
      autostart,
      createProxySource,
      settings: {
        type: "open-webui",
        auth,
        slim,
        defaultModels: [],
        extraEnv: {},
      },
    };
    onSubmit({
      input,
      env:
        envMode === "existing"
          ? { kind: "existing", envSpecId: envSpecId! }
          : { kind: "install", version: version.trim() },
    });
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Title order={4}>Add {OPEN_WEBUI.displayName}</Title>
        <Group grow align="flex-end">
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
        <Group align="flex-end">
          <SegmentedControl
            value={envMode}
            onChange={(value) => setEnvMode(value as "existing" | "install")}
            data={[
              {
                value: "existing",
                label: "Existing environment",
                disabled: environments.length === 0,
              },
              { value: "install", label: "Install new" },
            ]}
          />
          {envMode === "existing" ? (
            <Select
              label="Environment"
              placeholder="Pick an installed environment"
              data={environmentOptions}
              value={envSpecId}
              onChange={setEnvSpecId}
              style={{ flex: 1 }}
            />
          ) : (
            <Select
              label="Version"
              placeholder={
                versionsQuery.isFetching
                  ? "Loading versions…"
                  : "Pick a version"
              }
              searchable
              data={versionOptions}
              value={version || null}
              onChange={(value) => setVersion(value ?? "")}
              style={{ flex: 1 }}
            />
          )}
        </Group>
        <Group gap="lg">
          <Switch
            label="LAN access (listen on 0.0.0.0)"
            checked={lan}
            onChange={(event) => setLan(event.currentTarget.checked)}
          />
          <Switch
            label="Require sign-in"
            checked={auth}
            onChange={(event) => setAuth(event.currentTarget.checked)}
          />
          <Switch
            label="Lightweight mode"
            description="Keeps the local embedding and speech models off — no extra downloads or RAM on top of the ~1 GB the app itself uses"
            checked={slim}
            onChange={(event) => setSlim(event.currentTarget.checked)}
          />
        </Group>
        <Group gap="lg">
          <Switch
            label="Start with the manager"
            checked={autostart}
            onChange={(event) => setAutostart(event.currentTarget.checked)}
          />
          <Checkbox
            label="Create a proxy API key for this app"
            checked={createProxySource}
            onChange={(event) =>
              setCreateProxySource(event.currentTarget.checked)
            }
          />
        </Group>
        {lan && !auth && (
          <Alert color="orange" icon={<TriangleAlert size={16} />}>
            The UI will be reachable from the whole network without sign-in.
          </Alert>
        )}
        <Group justify="space-between">
          {OPEN_WEBUI.installFootprintNote ? (
            <Text size="xs" c="dimmed">
              Note: {OPEN_WEBUI.installFootprintNote}.
            </Text>
          ) : (
            <span />
          )}
          <Button disabled={!canSubmit} loading={submitting} onClick={submit}>
            {envMode === "install" ? "Install and add" : "Add web app"}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
