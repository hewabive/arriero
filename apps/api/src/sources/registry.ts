import { LLAMA_CPP_SOURCE_ID } from "@arriero/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export { LLAMA_CPP_SOURCE_ID };

export type SourceRepositoryDefinition = {
  id: string;
  adapter: string;
  displayName: string;
  directoryName: string;
  defaultOriginUrl: string;
  driftSupported: boolean;
  validateCheckout(repoPath: string): string | null;
};

const definitions: SourceRepositoryDefinition[] = [
  {
    id: LLAMA_CPP_SOURCE_ID,
    adapter: "llama-cpp",
    displayName: "llama.cpp",
    directoryName: "llama.cpp",
    defaultOriginUrl: "https://github.com/ggml-org/llama.cpp.git",
    driftSupported: true,
    validateCheckout(repoPath) {
      if (!existsSync(resolve(repoPath, "CMakeLists.txt"))) {
        return `CMakeLists.txt not found in ${repoPath}; the checkout does not look like llama.cpp`;
      }
      return null;
    },
  },
  {
    id: "vllm",
    adapter: "vllm",
    displayName: "vLLM",
    directoryName: "vllm",
    defaultOriginUrl: "https://github.com/vllm-project/vllm.git",
    driftSupported: false,
    validateCheckout(repoPath) {
      if (!existsSync(resolve(repoPath, "vllm", "engine", "arg_utils.py"))) {
        return `vllm/engine/arg_utils.py not found in ${repoPath}; the checkout does not look like vLLM`;
      }
      return null;
    },
  },
  {
    id: "sglang",
    adapter: "sglang",
    displayName: "SGLang",
    directoryName: "sglang",
    defaultOriginUrl: "https://github.com/sgl-project/sglang.git",
    driftSupported: false,
    validateCheckout(repoPath) {
      if (
        !existsSync(
          resolve(repoPath, "python", "sglang", "srt", "server_args.py"),
        )
      ) {
        return `python/sglang/srt/server_args.py not found in ${repoPath}; the checkout does not look like SGLang`;
      }
      return null;
    },
  },
];

const byId = new Map(
  definitions.map((definition) => [definition.id, definition]),
);

export function listSourceRepositoryDefinitions(): SourceRepositoryDefinition[] {
  return [...definitions];
}

export function getSourceRepositoryDefinition(
  id: string,
): SourceRepositoryDefinition {
  const definition = byId.get(id);
  if (!definition) {
    throw new Error(`unknown source repository: ${id}`);
  }
  return definition;
}
