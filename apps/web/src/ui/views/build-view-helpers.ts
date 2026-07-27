import type { BuildJob, BuildSettings, LlamaSourceStatus } from "@arriero/core";

export function buildStatusColor(status: BuildJob["status"]) {
  if (status === "succeeded") return "green";
  if (status === "running") return "yellow";
  if (status === "failed") return "red";
  return "gray";
}

export function buildStepColor(status: BuildJob["steps"][number]["status"]) {
  if (status === "succeeded") return "green";
  if (status === "running") return "yellow";
  if (status === "warning") return "orange";
  if (status === "failed") return "red";
  if (status === "skipped") return "gray";
  return "blue";
}

export function buildJobHasWarnings(job: BuildJob) {
  return job.steps.some((item) => item.status === "warning");
}

export function buildStepLabel(name: BuildJob["steps"][number]["name"]) {
  if (name === "ui-install") return "ui rebuild";
  if (name === "git-checkout") return "git checkout";
  if (name === "git-pull") return "git pull";
  if (name === "clean-build-dir") return "clean build dir";
  if (name === "build-fit-params") return "build fit-params";
  if (name === "build-rpc-server") return "build rpc-server";
  return name;
}

export function slugifyRef(ref: string): string {
  const slug = ref
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "build";
}

export function sourceStatusColor(status: LlamaSourceStatus) {
  if (status.error || !status.exists || !status.isGitRepo) return "red";
  if (status.dirty) return "yellow";
  return "green";
}

export function sourceStatusLabel(status: LlamaSourceStatus) {
  if (!status.exists) return "missing";
  if (!status.isGitRepo) return "not git";
  if (status.dirty) return "dirty";
  return "clean";
}

export type BuildFormState = {
  repoPath: string;
  buildDir: string;
  buildType: BuildSettings["buildType"];
  buildProfile: BuildSettings["buildProfile"];
  target: string;
  parallelJobs: number | "";
  cuda: boolean;
  rpc: boolean;
  native: boolean;
  cudaArchitectureMode: "default" | "native" | "custom";
  cudaArchitectureValue: string;
  cudaFaAllQuants: boolean;
  cudaGraphs: BuildSettings["cudaGraphs"];
  cudaNoVmm: boolean;
  llguidance: BuildSettings["llguidance"];
  extraCmakeArgs: string;
  buildEnvJson: string;
};

export function buildFormFromSettings(settings: BuildSettings): BuildFormState {
  const cudaArchitectures = settings.cudaArchitectures?.trim() ?? "";
  const cudaArchitectureMode =
    cudaArchitectures === ""
      ? "default"
      : cudaArchitectures === "native"
        ? "native"
        : "custom";

  return {
    repoPath: settings.repoPath,
    buildDir: settings.buildDir,
    buildType: settings.buildType,
    buildProfile: settings.buildProfile,
    target: settings.target,
    parallelJobs: settings.parallelJobs ?? "",
    cuda: settings.cuda,
    rpc: settings.rpc,
    native: settings.native,
    cudaArchitectureMode,
    cudaArchitectureValue:
      cudaArchitectureMode === "custom" ? cudaArchitectures : "",
    cudaFaAllQuants: settings.cudaFaAllQuants,
    cudaGraphs: settings.cudaGraphs,
    cudaNoVmm: settings.cudaNoVmm,
    llguidance: settings.llguidance,
    extraCmakeArgs: settings.extraCmakeArgs.join("\n"),
    buildEnvJson: JSON.stringify(settings.env, null, 2),
  };
}

export function parseExtraCmakeArgs(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(value: string, field: string) {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${field} must be an object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`${field}: ${(error as Error).message}`);
  }
}

export function parseBuildEnv(value: string) {
  const parsed = parseJsonObject(value, "build env");
  return Object.fromEntries(
    Object.entries(parsed).map(([key, envValue]) => [key, String(envValue)]),
  );
}

export function cudaArchitecturesFromForm(form: BuildFormState) {
  if (form.cudaArchitectureMode === "default") {
    return null;
  }
  if (form.cudaArchitectureMode === "native") {
    return "native";
  }

  const value = form.cudaArchitectureValue.trim();
  if (!value) {
    throw new Error("CUDA architecture list is required in custom mode");
  }
  return value;
}
