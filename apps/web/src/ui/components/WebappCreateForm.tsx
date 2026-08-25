import {
  CHAT_UI_DEFAULT_VERSION,
  OPEN_WEBUI_DEFAULT_PYTHON_VERSION,
  WEBAPP_KINDS,
  WEBAPP_NAME_PATTERN,
  webappDescriptor,
  type EnvironmentRecord,
  type WebappCreate,
  type WebappKind,
  type WebappSettings,
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

export type WebappCreateSubmit = {
  input: Omit<WebappCreate, "envSpecId">;
  env:
    | { kind: "existing"; envSpecId: string }
    | { kind: "install"; version: string };
};

function defaultSettings(
  kind: WebappKind,
  options: { auth: boolean; slim: boolean },
): WebappSettings {
  if (kind === "chat-ui") {
    return { type: "chat-ui", extraEnv: {} };
  }
  return {
    type: "open-webui",
    auth: options.auth,
    slim: options.slim,
    defaultModels: [],
    extraEnv: {},
  };
}

export function WebappCreateForm({
  environments,
  submitting,
  onSubmit,
}: {
  environments: EnvironmentRecord[];
  submitting: boolean;
  onSubmit: (submit: WebappCreateSubmit) => void;
}) {
  const [kind, setKind] = useState<WebappKind>("open-webui");
  const descriptor = webappDescriptor(kind);
  const kindEnvironments = environments.filter(
    (environment) => environment.engine === descriptor.environmentEngine,
  );

  const [name, setName] = useState("open-webui");
  const [envMode, setEnvMode] = useState<"existing" | "install">(
    kindEnvironments.length > 0 ? "existing" : "install",
  );
  const [envSpecId, setEnvSpecId] = useState<string | null>(
    kindEnvironments[0]?.id ?? null,
  );
  const [version, setVersion] = useState("");
  const [port, setPort] = useState<number>(descriptor.http.defaultPort);
  const [lan, setLan] = useState(false);
  const [auth, setAuth] = useState(true);
  const [slim, setSlim] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [createProxySource, setCreateProxySource] = useState(true);

  function switchKind(next: WebappKind) {
    const nextDescriptor = webappDescriptor(next);
    const nextEnvironments = environments.filter(
      (environment) => environment.engine === nextDescriptor.environmentEngine,
    );
    setKind(next);
    if (name === kind) {
      setName(next);
    }
    if (port === descriptor.http.defaultPort) {
      setPort(nextDescriptor.http.defaultPort);
    }
    setEnvMode(nextEnvironments.length > 0 ? "existing" : "install");
    setEnvSpecId(nextEnvironments[0]?.id ?? null);
    setVersion(next === "chat-ui" ? CHAT_UI_DEFAULT_VERSION : "");
  }

  const versionsQuery = useQuery({
    queryKey: ["webapp-index-versions", descriptor.environmentEngine],
    queryFn: () =>
      listEnvironmentIndexVersions(
        descriptor.environmentEngine,
        OPEN_WEBUI_DEFAULT_PYTHON_VERSION,
      ),
    enabled: envMode === "install" && kind === "open-webui",
    staleTime: 120_000,
  });
  const versionOptions = useMemo(
    () =>
      (versionsQuery.data?.data.versions ?? [])
        .filter((entry) => !entry.preRelease)
        .map((entry) => ({ value: entry.version, label: entry.version })),
    [versionsQuery.data],
  );

  const environmentOptions = kindEnvironments.map((environment) => ({
    value: environment.id,
    label: `${environment.version} (${environment.status})`,
  }));

  const nameValid = WEBAPP_NAME_PATTERN.test(name);
  const envValid =
    envMode === "existing" ? Boolean(envSpecId) : Boolean(version.trim());
  const canSubmit = nameValid && envValid && port >= 1 && port <= 65535;
  const openWithoutAuth = lan && (kind === "chat-ui" || !auth);

  function submit() {
    const input: Omit<WebappCreate, "envSpecId"> = {
      name,
      kind,
      http: { host: lan ? "0.0.0.0" : "127.0.0.1", port },
      autostart,
      createProxySource,
      settings: defaultSettings(kind, { auth, slim }),
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
        <Group justify="space-between" align="baseline">
          <Title order={4}>Add {descriptor.displayName}</Title>
          <SegmentedControl
            value={kind}
            onChange={(value) => switchKind(value as WebappKind)}
            data={WEBAPP_KINDS.map((entry) => ({
              value: entry,
              label: webappDescriptor(entry).displayName,
            }))}
          />
        </Group>
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
                disabled: kindEnvironments.length === 0,
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
          ) : kind === "chat-ui" ? (
            <TextInput
              label="Git ref"
              description="Tag or branch of huggingface/chat-ui; built from source"
              value={version}
              onChange={(event) => setVersion(event.currentTarget.value)}
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
          {kind === "open-webui" && (
            <>
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
            </>
          )}
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
        {openWithoutAuth && (
          <Alert color="orange" icon={<TriangleAlert size={16} />}>
            {kind === "chat-ui"
              ? "Chat UI has no built-in sign-in — it will be reachable from the whole network."
              : "The UI will be reachable from the whole network without sign-in."}
          </Alert>
        )}
        <Group justify="space-between">
          {descriptor.installFootprintNote ? (
            <Text size="xs" c="dimmed">
              Note: {descriptor.installFootprintNote}.
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
