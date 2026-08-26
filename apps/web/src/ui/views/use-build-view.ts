import type { BuildSettings, LlamaSourceRefs } from "@arriero/core";
import { LLAMA_CPP_SOURCE_ID } from "@arriero/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  cancelBuildJob,
  checkoutLlamaSourceRef,
  cloneSourceRepository,
  getBuildJobLogs,
  getBuildSettings,
  getLlamaSourceRefs,
  getPackageRegistriesSettings,
  getSourceRepositoryStatus,
  listBuildJobs,
  pullSourceRepository,
  startBuildJob,
  updateBuildSettings,
  updatePackageRegistriesSettings,
} from "../../api/client";
import {
  type BuildFormState,
  buildFormFromSettings,
  cudaArchitecturesFromForm,
  parseBuildEnv,
  parseExtraCmakeArgs,
  slugifyRef,
} from "./build-view-helpers";
import { useSourceRepositoryOperation } from "./use-source-repository-operation";
import { notifyError } from "../utils/notify";

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
  const sourceOperation = useSourceRepositoryOperation(LLAMA_CPP_SOURCE_ID);

  const settingsQuery = useQuery({
    queryKey: ["build-settings"],
    queryFn: getBuildSettings,
  });
  const registriesQuery = useQuery({
    queryKey: ["package-registries"],
    queryFn: getPackageRegistriesSettings,
  });
  const [npmRegistryUrl, setNpmRegistryUrl] = useState("");
  const jobsQuery = useQuery({
    queryKey: ["build-jobs"],
    queryFn: () => listBuildJobs(8),
    refetchInterval: 2_500,
  });
  const sourceStatusQuery = useQuery({
    queryKey: ["source-repository-status", LLAMA_CPP_SOURCE_ID],
    queryFn: () => getSourceRepositoryStatus(LLAMA_CPP_SOURCE_ID),
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
    sourceStatus.repoPath === repoPath;
  const sourceBusy = sourceStatus?.state === "busy" || sourceOperation.running;
  const sourceReady = sourceStatus?.valid === true;
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
  const canStartJob =
    settingsReady &&
    selectedSteps.length > 0 &&
    !runningJob &&
    sourceReady &&
    !sourceBusy &&
    sourceStatusMatchesForm;

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

  useEffect(() => {
    const registries = registriesQuery.data?.data;
    if (!registries) {
      return;
    }
    setNpmRegistryUrl(registries.npmRegistryUrl ?? "");
  }, [registriesQuery.data?.data]);

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

  async function saveNpmRegistryIfChanged() {
    const trimmed = npmRegistryUrl.trim();
    const stored = registriesQuery.data?.data.npmRegistryUrl ?? "";
    if (trimmed === stored) {
      return;
    }
    await updatePackageRegistriesSettings({
      npmRegistryUrl: trimmed || null,
    });
    await queryClient.invalidateQueries({ queryKey: ["package-registries"] });
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      await saveNpmRegistryIfChanged();
      return updateBuildSettings(currentSettings());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["build-settings"] });
      await queryClient.invalidateQueries({
        queryKey: ["source-repository-status", LLAMA_CPP_SOURCE_ID],
      });
      notifications.show({ title: "Build settings saved", message: buildDir });
    },
    onError: notifyError("Settings save failed"),
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      await saveNpmRegistryIfChanged();
      return startBuildJob({
        settings: currentSettings(),
        gitRef,
        pull: runPull,
        installUiDeps: runUiRebuild,
        cleanBuildDir: runCleanBuildDir,
        configure: runConfigure,
        build: runBuild,
      });
    },
    onSuccess: async (result) => {
      setStartConfirmOpened(false);
      await queryClient.invalidateQueries({ queryKey: ["build-settings"] });
      await queryClient.invalidateQueries({
        queryKey: ["source-repository-status", LLAMA_CPP_SOURCE_ID],
      });
      await queryClient.invalidateQueries({ queryKey: ["build-jobs"] });
      notifications.show({
        title: "Build job started",
        message: result.data.id,
      });
    },
    onError: notifyError("Build start failed"),
  });

  const checkoutMutation = useMutation({
    mutationFn: (ref: string) => checkoutLlamaSourceRef(ref),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["source-repository-status", LLAMA_CPP_SOURCE_ID],
        }),
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
    mutationFn: () => pullSourceRepository(LLAMA_CPP_SOURCE_ID),
    onSuccess: (result) => {
      sourceOperation.setJob(result.data);
      notifications.show({
        title: "llama.cpp pull started",
        message: "Progress is shown in Source activity.",
      });
    },
    onError: notifyError("Pull failed to start"),
  });

  const cloneMutation = useMutation({
    mutationFn: () =>
      cloneSourceRepository(LLAMA_CPP_SOURCE_ID, { branch: null }),
    onSuccess: (result) => {
      sourceOperation.setJob(result.data);
      notifications.show({
        title: "llama.cpp clone started",
        message: sourceStatus?.repoPath ?? repoPath,
      });
    },
    onError: notifyError("Clone failed to start"),
  });

  const cloneNeeded = sourceStatus?.exists !== true;
  const sourceSync = {
    label: cloneNeeded ? ("Clone" as const) : ("Pull" as const),
    mutation: cloneNeeded ? cloneMutation : pullMutation,
    disabled:
      !settingsReady ||
      Boolean(runningJob) ||
      sourceBusy ||
      !sourceStatusMatchesForm ||
      (cloneNeeded ? sourceStatus?.state !== "missing" : !sourceReady),
  };

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelBuildJob(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["build-jobs"] });
      notifications.show({
        title: "Build job canceled",
        message: "Stop signal sent",
      });
    },
    onError: notifyError("Cancel failed"),
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
    npmRegistryUrl,
    setNpmRegistryUrl,
    sourceStatus,
    sourceStatusMatchesForm,
    sourceBusy,
    sourceReady,
    sourceOperation,
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
    sourceSync,
    cancelMutation,
  };
}

export type BuildViewController = ReturnType<typeof useBuildView>;
