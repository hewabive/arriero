import { type Instance } from "@arriero/core";
import {
  ActionIcon,
  Alert,
  AppShell,
  Burger,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Moon, RefreshCw, Search, ServerOff, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  getApiProxyStats,
  getAuthState,
  listInstanceHealthSummaries,
  listInstances,
  logoutAdmin,
} from "../api/client";
import { AppLogo } from "./components/AppLogo";
import { AppNav, type NavSectionBadge } from "./components/AppNav";
import { CommandPalette } from "./components/CommandPalette";
import { ConfigGitDirtyBadge } from "./components/ConfigGitDirtyBadge";
import { InstanceFormModal } from "./components/InstanceFormModal";
import { type InstanceFormInitialModel } from "./components/use-instance-form";
import { NodeSwitcher } from "./components/NodeSwitcher";
import { SectionTabs } from "./components/SectionTabs";
import {
  activeLeaf,
  activeSection,
  currentHashPath,
  navigateToLeaf,
  sidebarSections,
  useHashRoute,
  useHashSubpath,
  type NavLeaf,
} from "./routing";
import { countInstanceStatuses } from "./utils/instance-status";
import { countLabel } from "./utils/plural";
import { type LaunchMonitor, isLaunchTerminalStatus } from "./utils/launch";
import { ApiLabView } from "./views/ApiLabView";
import { ArgumentsView } from "./views/ArgumentsView";
import { BenchmarkView } from "./views/BenchmarkView";
import { BuildView } from "./views/BuildView";
import { ConfigGitView } from "./views/ConfigGitView";
import { DashboardView } from "./views/DashboardView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { EnvironmentsView } from "./views/EnvironmentsView";
import { InstancesView } from "./views/InstancesView";
import { LoginView } from "./views/LoginView";
import { MaintenanceView } from "./views/MaintenanceView";
import { HfDownloadsView } from "./views/HfDownloadsView";
import { ModelsView } from "./views/ModelsView";
import { NodesView } from "./views/NodesView";
import { PathCatalogView } from "./views/PathCatalogView";
import { PrerequisitesView } from "./views/PrerequisitesView";
import { PresetsView } from "./views/PresetsView";
import { ProcessesView } from "./views/ProcessesView";
import { ProxySection } from "./views/ProxySection";
import { PublicStatusView } from "./views/PublicStatusView";
import { SourceSyncView } from "./views/SourceSyncView";
import { SystemResourcesView } from "./views/SystemResourcesView";
import { WebappsView } from "./views/WebappsView";
import { useUiVersionGuard } from "./use-ui-version-guard";

