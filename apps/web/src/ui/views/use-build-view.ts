import type { BuildSettings, LlamaSourceRefs } from "@arriero/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  cancelBuildJob,
  checkoutLlamaSourceRef,
  getBuildJobLogs,
  getBuildSettings,
  getLlamaSourceRefs,
  getLlamaSourceStatus,
  listBuildJobs,
  pullLlamaSource,
  startBuildJob,
  updateBuildSettings,
} from "../../api/client";
import {
  type BuildFormState,
  buildFormFromSettings,
  cudaArchitecturesFromForm,
  parseBuildEnv,
  parseExtraCmakeArgs,
  slugifyRef,
} from "./build-view-helpers";

export function useBuildView() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<BuildFormState | null>(null);
  const [gitRef, setGitRef] = useState<string | null>(null);
  const [runPull, setRunPull] = useState(true);
  const [runUiRebuild, setRunUiRebuild] = useState(true);
  const [runCleanBuildDir, setRunCleanBuildDir] = useState(false);
  const [runConfigure, setRunConfigure] = useState(true);
  const [runBuild, setRunBuild] = useState(true);
  const [startConfirmOpened, setStartConfirmOpened] = useState(false);
  const [pullLog, setPullLog] = useState<{
    status: "running" | "succeeded" | "failed";
    lines: string[];
  } | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["build-settings"],
    queryFn: getBuildSettings,
  });
  const jobsQuery = useQuery({
    queryKey: ["build-jobs"],
    queryFn: () => listBuildJobs(8),
    refetchInterval: 2_500,
  });
  const sourceStatusQuery = useQuery({
    queryKey: ["llama-source-status"],
    queryFn: getLlamaSourceStatus,
    refetchInterval: 30_000,
  });
  const refsQuery = useQuery({
    queryKey: ["llama-source-refs"],
    queryFn: getLlamaSourceRefs,
    refetchInterval: 30_000,
  });

  const jobs = jobsQuery.data?.data ?? [];
  const runningJob = jobs.find((job) => job.status === "running") ?? null;
  const selectedJob = runningJob ?? jobs[0] ?? null;
  const settingsReady = form !== null;
  const repoPath = form?.repoPath ?? "";
  const buildDir = form?.buildDir ?? "";
  const buildType = form?.buildType ?? null;
  const buildProfile = form?.buildProfile ?? null;
  const target = form?.target ?? "";
  const parallelJobs = form?.parallelJobs ?? "";
  const cuda = form?.cuda ?? false;
  const rpc = form?.rpc ?? false;
  const native = form?.native ?? false;
  const cudaArchitectureMode = form?.cudaArchitectureMode ?? "default";
  const cudaArchitectureValue = form?.cudaArchitectureValue ?? "";
  const cudaFaAllQuants = form?.cudaFaAllQuants ?? false;
  const cudaGraphs = form?.cudaGraphs ?? "default";
  const cudaNoVmm = form?.cudaNoVmm ?? false;
  const llguidance = form?.llguidance ?? "default";
  const extraCmakeArgs = form?.extraCmakeArgs ?? "";
  const buildEnvJson = form?.buildEnvJson ?? "";
  const sourceStatus = sourceStatusQuery.data?.data ?? null;
  const sourceStatusMatchesForm =
    sourceStatus !== null &&
    form !== null &&
    sourceStatus.settings.repoPath === repoPath;
  const refs: LlamaSourceRefs | null = refsQuery.data?.data ?? null;
  const dirty = refs?.dirty === true;
  const refIsTag = gitRef !== null && (refs?.tags.includes(gitRef) ?? false);
  const detachedRef = sourceStatus?.currentCommit
    ? `commit-${sourceStatus.currentCommit.slice(0, 12)}`
    : null;
  const refForDir = gitRef ?? refs?.currentBranch ?? detachedRef ?? "build";
  const effectiveBuildDir = buildDir
    ? `${buildDir.replace(/[\\/]+$/, "")}/${slugifyRef(refForDir)}`
    : "";
  const refIsLocalBranch = refs?.branches.includes(refForDir) ?? false;
  const branchHasUpstream =
    refs?.branchesWithUpstream.includes(refForDir) ?? false;
  const willPull = runPull && refIsLocalBranch && branchHasUpstream;
  const selectedSteps = [
    ...(gitRef ? [`git checkout ${gitRef}`] : []),
    ...(willPull ? ["git pull --ff-only"] : []),
    ...(runUiRebuild ? ["Rebuild embedded UI assets"] : []),
    ...(runCleanBuildDir ? ["Clean build directory"] : []),
    ...(runConfigure ? ["Configure CMake"] : []),
    ...(runBuild ? [`Build ${target.trim() || "all targets"}`] : []),
  ];
  const canStartJob = settingsReady && selectedSteps.length > 0 && !runningJob;

  const logsQuery = useQuery({
    queryKey: ["build-job-logs", selectedJob?.id],
    queryFn: () => getBuildJobLogs(selectedJob!.id, 240),
    enabled: Boolean(selectedJob),
    refetchInterval: selectedJob?.status === "running" ? 1_500 : false,
  });

  useEffect(() => {
    const settings = settingsQuery.data?.data;
    if (!settings) {
      return;
    }
    setForm(buildFormFromSettings(settings));
  }, [settingsQuery.data?.data]);

  useEffect(() => {
    const currentBranch = refsQuery.data?.data.currentBranch ?? null;
    setGitRef((current) => current ?? currentBranch);
  }, [refsQuery.data?.data]);

  function setFormField<K extends keyof BuildFormState>(
    key: K,
    value: BuildFormState[K],
  ) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function currentSettings(): BuildSettings {
    if (!form) {
      throw new Error("Build settings are still loading");
    }
    return {
      repoPath: form.repoPath,
      buildDir: form.buildDir,
      buildType: form.buildType,
      buildProfile: form.buildProfile,
      cuda: form.cuda,
      rpc: form.rpc,
      native: form.native,
      cudaArchitectures: cudaArchitecturesFromForm(form),
      cudaFaAllQuants: form.cudaFaAllQuants,
      cudaGraphs: form.cudaGraphs,
      cudaNoVmm: form.cudaNoVmm,
      llguidance: form.llguidance,
      extraCmakeArgs: parseExtraCmakeArgs(form.extraCmakeArgs),
      env: parseBuildEnv(form.buildEnvJson),
      target: form.target,
      parallelJobs:
        typeof form.parallelJobs === "number" ? form.parallelJobs : null,
    };
  }

  const saveMutation = useMutation({
    mutationFn: () => updateBuildSettings(currentSettings()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["build-settings"] });
      await queryClient.invalidateQueries({
        queryKey: ["llama-source-status"],
      });
      notifications.show({ title: "Build settings saved", message: buildDir });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Settings save failed",
        message: (error as Error).message,
      });
    },
  });

  const startMutation = useMutation({
    mutationFn: () =>
      startBuildJob({
        settings: currentSettings(),
        gitRef,
        pull: runPull,
        installUiDeps: runUiRebuild,
        cleanBuildDir: runCleanBuildDir,
        configure: runConfigure,
        build: runBuild,
      }),
    onSuccess: async (result) => {
      setStartConfirmOpened(false);
      setPullLog(null);
      await queryClient.invalidateQueries({ queryKey: ["build-settings"] });
      await queryClient.invalidateQueries({
        queryKey: ["llama-source-status"],
      });
      await queryClient.invalidateQueries({ queryKey: ["build-jobs"] });
      notifications.show({
        title: "Build job started",
        message: result.data.id,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Build start failed",
        message: (error as Error).message,
      });
    },
  });

  const checkoutMutation = useMutation({
    mutationFn: (ref: string) => checkoutLlamaSourceRef(ref),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["llama-source-status"] }),
        queryClient.invalidateQueries({ queryKey: ["llama-source-refs"] }),
        queryClient.invalidateQueries({ queryKey: ["llama-arg-docs-sync"] }),
        queryClient.invalidateQueries({ queryKey: ["llama-arg-help-diff"] }),
      ]);
      notifications.show({
        title: "Checked out",
        message: result.data.branch ?? result.data.currentCommit ?? "",
      });
    },
    onError: (error) => {
      setGitRef(refsQuery.data?.data.currentBranch ?? null);
      notifications.show({
        color: "red",
        title: "Checkout failed",
        message: (error as Error).message,
      });
    },
  });

  const pullMutation = useMutation({
    mutationFn: () => pullLlamaSource(),
    onMutate: () => {
      setPullLog({ status: "running", lines: ["$ git pull --ff-only"] });
    },
    onSuccess: async (result) => {
      const output = result.data.output.split(/\r?\n/);
      setPullLog({
        status: result.data.ok ? "succeeded" : "failed",
        lines: ["$ git pull --ff-only", ...output],
      });
      await queryClient.invalidateQueries({
        queryKey: ["llama-source-status"],
      });
    },
    onError: (error) => {
      setPullLog({
        status: "failed",
        lines: ["$ git pull --ff-only", (error as Error).message],
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelBuildJob(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["build-jobs"] });
      notifications.show({
        title: "Build job canceled",
        message: "Stop signal sent",
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Cancel failed",
        message: (error as Error).message,
      });
    },
  });

  return {
    gitRef,
    setGitRef,
    runPull,
    setRunPull,
    runUiRebuild,
    setRunUiRebuild,
    runCleanBuildDir,
    setRunCleanBuildDir,
    runConfigure,
    setRunConfigure,
    runBuild,
    setRunBuild,
    startConfirmOpened,
    setStartConfirmOpened,
    pullLog,
    settingsQuery,
    logsQuery,
    jobs,
    runningJob,
    selectedJob,
    settingsReady,
    repoPath,
    buildDir,
    buildType,
    buildProfile,
    target,
    parallelJobs,
    cuda,
    rpc,
    native,
    cudaArchitectureMode,
    cudaArchitectureValue,
    cudaFaAllQuants,
    cudaGraphs,
    cudaNoVmm,
    llguidance,
    extraCmakeArgs,
    buildEnvJson,
    sourceStatus,
    sourceStatusMatchesForm,
    refs,
    dirty,
    refIsTag,
    detachedRef,
    effectiveBuildDir,
    refIsLocalBranch,
    branchHasUpstream,
    selectedSteps,
    canStartJob,
    setFormField,
    saveMutation,
    startMutation,
    checkoutMutation,
    pullMutation,
    cancelMutation,
  };
}

export type BuildViewController = ReturnType<typeof useBuildView>;
