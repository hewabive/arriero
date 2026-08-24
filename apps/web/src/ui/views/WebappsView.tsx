import {
  webappDescriptor,
  type Webapp,
  type WebappUpdate,
} from "@arriero/core";
import {
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import {
  createEnvironment,
  createWebapp,
  deleteWebapp,
  getWebappLogs,
  getWebappPreflight,
  listEnvironments,
  listWebapps,
  restartWebapp,
  startWebapp,
  stopWebapp,
  updateWebapp,
} from "../../api/client";
import {
  WebappCreateForm,
  type WebappCreateSubmit,
} from "../components/WebappCreateForm";
import { WebappEditModal } from "../components/WebappEditModal";
import { countLabel } from "../utils/plural";

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

function webappUrl(webapp: Webapp): string {
  const host = WILDCARD_HOSTS.has(webapp.http.host)
    ? window.location.hostname
    : webapp.http.host;
  return `http://${host}:${webapp.http.port}/`;
}

function statusColor(status: Webapp["status"]): string {
  if (status === "running") return "green";
  if (status === "starting" || status === "stopping") return "blue";
  if (status === "error" || status === "stale") return "red";
  return "gray";
}

function envStatusColor(status: Webapp["envStatus"]): string {
  if (status === "installed") return "green";
  if (status === "installing") return "blue";
  if (status === "failed" || status === "missing-spec") return "red";
  return "gray";
}

export function WebappsView() {
  const queryClient = useQueryClient();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [editing, setEditing] = useState<Webapp | null>(null);
  const [deleting, setDeleting] = useState<Webapp | null>(null);
  const [deleteProxySourceChecked, setDeleteProxySourceChecked] =
    useState(true);

  const webappsQuery = useQuery({
    queryKey: ["webapps"],
    queryFn: listWebapps,
    refetchInterval: 2_500,
  });
  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: listEnvironments,
    refetchInterval: 5_000,
  });
  const webapps = webappsQuery.data?.data ?? [];
  const openWebuiEnvironments = (environmentsQuery.data?.data ?? []).filter(
    (environment) => environment.engine === "open-webui",
  );

  const selected =
    webapps.find((webapp) => webapp.name === selectedName) ??
    webapps[0] ??
    null;

  const logsQuery = useQuery({
    queryKey: ["webapp-logs", selected?.name],
    queryFn: () => getWebappLogs(selected!.name, 300),
    enabled: Boolean(selected),
    refetchInterval: selected?.status === "running" ? 2_000 : 5_000,
  });
  const preflightQuery = useQuery({
    queryKey: ["webapp-preflight", selected?.name],
    queryFn: () => getWebappPreflight(selected!.name),
    enabled: Boolean(selected),
    refetchInterval: 10_000,
  });
  const preflightWarnings = (preflightQuery.data?.data.issues ?? []).filter(
    (issue) => issue.level === "warning",
  );

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["webapps"] }),
      queryClient.invalidateQueries({ queryKey: ["environments"] }),
    ]);
  }

  function mutationErrorNotification(title: string) {
    return (error: unknown) =>
      notifications.show({
        color: "red",
        title,
        message: (error as Error).message,
      });
  }

  const createMutation = useMutation({
    mutationFn: async (submit: WebappCreateSubmit) => {
      const envSpecId =
        submit.env.kind === "existing"
          ? submit.env.envSpecId
          : (
              await createEnvironment({
                engine: "open-webui",
                version: submit.env.version,
                variant: "cpu",
                pythonVersion: "3.12",
                source: { kind: "pypi", extras: [] },
              })
            ).data.environment.id;
      return createWebapp({ ...submit.input, envSpecId });
    },
    onSuccess: async (result) => {
      await refresh();
      setSelectedName(result.data.name);
      notifications.show({
        title: "Web app added",
        message:
          result.data.envStatus === "installed"
            ? `${result.data.name} is ready to start`
            : `${result.data.name} starts once its environment finishes installing`,
      });
    },
    onError: mutationErrorNotification("Web app creation failed"),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { name: string; update: WebappUpdate }) =>
      updateWebapp(input.name, input.update),
    onSuccess: async (result) => {
      await refresh();
      setEditing(null);
      setSelectedName(result.data.name);
    },
    onError: mutationErrorNotification("Web app update failed"),
  });

  const startMutation = useMutation({
    mutationFn: startWebapp,
    onSuccess: refresh,
    onError: mutationErrorNotification("Start failed"),
  });
  const stopMutation = useMutation({
    mutationFn: stopWebapp,
    onSuccess: refresh,
    onError: mutationErrorNotification("Stop failed"),
  });
  const restartMutation = useMutation({
    mutationFn: restartWebapp,
    onSuccess: refresh,
    onError: mutationErrorNotification("Restart failed"),
  });
  const deleteMutation = useMutation({
    mutationFn: (input: { name: string; deleteProxySource: boolean }) =>
      deleteWebapp(input.name, input.deleteProxySource),
    onSuccess: async () => {
      await refresh();
      setDeleting(null);
    },
    onError: mutationErrorNotification("Delete failed"),
  });

  const actionPending =
    startMutation.isPending ||
    stopMutation.isPending ||
    restartMutation.isPending;

  return (
    <Stack gap="md">
      <WebappCreateForm
        environments={openWebuiEnvironments}
        submitting={createMutation.isPending}
        onSubmit={(submit) => createMutation.mutate(submit)}
      />

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Stack gap="sm">
          {webapps.map((webapp) => (
            <Paper
              key={webapp.name}
              withBorder
              p="md"
              onClick={() => setSelectedName(webapp.name)}
              style={{ cursor: "pointer" }}
            >
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>{webapp.name}</Text>
                    <Badge color={statusColor(webapp.status)}>
                      {webapp.status}
                    </Badge>
                    <Badge
                      variant="light"
                      color={envStatusColor(webapp.envStatus)}
                    >
                      {webapp.envStatus === "installed" && webapp.envVersion
                        ? `v${webapp.envVersion}`
                        : `env ${webapp.envStatus}`}
                    </Badge>
                    {webapp.configDrift && (
                      <Tooltip label="The definition changed since launch; restart to apply">
                        <Badge color="yellow">config drift</Badge>
                      </Tooltip>
                    )}
                    {webapp.autostart && (
                      <Badge variant="light">autostart</Badge>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {webappDescriptor(webapp.kind).displayName} ·{" "}
                    {webapp.http.host}:{webapp.http.port}
                    {webapp.pid ? ` · pid ${webapp.pid}` : ""}
                  </Text>
                </div>
                <Group gap="xs">
                  {webapp.status === "running" && (
                    <Button
                      component="a"
                      href={webappUrl(webapp)}
                      target="_blank"
                      rel="noreferrer"
                      size="xs"
                      variant="light"
                      rightSection={<ExternalLink size={14} />}
                    >
                      Open
                    </Button>
                  )}
                  {webapp.status === "running" ||
                  webapp.status === "starting" ? (
                    <>
                      <Button
                        size="xs"
                        variant="default"
                        disabled={actionPending}
                        onClick={() => restartMutation.mutate(webapp.name)}
                      >
                        Restart
                      </Button>
                      <Button
                        size="xs"
                        color="red"
                        variant="light"
                        disabled={actionPending}
                        onClick={() => stopMutation.mutate(webapp.name)}
                      >
                        Stop
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="xs"
                      disabled={
                        actionPending || webapp.envStatus !== "installed"
                      }
                      onClick={() => startMutation.mutate(webapp.name)}
                    >
                      Start
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setEditing(webapp)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    color="red"
                    variant="subtle"
                    onClick={() => {
                      setDeleteProxySourceChecked(true);
                      setDeleting(webapp);
                    }}
                  >
                    Delete
                  </Button>
                </Group>
              </Group>
            </Paper>
          ))}
          {webapps.length === 0 && (
            <Text c="dimmed">
              No web apps yet. Add one above — it gets wired to this node's API
              proxy automatically.
            </Text>
          )}
        </Stack>

        <Paper withBorder p="md">
          <Group justify="space-between" mb="xs">
            <Title order={4}>
              {selected ? `Log — ${selected.name}` : "Log"}
            </Title>
            {selected && preflightWarnings.length > 0 && (
              <Tooltip
                label={preflightWarnings
                  .map((issue) => issue.message)
                  .join("; ")}
              >
                <Badge color="orange">
                  {countLabel(preflightWarnings.length, "warning")}
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Code
            block
            style={{ whiteSpace: "pre-wrap", maxHeight: 520, overflow: "auto" }}
          >
            {(logsQuery.data?.data.lines ?? ["No web app selected."]).join(
              "\n",
            )}
          </Code>
        </Paper>
      </SimpleGrid>

      {editing && (
        <WebappEditModal
          webapp={editing}
          environments={openWebuiEnvironments}
          saving={updateMutation.isPending}
          onSave={(update) =>
            updateMutation.mutate({ name: editing.name, update })
          }
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <Modal
          opened
          onClose={() => setDeleting(null)}
          title={`Delete ${deleting.name}?`}
        >
          <Stack gap="sm">
            <Text size="sm">
              The process is stopped and the app's data directory (chats, users,
              uploads) is removed. The installed environment stays and can be
              reused.
            </Text>
            {deleting.proxySourceId && (
              <Checkbox
                label="Also delete its proxy API key (request source)"
                checked={deleteProxySourceChecked}
                onChange={(event) =>
                  setDeleteProxySourceChecked(event.currentTarget.checked)
                }
              />
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                color="red"
                loading={deleteMutation.isPending}
                onClick={() =>
                  deleteMutation.mutate({
                    name: deleting.name,
                    deleteProxySource:
                      Boolean(deleting.proxySourceId) &&
                      deleteProxySourceChecked,
                  })
                }
              >
                Delete
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
