import type { EnvironmentCreate } from "@llama-manager/core";
import {
  Badge,
  Button,
  Code,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  cancelEnvironmentJob,
  createEnvironment,
  deleteEnvironment,
  getEnvironmentJobLogs,
  getSystemResources,
  listEnvironmentJobs,
  listEnvironments,
  rebuildEnvironment,
} from "../../api/client";
import { formatLocalDateTime } from "../utils/time";

function statusColor(status: string) {
  if (status === "installed" || status === "succeeded") return "green";
  if (status === "installing" || status === "running") return "blue";
  if (status === "failed") return "red";
  if (status === "canceled") return "orange";
  return "gray";
}

export function EnvironmentsView() {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState("");
  const [variant, setVariant] = useState<"cuda" | "cpu" | "rocm">("cuda");
  const [pythonVersion, setPythonVersion] = useState("3.12");
  const [requireExistingPython, setRequireExistingPython] = useState(false);
  const [pythonMirrorUrl, setPythonMirrorUrl] = useState("");
  const [sourceKind, setSourceKind] = useState<"pypi" | "wheel">("pypi");
  const [extras, setExtras] = useState("");
  const [indexUrl, setIndexUrl] = useState("");
  const [wheelUrl, setWheelUrl] = useState("");
  const [wheelSha256, setWheelSha256] = useState("");
  const [dependencyIndexUrl, setDependencyIndexUrl] = useState("");
  const [torchBackend, setTorchBackend] = useState("");

  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: listEnvironments,
    refetchInterval: 2_500,
  });
  const jobsQuery = useQuery({
    queryKey: ["environment-jobs"],
    queryFn: () => listEnvironmentJobs(12),
    refetchInterval: 2_000,
  });
  const systemQuery = useQuery({
    queryKey: ["system-resources"],
    queryFn: getSystemResources,
    staleTime: 30_000,
  });
  const environments = environmentsQuery.data?.data ?? [];
  const jobs = jobsQuery.data?.data ?? [];
  const selectedJob = jobs.find((job) => job.status === "running") ?? jobs[0] ?? null;
  const logsQuery = useQuery({
    queryKey: ["environment-job-logs", selectedJob?.id],
    queryFn: () => getEnvironmentJobLogs(selectedJob!.id, 300),
    enabled: Boolean(selectedJob),
    refetchInterval: selectedJob?.status === "running" ? 1_500 : false,
  });
  const running = jobs.some((job) => job.status === "running");
  const uv = systemQuery.data?.data.tools?.uv;

  const createInput = useMemo<EnvironmentCreate>(() => ({
    engine: "vllm",
    version: version.trim(),
    variant,
    pythonVersion: pythonVersion.trim(),
    pythonProvisioning: pythonMirrorUrl.trim()
      ? "mirror"
      : requireExistingPython
        ? "require-existing"
        : "download-if-missing",
    pythonMirrorUrl: pythonMirrorUrl.trim() || null,
    source:
      sourceKind === "pypi"
        ? {
            kind: "pypi",
            extras: extras.split(",").map((item) => item.trim()).filter(Boolean),
            indexUrl: indexUrl.trim() || null,
          }
        : {
            kind: "wheel",
            url: wheelUrl.trim(),
            sha256: wheelSha256.trim() || null,
            dependencyIndexUrl: dependencyIndexUrl.trim() || null,
            torchBackend: torchBackend.trim() || null,
          },
  }), [version, variant, pythonVersion, requireExistingPython, pythonMirrorUrl, sourceKind, extras, indexUrl, wheelUrl, wheelSha256, dependencyIndexUrl, torchBackend]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["environments"] }),
      queryClient.invalidateQueries({ queryKey: ["environment-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["path-catalog"] }),
    ]);
  }

  const createMutation = useMutation({
    mutationFn: () => createEnvironment(createInput),
    onSuccess: async () => {
      await refresh();
      notifications.show({ title: "Environment install started", message: `vLLM ${version}` });
    },
    onError: (error) => notifications.show({ color: "red", title: "Install failed", message: (error as Error).message }),
  });
  const rebuildMutation = useMutation({
    mutationFn: rebuildEnvironment,
    onSuccess: refresh,
    onError: (error) => notifications.show({ color: "red", title: "Rebuild failed", message: (error as Error).message }),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteEnvironment,
    onSuccess: refresh,
    onError: (error) => notifications.show({ color: "red", title: "Delete failed", message: (error as Error).message }),
  });
  const cancelMutation = useMutation({
    mutationFn: cancelEnvironmentJob,
    onSuccess: refresh,
  });

  return (
    <Stack gap="md">
      <Paper withBorder p="md">
        <Group justify="space-between" mb="md">
          <Text fw={600}>Create immutable environment</Text>
          <Badge color={uv?.available ? "green" : "red"} variant="light">
            {uv?.available ? uv.version ?? "uv available" : "uv unavailable"}
          </Badge>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="vLLM version" required value={version} onChange={(event) => setVersion(event.currentTarget.value)} placeholder="0.24.0" />
          <TextInput label="Python version" required value={pythonVersion} onChange={(event) => setPythonVersion(event.currentTarget.value)} />
        </SimpleGrid>
        <Switch
          mt="sm"
          checked={requireExistingPython}
          onChange={(event) => setRequireExistingPython(event.currentTarget.checked)}
          label="Offline: require an existing uv-managed Python runtime"
          description="Fail before installation instead of downloading Python from the public runtime registry"
        />
        <TextInput
          mt="sm"
          label="Python runtime mirror URL"
          description="Optional airgap bundle/python-runtime-mirror file or HTTP URL; takes precedence over the switch above"
          placeholder="file:///media/airgap-bundle/python-runtime-mirror"
          value={pythonMirrorUrl}
          onChange={(event) => setPythonMirrorUrl(event.currentTarget.value)}
        />
        <SegmentedControl
          mt="sm"
          value={variant}
          onChange={(value) => setVariant(value as "cuda" | "cpu" | "rocm")}
          data={[{ label: "CUDA", value: "cuda" }, { label: "CPU", value: "cpu" }, { label: "ROCm", value: "rocm" }]}
        />
        <SegmentedControl mt="sm" value={sourceKind} onChange={(value) => setSourceKind(value as "pypi" | "wheel")} data={[{ label: "PyPI", value: "pypi" }, { label: "Wheel URL", value: "wheel" }]} />
        {sourceKind === "pypi" ? (
          <SimpleGrid mt="sm" cols={{ base: 1, sm: 2 }}>
            <TextInput label="Extras" description="Comma-separated" value={extras} onChange={(event) => setExtras(event.currentTarget.value)} />
            <TextInput label="Index URL" description="Credentials are rejected" value={indexUrl} onChange={(event) => setIndexUrl(event.currentTarget.value)} />
          </SimpleGrid>
        ) : (
          <Stack mt="sm" gap="sm">
            <TextInput label="Wheel URL" required value={wheelUrl} onChange={(event) => setWheelUrl(event.currentTarget.value)} />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="SHA-256" value={wheelSha256} onChange={(event) => setWheelSha256(event.currentTarget.value)} />
              <TextInput label="Torch backend" placeholder="cpu" value={torchBackend} onChange={(event) => setTorchBackend(event.currentTarget.value)} />
            </SimpleGrid>
            <TextInput label="Dependency index URL" description="Use the closed-network index for wheel dependencies" value={dependencyIndexUrl} onChange={(event) => setDependencyIndexUrl(event.currentTarget.value)} />
          </Stack>
        )}
        <Button mt="md" loading={createMutation.isPending} disabled={running || !uv?.available || !version.trim()} onClick={() => createMutation.mutate()}>
          Create environment
        </Button>
      </Paper>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Stack gap="sm">
          {environments.map((environment) => (
            <Paper key={environment.id} withBorder p="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs"><Text fw={600}>vLLM {environment.version}</Text><Badge>{environment.variant}</Badge><Badge color={statusColor(environment.status)}>{environment.status}</Badge><Badge color={environment.availability === "usable" ? "green" : environment.availability === "unavailable" ? "red" : "gray"}>{environment.availability}</Badge></Group>
                  <Text size="xs" c="dimmed">Python {environment.pythonVersion} · {environment.pythonProvisioning} · {formatLocalDateTime(environment.createdAt)}</Text>
                  {environment.availabilityReason && <Text c="orange" size="xs">{environment.availabilityReason}</Text>}
                </div>
                <Group gap="xs">
                  {environment.status !== "installed" && <Button size="xs" variant="light" disabled={running} onClick={() => rebuildMutation.mutate(environment.id)}>Rebuild</Button>}
                  <Button size="xs" color="red" variant="subtle" disabled={environment.status === "installing"} onClick={() => deleteMutation.mutate(environment.id)}>Delete</Button>
                </Group>
              </Group>
              <Code block mt="sm">{environment.entrypoint}</Code>
              {environment.error && <Text c="red" size="xs" mt="xs">{environment.error}</Text>}
            </Paper>
          ))}
          {environments.length === 0 && <Text c="dimmed">No managed Python environments.</Text>}
        </Stack>
        <Paper withBorder p="md">
          <Group justify="space-between" mb="xs">
            <Text fw={600}>Environment job log</Text>
            <Group gap="xs">
              <Badge color={statusColor(selectedJob?.status ?? "idle")}>{selectedJob?.status ?? "idle"}</Badge>
              {selectedJob?.status === "running" && <Button size="xs" color="red" variant="light" onClick={() => cancelMutation.mutate(selectedJob.id)}>Cancel</Button>}
            </Group>
          </Group>
          <Code block style={{ whiteSpace: "pre-wrap", maxHeight: 520, overflow: "auto" }}>
            {(logsQuery.data?.data.lines ?? ["No job selected."]).join("\n")}
          </Code>
        </Paper>
      </SimpleGrid>
    </Stack>
  );
}
