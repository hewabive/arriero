import {
  Group,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  CircleCheck,
} from "lucide-react";
import { useEffect, useRef } from "react";

import {
  checkForUpdate,
  getConfigState,
  getEventLoopReport,
  getPrerequisiteReport,
  getResources,
  getSelfVersion,
  getSourceRepositoryDrift,
  listEngineHelpSources,
  listSourceRepositories,
} from "../../api/client";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";

const AUTO_CHECK_STALE_MS = 15 * 60_000;
const STALL_WINDOW_MS = 24 * 60 * 60_000;
const LOW_DISK_FRACTION = 0.05;
const LOW_DISK_BYTES = 5 * 1024 ** 3;

type AttentionItem = {
  key: string;
  severity: "error" | "warning";
  message: string;
  detail: string | null;
  hash: string;
};

function severityRank(item: AttentionItem) {
  return item.severity === "error" ? 0 : 1;
}

export function AttentionSignalsCard() {
  const queryClient = useQueryClient();
  const versionQuery = useQuery({
    queryKey: ["app-version"],
    queryFn: getSelfVersion,
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
  const configStateQuery = useQuery({
    queryKey: ["config-state"],
    queryFn: getConfigState,
    refetchInterval: 30_000,
  });
  const sourceReposQuery = useQuery({
    queryKey: ["source-repositories"],
    queryFn: listSourceRepositories,
    staleTime: 240_000,
    refetchInterval: 300_000,
  });
  const llamaRepo = (sourceReposQuery.data?.data ?? []).find(
    (repo) => repo.spec.id === "llama-cpp",
  );
  const llamaDriftQuery = useQuery({
    queryKey: ["source-repository-drift", "llama-cpp"],
    queryFn: () => getSourceRepositoryDrift("llama-cpp"),
    enabled: Boolean(
      llamaRepo &&
      llamaRepo.valid &&
      llamaRepo.driftSupported &&
      !llamaRepo.activeOperation,
    ),
    staleTime: 240_000,
    refetchInterval: 300_000,
  });
  const helpSourcesQuery = useQuery({
    queryKey: ["engine-help-sources"],
    queryFn: listEngineHelpSources,
    staleTime: 600_000,
    refetchInterval: 600_000,
  });
  const resourcesQuery = useQuery({
    queryKey: ["resources"],
    queryFn: getResources,
    refetchInterval: 60_000,
  });
  const eventLoopQuery = useQuery({
    queryKey: ["system-event-loop"],
    queryFn: getEventLoopReport,
    refetchInterval: 60_000,
  });
  const prerequisitesQuery = useQuery({
    queryKey: ["prerequisites"],
    queryFn: getPrerequisiteReport,
    staleTime: Infinity,
    retry: false,
  });

  const version = versionQuery.data?.data;
  const autoCheckedRef = useRef(false);
  useEffect(() => {
    if (autoCheckedRef.current || !version?.isGitRepo) {
      return;
    }
    autoCheckedRef.current = true;
    const checkedAt = version.lastCheckedAt
      ? Date.parse(version.lastCheckedAt)
      : Number.NaN;
    if (
      !Number.isFinite(checkedAt) ||
      Date.now() - checkedAt > AUTO_CHECK_STALE_MS
    ) {
      void checkForUpdate()
        .then(() =>
          queryClient.invalidateQueries({ queryKey: ["app-version"] }),
        )
        .catch(() => undefined);
    }
  }, [version, queryClient]);

  const items: AttentionItem[] = [];

  if (version?.updateAvailable) {
    items.push({
      key: "update-available",
      severity: "warning",
      message:
        version.behindCount !== null && version.behindCount > 0
          ? `Arriero update available — ${countLabel(version.behindCount, "commit")} behind`
          : "Arriero update available",
      detail: null,
      hash: "/nodes",
    });
  }

  const configState = configStateQuery.data?.data;
  const quarantined = (configState?.files ?? []).filter(
    (file) => file.error !== null,
  );
  if (quarantined.length > 0) {
    items.push({
      key: "config-quarantined",
      severity: "error",
      message: `${countLabel(quarantined.length, "config file")} quarantined`,
      detail: quarantined.map((file) => file.storeId).join(", "),
      hash: "/config-git",
    });
  }
  if (configState?.dirtyOnDisk) {
    items.push({
      key: "config-dirty",
      severity: "warning",
      message: "Configuration edited on disk — reload to apply",
      detail: null,
      hash: "/config-git",
    });
  }

  for (const repo of sourceReposQuery.data?.data ?? []) {
    if (repo.state === "invalid" || repo.state === "error") {
      items.push({
        key: `source-state-${repo.spec.id}`,
        severity: "warning",
        message: `${repo.displayName} source checkout is ${repo.state}`,
        detail: repo.error,
        hash: "/source-sync",
      });
    }
  }

  const drift = llamaDriftQuery.data?.data;
  if (drift?.status === "drift") {
    const driftedSections = drift.sections.filter(
      (section) => section.status === "drift",
    );
    items.push({
      key: "llama-drift",
      severity: "warning",
      message: "llama.cpp integration drift detected",
      detail:
        driftedSections.map((section) => section.title).join(", ") || null,
      hash: "/source-sync",
    });
  } else if (drift?.status === "error") {
    items.push({
      key: "llama-drift-error",
      severity: "warning",
      message: "llama.cpp drift check failed",
      detail: null,
      hash: "/source-sync",
    });
  }

  for (const sync of helpSourcesQuery.data?.data ?? []) {
    if (sync.inSync === false) {
      items.push({
        key: `help-source-${sync.engineId}`,
        severity: "warning",
        message: `${sync.displayName} argument help snapshot is out of sync`,
        detail: null,
        hash: "/source-sync",
      });
    } else if (
      sync.inSync === null &&
      sync.pendingCommits &&
      sync.pendingCommits.length > 0
    ) {
      items.push({
        key: `help-source-${sync.engineId}`,
        severity: "warning",
        message: `${sync.displayName}: ${countLabel(sync.pendingCommits.length, "upstream commit")} touch argument sources`,
        detail: null,
        hash: "/source-sync",
      });
    }
  }

  const resources = resourcesQuery.data?.data;
  for (const pool of resources?.pools ?? []) {
    if (pool.orphaned) {
      items.push({
        key: `pool-orphaned-${pool.id}`,
        severity: "warning",
        message: `Memory pool ${pool.name} is orphaned — its GPU device is gone`,
        detail: null,
        hash: "/proxy/resources",
      });
    }
  }
  for (const filesystem of resources?.detected.storage?.filesystems ?? []) {
    if (filesystem.totalBytes === null || filesystem.freeBytes === null) {
      continue;
    }
    if (
      filesystem.freeBytes < LOW_DISK_BYTES ||
      filesystem.freeBytes < filesystem.totalBytes * LOW_DISK_FRACTION
    ) {
      items.push({
        key: `disk-${filesystem.mountPath}`,
        severity: "warning",
        message: `Low disk space on ${filesystem.mountPath}`,
        detail: `${formatBytes(filesystem.freeBytes)} free of ${formatBytes(filesystem.totalBytes)}`,
        hash: "/system",
      });
    }
  }

  const stalls = (eventLoopQuery.data?.data.stalls ?? []).filter(
    (stall) => Date.now() - stall.detectedAt < STALL_WINDOW_MS,
  );
  if (stalls.length > 0) {
    const worstMs = Math.max(...stalls.map((stall) => stall.durationMs));
    items.push({
      key: "event-loop-stalls",
      severity: "warning",
      message: `${countLabel(stalls.length, "event-loop stall")} in the last 24 h`,
      detail: `worst ${Math.round(worstMs)} ms`,
      hash: "/system",
    });
  }

  const prerequisiteSummary = prerequisitesQuery.data?.data.summary;
  if (prerequisiteSummary && prerequisiteSummary.unresolvedRequired > 0) {
    items.push({
      key: "prerequisites",
      severity: "error",
      message: `${countLabel(prerequisiteSummary.unresolvedRequired, "required host tool")} missing or unresolved`,
      detail: null,
      hash: "/prerequisites",
    });
  }

  items.sort((a, b) => severityRank(a) - severityRank(b));

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <div className="section-heading">
          <Title order={4}>Attention</Title>
          <Text c="dimmed" size="sm">
            Updates, configuration, source sync and host signals that stand out
          </Text>
        </div>
        {items.length === 0 ? (
          <Group gap="xs" wrap="nowrap">
            <CircleCheck size={16} color="var(--mantine-color-green-6)" />
            <Text c="dimmed" size="sm">
              Nothing unexpected right now
            </Text>
          </Group>
        ) : (
          <Stack gap={2}>
            {items.map((item) => (
              <UnstyledButton
                key={item.key}
                className="dashboard-attention-item"
                onClick={() => {
                  window.location.hash = item.hash;
                }}
              >
                <Group gap="xs" wrap="nowrap">
                  {item.severity === "error" ? (
                    <AlertCircle
                      size={16}
                      color="var(--mantine-color-red-6)"
                      style={{ flexShrink: 0 }}
                    />
                  ) : (
                    <AlertTriangle
                      size={16}
                      color="var(--mantine-color-yellow-7)"
                      style={{ flexShrink: 0 }}
                    />
                  )}
                  <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
                    {item.message}
                    {item.detail && (
                      <Text component="span" c="dimmed" size="xs">
                        {" — "}
                        {item.detail}
                      </Text>
                    )}
                  </Text>
                  <ChevronRight
                    size={14}
                    color="var(--mantine-color-dimmed)"
                    style={{ flexShrink: 0 }}
                  />
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
