import {
  webappDescriptor,
  type EnvironmentRecord,
  type Webapp,
  type WebappUpdate,
} from "@arriero/core";
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { deleteWebapp, updateWebapp } from "../../api/client";
import { statusColor } from "../components/InstanceHealthBadge";
import {
  envStatusColor,
  envVersionLabel,
  WebappActionButtons,
  WebappConfigDriftBadge,
} from "../components/WebappActionButtons";
import { WebappEditModal } from "../components/WebappEditModal";
import {
  useInvalidateWebapps,
  useWebappActions,
} from "../components/use-webapp-actions";
import { notifyError } from "../utils/notify";
import { countLabel } from "../utils/plural";

export function WebappsListView({
  webapps,
  environments,
  onCreate,
  onOpenDiagnostics,
}: {
  webapps: Webapp[];
  environments: EnvironmentRecord[];
  onCreate: () => void;
  onOpenDiagnostics: (webapp: Webapp) => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWebapps();
  const actions = useWebappActions();
  const [editing, setEditing] = useState<Webapp | null>(null);
  const [deleting, setDeleting] = useState<Webapp | null>(null);
  const [deleteProxySourceChecked, setDeleteProxySourceChecked] =
    useState(true);

  const running = webapps.filter(
    (webapp) => webapp.status === "running",
  ).length;

  const updateMutation = useMutation({
    mutationFn: (input: { name: string; update: WebappUpdate }) =>
      updateWebapp(input.name, input.update),
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
    },
    onError: notifyError("Web app update failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (input: { name: string; deleteProxySource: boolean }) =>
      deleteWebapp(input.name, input.deleteProxySource),
    onSuccess: async () => {
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ["environments"] });
      setDeleting(null);
    },
    onError: notifyError("Delete failed"),
  });

  return (
    <Stack gap="md">
      <Paper withBorder p="md">
        <Group justify="space-between">
          <div>
            <Title order={4}>Installed web apps</Title>
            <Text size="sm" c="dimmed">
              {countLabel(running, "web app")} running of {webapps.length}
            </Text>
          </div>
          <Button onClick={onCreate}>Add web app</Button>
        </Group>
      </Paper>

      <Stack gap="sm">
        {webapps.map((webapp) => (
          <Paper key={webapp.name} withBorder p="md">
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
                      ? envVersionLabel(webapp.envVersion)
                      : `env ${webapp.envStatus}`}
                  </Badge>
                  <WebappConfigDriftBadge webapp={webapp} />
                  {webapp.autostart && <Badge variant="light">autostart</Badge>}
                </Group>
                <Text size="xs" c="dimmed">
                  {webappDescriptor(webapp.kind).displayName} ·{" "}
                  {webapp.http.host}:{webapp.http.port}
                  {webapp.pid ? ` · pid ${webapp.pid}` : ""}
                </Text>
              </div>
              <Group gap="xs">
                <WebappActionButtons webapp={webapp} actions={actions} />
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => onOpenDiagnostics(webapp)}
                >
                  Diagnostics
                </Button>
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
            No web apps yet. Add one — it gets wired to this node's API proxy
            automatically.
          </Text>
        )}
      </Stack>

      {editing && (
        <WebappEditModal
          webapp={editing}
          environments={environments.filter(
            (environment) =>
              environment.engine ===
              webappDescriptor(editing.kind).environmentEngine,
          )}
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
