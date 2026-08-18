import { createHash } from "node:crypto";

import { parseSglangArgumentOptions } from "./sglang-help-parser.js";

const FALLBACK_HELP = `usage: sglang serve [options]

Server:
  --host HOST                         Bind host (default: 127.0.0.1)
  --port PORT                         Bind port (default: 30000)
  --api-key API_KEY                   API key required by the server
  --served-model-name NAME            Model name exposed by the API

Model:
  --model-path PATH, --model PATH     Model path or Hugging Face id
  --trust-remote-code                 Trust remote model code
  --context-length TOKENS             Maximum context length

Parallelism:
  --tensor-parallel-size N, --tp N    Tensor parallel worker count
  --max-running-requests N            Maximum concurrent running requests

Memory:
  --mem-fraction-static RATIO         Fraction of GPU memory reserved for the static pool

KTransformers:
  --kt-weight-path PATH               CPU-side expert weight path
  --kt-method {AMXINT4,AMXINT8,RAWINT4,FP8,FP8_PERCHANNEL,BF16,LLAMAFILE}
                                      KTransformers compute method
  --kt-cpuinfer N                      Number of physical CPU inference threads
  --kt-threadpool-count N             Number of KTransformers CPU thread pools
  --kt-numa-nodes NODE [NODE ...]     NUMA node assigned to each thread pool
  --kt-num-gpu-experts N              Experts placed on the GPU
  --kt-gpu-experts-ratio RATIO        Fraction of experts placed on the GPU
`;

export const sglangFallbackHelpHash = `fallback:${createHash("sha256")
  .update(FALLBACK_HELP)
  .digest("hex")}`;

export function sglangFallbackArgumentOptions() {
  return parseSglangArgumentOptions(FALLBACK_HELP);
}
