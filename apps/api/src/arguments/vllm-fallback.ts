import { createHash } from "node:crypto";

import { parseVllmArgumentOptions } from "./vllm-help-parser.js";

const FALLBACK_HELP = `usage: vllm serve [model_tag] [options]

Frontend:
  --host HOST                         Bind host (default: 0.0.0.0)
  --port PORT                         Bind port (default: 8000)
  --api-key API_KEY                   API key required by the server
  --served-model-name NAME            Model name exposed by the API
  --disable-log-requests              Disable request logging

Model:
  --dtype {auto,float16,bfloat16,float32,half,float}
                                      Model data type (default: auto)
  --device {auto,cuda,cpu,rocm}        Device used by vLLM (default: auto)
  --trust-remote-code                  Trust remote model code
  --download-dir PATH                 Model download directory
  --generation-config PATH            Generation config source
  --max-model-len TOKENS              Maximum model context length
  --enforce-eager                     Disable CUDA graph execution

Parallelism:
  --tensor-parallel-size N            Tensor parallel worker count
  --pipeline-parallel-size N          Pipeline parallel worker count
  --data-parallel-size N              Data parallel worker count

Memory:
  --gpu-memory-utilization RATIO      GPU memory utilization ratio
  --swap-space GIB                    CPU swap space per GPU
  --cpu-offload-gb GIB                CPU offload capacity
  --max-num-seqs N                    Maximum concurrent sequences

LoRA:
  --enable-lora                       Enable LoRA adapters
  --lora-modules MODULES              LoRA module definitions
  --max-loras N                       Maximum concurrent LoRAs
`;

export const vllmFallbackHelpHash = `fallback:${createHash("sha256")
  .update(FALLBACK_HELP)
  .digest("hex")}`;

export function vllmFallbackArgumentOptions() {
  return parseVllmArgumentOptions(FALLBACK_HELP);
}
