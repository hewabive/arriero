import {
  LLAMA_CPP_SOURCE_ID,
  type SourceRepositoryTracking,
} from "@arriero/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export { LLAMA_CPP_SOURCE_ID };

export type SourceRepositoryDefinition = {
  id: string;
  adapter: string;
  displayName: string;
  directoryName: string;
  defaultOriginUrl: string;
  tracking: SourceRepositoryTracking;
  driftSupported: boolean;
  validateCheckout(repoPath: string): string | null;
};

function markerCheckout(markerRelativePath: string, name: string) {
  return (repoPath: string) =>
    existsSync(resolve(repoPath, ...markerRelativePath.split("/")))
      ? null
      : `${markerRelativePath} not found in ${repoPath}; the checkout does not look like ${name}`;
}

const definitions: SourceRepositoryDefinition[] = [
  {
    id: LLAMA_CPP_SOURCE_ID,
    adapter: "llama-cpp",
    displayName: "llama.cpp",
    directoryName: "llama.cpp",
    defaultOriginUrl: "https://github.com/ggml-org/llama.cpp.git",
    tracking: "branch",
    driftSupported: true,
    validateCheckout: markerCheckout("CMakeLists.txt", "llama.cpp"),
  },
  {
    id: "vllm",
    adapter: "vllm",
    displayName: "vLLM",
    directoryName: "vllm",
    defaultOriginUrl: "https://github.com/vllm-project/vllm.git",
    tracking: "stable-tag",
    driftSupported: false,
    validateCheckout: markerCheckout("vllm/engine/arg_utils.py", "vLLM"),
  },
  {
    id: "sglang",
    adapter: "sglang",
    displayName: "SGLang",
    directoryName: "sglang",
    defaultOriginUrl: "https://github.com/sgl-project/sglang.git",
    tracking: "stable-tag",
    driftSupported: false,
    validateCheckout: markerCheckout(
      "python/sglang/srt/server_args.py",
      "SGLang",
    ),
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