export function App() {
  useUiVersionGuard();
  const [route, setRoute] = useHashRoute();
  const [routeSubpath] = useHashSubpath(route);
  const [mobileNavOpened, { toggle: toggleNav, close: closeNav }] =
    useDisclosure(false);
  const [createOpened, setCreateOpened] = useState(false);
  const [formSeed, setFormSeed] = useState<{
    mode: "edit" | "duplicate";
    instance: Instance;
  } | null>(null);
  const [initialModel, setInitialModel] =
    useState<InstanceFormInitialModel | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [launchMonitor, setLaunchMonitor] = useState<LaunchMonitor | null>(
    null,
  );
  const [monitorNowMs, setMonitorNowMs] = useState(Date.now());
  const [apiLabVisited, setApiLabVisited] = useState(false);
  const [paletteOpened, setPaletteOpened] = useState(false);
  const { setColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme("dark");
  const queryClient = useQueryClient();
  const authQuery = useQuery({
    queryKey: ["auth-state"],
    queryFn: getAuthState,
    retry: 1,
    refetchInterval: (query) =>
      query.state.status === "error" || query.state.fetchFailureCount > 0
        ? 3_000
        : 30_000,
  });
  const authState = authQuery.data?.data;
  const canUseAdmin = authState?.authenticated ?? false;
  const isPublicRoute = route === "status";
  useEffect(() => {
    if (route === "api-lab") {
      setApiLabVisited(true);
    }
  }, [route]);
  const instancesQuery = useQuery({
    queryKey: ["instances"],
    queryFn: listInstances,
    refetchInterval: 2_500,
    enabled: canUseAdmin,
  });
  const healthSummariesQuery = useQuery({
    queryKey: ["instances-health-summary"],
    queryFn: listInstanceHealthSummaries,
    refetchInterval: 3_000,
    enabled: canUseAdmin,
  });
  const proxyStatsQuery = useQuery({
    queryKey: ["nav-proxy-stats"],
    queryFn: () => getApiProxyStats(1),
    refetchInterval: 20_000,
    enabled: canUseAdmin,
  });

  const instances = instancesQuery.data?.data ?? [];
  const healthByInstanceId = useMemo(
    () =>
      new Map(
        (healthSummariesQuery.data?.data ?? []).map((health) => [
          health.instanceId,
          health,
        ]),
      ),
    [healthSummariesQuery.data?.data],
  );
  const selectedInstance =
    instances.find((instance) => instance.name === selectedId) ??
    instances[0] ??
    null;
  const selectedHealth = selectedInstance
    ? healthByInstanceId.get(selectedInstance.name)
    : null;
  const selectedLaunchMonitor =
    selectedInstance?.name === launchMonitor?.instanceId ? launchMonitor : null;
  const currentRoute = activeLeaf(route, routeSubpath);
  const currentSection = activeSection(route, routeSubpath);
  const visibleSections = sidebarSections(canUseAdmin);
  const mainSections = visibleSections.filter((section) => !section.footer);
  const footerSections = visibleSections.filter((section) => section.footer);

  const instanceCounts = useMemo(
    () => countInstanceStatuses(instances, healthByInstanceId),
    [instances, healthByInstanceId],
  );
  const proxyErrors = proxyStatsQuery.data?.data.totals.errors ?? 0;
  const faultedInstances = instanceCounts.error + instanceCounts.stale;
  const navBadges: Record<string, NavSectionBadge | undefined> = {
    instances: {
      count: instanceCounts.running,
      dot:
        faultedInstances > 0
          ? {
              tone: "error",
              label: `${countLabel(faultedInstances, "instance")} in error or stale`,
            }
          : instanceCounts.degraded > 0
            ? {
                tone: "warn",
                label: `${countLabel(instanceCounts.degraded, "instance")} degraded`,
              }
            : null,
    },
    proxy:
      proxyErrors > 0
        ? {
            count: null,
            dot: {
              tone: "error",
              label: `${countLabel(proxyErrors, "failed request")} in the last hour`,
            },
          }
        : undefined,
  };

  useEffect(() => {
    document.title = `${currentRoute.title} · Arriero`;
  }, [currentRoute.title]);

  useEffect(() => {
    if (!canUseAdmin) {
      return;
    }
    const path = currentHashPath();
    if (!path || path === "login") {
      setRoute("dashboard");
    }
  }, [canUseAdmin, route]);

  function goToLeaf(leaf: NavLeaf) {
    navigateToLeaf(leaf);
    closeNav();
  }

  useEffect(() => {
    if (!launchMonitor) {
      return undefined;
    }
    setMonitorNowMs(Date.now());
    const timer = window.setInterval(() => setMonitorNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [launchMonitor?.instanceId]);

  useEffect(() => {
    if (!launchMonitor) {
      return;
    }
    const health = healthByInstanceId.get(launchMonitor.instanceId);
    if (
      !health ||
      Date.parse(health.checkedAt) < Date.parse(launchMonitor.startedAt)
    ) {
      return;
    }
    if (isLaunchTerminalStatus(health.status)) {
      setLaunchMonitor(null);
    }
  }, [healthByInstanceId, launchMonitor]);

  function startLaunchMonitor(
    instance: Instance,
    source: LaunchMonitor["source"],
  ) {
    setSelectedId(instance.name);
    setLaunchMonitor({
      instanceId: instance.name,
      source,
      startedAt: new Date().toISOString(),
    });
  }

  function clearLaunchMonitor(instance: Instance) {
    setLaunchMonitor((monitor) =>
      monitor?.instanceId === instance.name ? null : monitor,
    );
  }

  const logoutMutation = useMutation({
    mutationFn: logoutAdmin,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["auth-state"] });
      queryClient.removeQueries({ queryKey: ["instances"] });
      queryClient.removeQueries({ queryKey: ["instances-health-summary"] });
      setSelectedId(null);
      setLaunchMonitor(null);
      setRoute("status");
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Logout failed",
        message: (error as Error).message,
      });
    },
  });

  return (
    <AppShell
      header={{ height: 58 }}
      navbar={{
        width: 250,
        breakpoint: "sm",
        collapsed: { mobile: !mobileNavOpened },
      }}
      padding="md"
    >
      <AppShell.Header>
        <Group className="app-header__inner" h="100%" px="md">
          <Group className="app-header__brand" gap="sm">
            <Burger
              opened={mobileNavOpened}
              onClick={toggleNav}
              hiddenFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
            <AppLogo />
            <Title className="app-header__title" order={3}>
              Arriero
            </Title>
          </Group>
          <Group className="app-header__actions" gap="xs">
            {canUseAdmin && (
              <Tooltip label="Search pages (Ctrl+K)">
                <ActionIcon
                  aria-label="Search pages"
                  variant="subtle"
                  onClick={() => setPaletteOpened(true)}
                >
                  <Search size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            {canUseAdmin && <ConfigGitDirtyBadge />}
            {canUseAdmin && <NodeSwitcher />}
            <Tooltip
              label={
                colorScheme === "dark" ? "Switch to light" : "Switch to dark"
              }
            >
              <ActionIcon
                aria-label="Toggle color scheme"
                variant="subtle"
                onClick={() =>
                  setColorScheme(colorScheme === "dark" ? "light" : "dark")
                }
              >
                {colorScheme === "dark" ? (
                  <Sun size={18} />
                ) : (
                  <Moon size={18} />
                )}
              </ActionIcon>
            </Tooltip>
            {canUseAdmin && !isPublicRoute && (
              <>
                <Tooltip label="Refresh">
                  <ActionIcon
                    aria-label="Refresh instances"
                    variant="subtle"
                    onClick={() => {
                      void instancesQuery.refetch();
                      void healthSummariesQuery.refetch();
                    }}
                  >
                    <RefreshCw size={18} />
                  </ActionIcon>
                </Tooltip>
                {authState?.enabled && (
                  <Tooltip label="Sign out">
                    <ActionIcon
                      aria-label="Sign out"
                      variant="subtle"
                      color="gray"
                      loading={logoutMutation.isPending}
                      onClick={() => logoutMutation.mutate()}
                    >
                      <LogOut size={18} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </>
            )}
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          <AppNav
            sections={mainSections}
            activeSectionId={currentSection.id}
            badges={navBadges}
            onNavigate={goToLeaf}
          />
        </AppShell.Section>
        {footerSections.length > 0 && (
          <AppShell.Section>
            <Divider my="xs" />
            <AppNav
              sections={footerSections}
              activeSectionId={currentSection.id}
              onNavigate={goToLeaf}
            />
          </AppShell.Section>
        )}
      </AppShell.Navbar>

      <AppShell.Main>
        <Stack gap="md">
          <div className="page-header">
            <Title order={2}>{currentRoute.title}</Title>
            {currentRoute.description && (
              <Text c="dimmed" size="sm">
                {currentRoute.description}
              </Text>
            )}
          </div>

          {canUseAdmin && (
            <SectionTabs
              section={currentSection}
              current={currentRoute}
              onNavigate={goToLeaf}
            />
          )}

          {isPublicRoute && <PublicStatusView />}

          {!isPublicRoute && !canUseAdmin && (
            <>
              {authState ? (
                <LoginView />
              ) : authQuery.isError || authQuery.failureCount > 0 ? (
                <Alert
                  icon={<ServerOff size={16} />}
                  color="red"
                  title="API server unreachable"
                >
                  The manager API is not responding. Retrying automatically —
                  the page recovers as soon as the server is back.
                </Alert>
              ) : (
                <Text c="dimmed">Checking admin session...</Text>
              )}
            </>
          )}

          {canUseAdmin && route === "dashboard" && (
            <DashboardView
              instances={instances}
              healthByInstanceId={healthByInstanceId}
              onOpenDiagnostics={(instance) => {
                setSelectedId(instance.name);
                setRoute("diagnostics");
              }}
            />
          )}

          {canUseAdmin && route === "instances" && (
            <InstancesView
              instances={instances}
              selectedInstance={selectedInstance}
              healthByInstanceId={healthByInstanceId}
              onSelect={(instance) => setSelectedId(instance.name)}
              onCreate={() => setCreateOpened(true)}
              onEdit={(instance) => setFormSeed({ mode: "edit", instance })}
              onDuplicate={(instance) =>
                setFormSeed({ mode: "duplicate", instance })
              }
              onOpenDiagnostics={(instance) => {
                setSelectedId(instance.name);
                setRoute("diagnostics");
              }}
              onLaunchStarted={startLaunchMonitor}
              onLaunchStopped={clearLaunchMonitor}
            />
          )}

          {canUseAdmin && route === "nodes" && <NodesView />}

          {canUseAdmin && route === "config-git" && <ConfigGitView />}

          {canUseAdmin && route === "maintenance" && <MaintenanceView />}

          {canUseAdmin && route === "build" && <BuildView />}

          {canUseAdmin && route === "environments" && <EnvironmentsView />}

          {canUseAdmin && route === "diagnostics" && (
            <DiagnosticsView
              instances={instances}
              selectedInstance={selectedInstance}
              selectedHealth={selectedHealth}
              launchMonitor={selectedLaunchMonitor}
              monitorNowMs={monitorNowMs}
              onSelect={setSelectedId}
              onLaunchStopped={clearLaunchMonitor}
            />
          )}

          {canUseAdmin && route === "args" && <ArgumentsView />}

          {canUseAdmin && route === "benchmark" && <BenchmarkView />}

          {canUseAdmin && route === "paths" && <PathCatalogView />}

          {canUseAdmin && route === "proxy" && <ProxySection />}

          {canUseAdmin && apiLabVisited && (
            <div style={{ display: route === "api-lab" ? "contents" : "none" }}>
              <ApiLabView
                instances={instances}
                selectedInstance={selectedInstance}
                selectedHealth={selectedHealth}
                onSelect={setSelectedId}
              />
            </div>
          )}

          {canUseAdmin && route === "models" && (
            <ModelsView
              onUseModel={(model) => {
                setInitialModel({ path: model.path, format: "gguf" });
                setCreateOpened(true);
              }}
              onUseSafetensorsModel={(model) => {
                setInitialModel({ path: model.path, format: "safetensors" });
                setCreateOpened(true);
              }}
            />
          )}

          {canUseAdmin && route === "downloads" && <HfDownloadsView />}

          {canUseAdmin && route === "presets" && <PresetsView />}

          {canUseAdmin && route === "source-sync" && <SourceSyncView />}

          {canUseAdmin && route === "processes" && <ProcessesView />}

          {canUseAdmin && route === "webapps" && <WebappsView />}

          {canUseAdmin && route === "system" && <SystemResourcesView />}

          {canUseAdmin && route === "prerequisites" && <PrerequisitesView />}
        </Stack>
      </AppShell.Main>

      {canUseAdmin && (
        <CommandPalette
          opened={paletteOpened}
          onOpenedChange={setPaletteOpened}
          onNavigate={goToLeaf}
        />
      )}

      <InstanceFormModal
        opened={canUseAdmin && createOpened}
        instances={instances}
        initialModel={initialModel}
        onSaved={(instance) => setSelectedId(instance.name)}
        onLaunchStarted={startLaunchMonitor}
        onClose={() => {
          setCreateOpened(false);
          setInitialModel(null);
        }}
      />
      <InstanceFormModal
        opened={canUseAdmin && Boolean(formSeed)}
        instances={instances}
        instance={formSeed?.mode === "edit" ? formSeed.instance : null}
        duplicateFrom={
          formSeed?.mode === "duplicate" ? formSeed.instance : null
        }
        onSaved={(instance) => setSelectedId(instance.name)}
        onLaunchStarted={startLaunchMonitor}
        onClose={() => setFormSeed(null)}
      />
    </AppShell>
  );
}
