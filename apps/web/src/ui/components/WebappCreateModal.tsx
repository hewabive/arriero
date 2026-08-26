import {
  WEBAPP_KINDS,
  WEBAPP_NAME_PATTERN,
  webappDescriptor,
  type EnvironmentRecord,
  type Webapp,
  type WebappCreate,
  type WebappKind,
  type WebappSettings,
} from "@arriero/core";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import { createWebapp } from "../../api/client";
import { notifyError } from "../utils/notify";
import { useInvalidateWebapps } from "./use-webapp-actions";

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

function preferredEnvironment(
  environments: EnvironmentRecord[],
): string | null {
  return (
    environments.find((environment) => environment.status === "installed")
      ?.id ??
    environments[0]?.id ??
    null
  );
}

export function WebappCreateModal({
  environments,
  onCreated,
  onOpenInstall,
  onClose,
}: {
  environments: EnvironmentRecord[];
  onCreated: (webapp: Webapp) => void;
  onOpenInstall: () => void;
  onClose: () => void;
}) {
  const invalidate = useInvalidateWebapps();
  const [kind, setKind] = useState<WebappKind>("open-webui");
  const environmentsFor = (target: WebappKind) =>
    environments.filter(
      (environment) =>
        environment.engine === webappDescriptor(target).environmentEngine,
    );
  const descriptor = webappDescriptor(kind);
  const kindEnvironments = environmentsFor(kind);

  const [name, setName] = useState("open-webui");
  const [envSpecId, setEnvSpecId] = useState<string | null>(
    preferredEnvironment(kindEnvironments),
  );
  const [port, setPort] = useState<number>(descriptor.http.defaultPort);
  const [lan, setLan] = useState(false);
  const [auth, setAuth] = useState(true);
  const [slim, setSlim] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [createProxySource, setCreateProxySource] = useState(true);

  function switchKind(next: WebappKind) {
    const nextDescriptor = webappDescriptor(next);
    const nextEnvironments = environmentsFor(next);
    setKind(next);
    if (name === kind) {
      setName(next);
    }
    if (port === descriptor.http.defaultPort) {
      setPort(nextDescriptor.http.defaultPort);
    }
    setEnvSpecId(preferredEnvironment(nextEnvironments));
  }

  const createMutation = useMutation({
    mutationFn: (input: WebappCreate) => createWebapp(input),
    onSuccess: async (result) => {
      await invalidate();
      notifications.show({
        title: "Web app added",
        message:
          result.data.envStatus === "installed"
            ? `${result.data.name} is ready to start`
            : `${result.data.name} can start once its environment is installed`,
      });
      onCreated(result.data);
      onClose();
    },
    onError: notifyError("Web app creation failed"),
  });

  const environmentOptions = kindEnvironments.map((environment) => ({
    value: environment.id,
    label: `${environment.version} (${environment.status})`,
  }));

  const nameValid = WEBAPP_NAME_PATTERN.test(name);
  const canSubmit =
    nameValid && Boolean(envSpecId) && port >= 1 && port <= 65535;
  const openWithoutAuth = lan && (!descriptor.builtInSignIn || !auth);

  function submit() {
    createMutation.mutate({
      name,
      kind,
      envSpecId: envSpecId!,
      http: { host: lan ? "0.0.0.0" : "127.0.0.1", port },
      autostart,
      createProxySource,
      settings: defaultSettings(kind, { auth, slim }),
    });
  }

  return (
    <Modal opened onClose={onClose} title="Add web app" size="lg">
      <Stack gap="sm">
        <SegmentedControl
          fullWidth
          value={kind}
          onChange={(value) => switchKind(value as WebappKind)}
          data={WEBAPP_KINDS.map((entry) => ({
            value: entry,
            label: webappDescriptor(entry).displayName,
          }))}
        />
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
        {kindEnvironments.length > 0 ? (
          <Select
            label="Environment"
            description={`An installed ${descriptor.displayName} runtime this app runs on`}
            placeholder="Pick an installed environment"
            data={environmentOptions}
            value={envSpecId}
            onChange={setEnvSpecId}
          />
        ) : (
          <Alert color="blue">
            <Group justify="space-between" align="center">
              No {descriptor.displayName} runtime is installed on this node yet.
              <Button size="xs" variant="light" onClick={onOpenInstall}>
                Open the Install tab
              </Button>
            </Group>
          </Alert>
        )}
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
            {descriptor.builtInSignIn
              ? "The UI will be reachable from the whole network without sign-in."
              : `${descriptor.displayName} has no built-in sign-in — it will be reachable from the whole network.`}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            loading={createMutation.isPending}
            onClick={submit}
          >
            Add web app
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
