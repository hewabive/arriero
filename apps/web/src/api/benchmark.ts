import type {
  BenchmarkContextFit,
  BenchmarkPrompt,
  BenchmarkPromptCreate,
  BenchmarkPromptWithSource,
  BenchmarkReservationPreview,
  BenchmarkRun,
  BenchmarkRunResult,
  BenchmarkScenarioInput,
} from "@arriero/core";

import { request } from "./http.js";

export async function listBenchmarkPrompts() {
  return request<{ data: BenchmarkPromptWithSource[] }>(
    "/api/benchmark/prompts",
  );
}

export async function createBenchmarkPrompt(input: BenchmarkPromptCreate) {
  return request<{ data: BenchmarkPrompt }>("/api/benchmark/prompts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteBenchmarkPrompt(id: string) {
  return request<{ data: { deleted: boolean } }>(
    `/api/benchmark/prompts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function listBenchmarkRuns(limit = 50) {
  return request<{ data: BenchmarkRun[] }>(
    `/api/benchmark/runs?limit=${limit}`,
  );
}

export async function getBenchmarkRunResult(id: string) {
  return request<{ data: BenchmarkRunResult }>(
    `/api/benchmark/runs/${encodeURIComponent(id)}/result`,
  );
}

export async function startBenchmarkRun(input: BenchmarkScenarioInput) {
  return request<{ data: BenchmarkRun }>("/api/benchmark/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelBenchmarkRun(id: string) {
  return request<{ data: { canceled: boolean } }>(
    `/api/benchmark/runs/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );
}

export async function deleteBenchmarkRun(id: string) {
  return request<{ data: { deleted: boolean } }>(
    `/api/benchmark/runs/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function getBenchmarkReservationPreview(instance: string) {
  return request<{ data: BenchmarkReservationPreview }>(
    `/api/benchmark/reservation-preview?instance=${encodeURIComponent(instance)}`,
  );
}

export async function getBenchmarkContextFit(input: {
  dataset: string;
  instance: string;
  outputCeiling: number;
}) {
  const query = new URLSearchParams({
    dataset: input.dataset,
    instance: input.instance,
    outputCeiling: String(input.outputCeiling),
  });
  return request<{ data: BenchmarkContextFit }>(
    `/api/benchmark/context-fit?${query.toString()}`,
  );
}
