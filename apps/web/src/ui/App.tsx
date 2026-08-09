import { type Instance } from "@arriero/core";
import {
  ActionIcon,
  AppShell,
  Burger,
  Group,
  NavLink,
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
import { LogOut, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  getAuthState,
  listInstanceHealthSummaries,
  listInstances,
  logoutAdmin,
} from "../api/client";
import { AppLogo } from "./components/AppLogo";
import { InstanceFormModal } from "./components/InstanceFormModal";
import { NodeSwitcher } from "./components/NodeSwitcher";
import {
  activeLeaf,
  isLeafActive,
  navSections,
  navigateToLeaf,
  useHashRoute,
  useHashSubpath,
  type NavLeaf,
} from "./routing";
import { type LaunchMonitor, isLaunchTerminalStatus } from "./utils/launch";
import { ApiLabView } from "./views/ApiLabView";
import { ArgumentsView } from "./views/ArgumentsView";
import { BuildView } from "./views/BuildView";
import { ConfigGitView } from "./views/ConfigGitView";
import { DashboardView } from "./views/DashboardView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { EnvironmentsView } from "./views/EnvironmentsView";
import { InstancesView } from "./views/InstancesView";
import { LoginView } from "./views/LoginView";
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
import { useUiVersionGuard } from "./use-ui-version-guard";

export function App() {
  useUiVersionGuard();
  const [route, setRoute] = useHashRoute();
  const [proxySubpath] = useHashSubpath("proxy");
  const [mobileNavOpened, { toggle: toggleNav, close: closeNav }] =
    useDisclosure(false);
  const [createOpened, setCreateOpened] = useState(false);
  const [formSeed, setFormSeed] = useState<{
    mode: "edit" | "duplicate";
    instance: Instance;
  } | null>(null);
  const [initialModelPath, setInitialModelPath] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [launchMonitor, setLaunchMonitor] = useState<LaunchMonitor | null>(
    null,
  );
  const [monitorNowMs, setMonitorNowMs] = useState(Date.now());
  const [apiLabVisited, setApiLabVisited] = useState(false);
  const { setColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme("dark");
  const queryClient = useQueryClient();
  const authQuery = useQuery({
    queryKey: ["auth-state"],
    queryFn: getAuthState,
    refetchInterval: 30_000,
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
  const currentRoute = activeLeaf(route, proxySubpath);

  useEffect(() => {
    document.title = `${currentRoute.title} · Arriero`;
  }, [currentRoute.title]);

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
          {navSections.map((section) => {
            const leaves = section.items.map((leaf) => (
              <NavLink
                key={`${leaf.route}:${leaf.subpath ?? ""}`}
                label={leaf.label}
                active={isLeafActive(leaf, route, proxySubpath)}
                onClick={() => goToLeaf(leaf)}
              />
            ));
            if (!section.label) {
              return <div key={section.id}>{leaves}</div>;
            }
            return (
              <NavLink
                key={section.id}
                label={section.label}
                defaultOpened
                childrenOffset={12}
              >
                {leaves}
              </NavLink>
            );
          })}
        </AppShell.Section>
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

          {isPublicRoute && <PublicStatusView />}

          {!isPublicRoute && !canUseAdmin && (
            <>
              {authQuery.isLoading ? (
                <Text c="dimmed">Checking admin session...</Text>
              ) : (
                <LoginView />
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
                setInitialModelPath(model.path);
                setCreateOpened(true);
              }}
            />
          )}

          {canUseAdmin && route === "presets" && <PresetsView />}

          {canUseAdmin && route === "source-sync" && <SourceSyncView />}

          {canUseAdmin && route === "processes" && <ProcessesView />}

          {canUseAdmin && route === "system" && <SystemResourcesView />}

          {canUseAdmin && route === "prerequisites" && <PrerequisitesView />}
        </Stack>
      </AppShell.Main>

      <InstanceFormModal
        opened={canUseAdmin && createOpened}
        instances={instances}
        initialModelPath={initialModelPath}
        onSaved={(instance) => setSelectedId(instance.name)}
        onLaunchStarted={startLaunchMonitor}
        onClose={() => {
          setCreateOpened(false);
          setInitialModelPath(null);
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
