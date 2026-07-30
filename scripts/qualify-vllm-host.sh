#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <environment-bin-directory> <artifact-directory>" >&2
  exit 2
fi

bin_dir=$1
artifact_dir=$2
vllm=$bin_dir/vllm
python=$bin_dir/python
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ ! -x $vllm || ! -x $python ]]; then
  echo "expected executable vllm and python in $bin_dir" >&2
  exit 1
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "vLLM CUDA qualification requires Linux x86-64" >&2
  exit 1
fi

mkdir -p "$artifact_dir"
uname -a >"$artifact_dir/uname.txt"
lscpu >"$artifact_dir/lscpu.txt"
(cd "$repo_dir" && pnpm --filter @arriero/api nvml:report) \
  >"$artifact_dir/nvml.json"
nvidia-smi -q >"$artifact_dir/nvidia-smi.txt"
if command -v lspci >/dev/null 2>&1; then
  lspci -nnk -d 10de: >"$artifact_dir/nvidia-pci.txt"
fi
if command -v numactl >/dev/null 2>&1; then
  numactl --hardware >"$artifact_dir/numa.txt"
fi

start_ns=$(date +%s%N)
set +e
"$vllm" serve --help=all >"$artifact_dir/vllm-serve-help.txt" 2>&1
help_status=$?
set -e
end_ns=$(date +%s%N)
printf '%s\n' "$(((end_ns - start_ns) / 1000000))" \
  >"$artifact_dir/help-wall-ms.txt"
printf '%s\n' "$help_status" >"$artifact_dir/help-exit-code.txt"

"$python" - <<'PY' >"$artifact_dir/runtime.txt"
import importlib.metadata
import platform
import sys

import torch
import vllm

print("python=" + sys.version.replace("\n", " "))
print("platform=" + platform.platform())
print("vllm=" + importlib.metadata.version("vllm"))
print("vllm_module=" + str(vllm.__file__))
print("torch=" + torch.__version__)
print("torch_cuda=" + str(torch.version.cuda))
print("cuda_available=" + str(torch.cuda.is_available()))
if torch.cuda.is_available():
    for index in range(torch.cuda.device_count()):
        capability = torch.cuda.get_device_capability(index)
        print(
            f"cuda_device_{index}={torch.cuda.get_device_name(index)} "
            f"sm_{capability[0]}{capability[1]}"
        )
PY

"$python" - <<'PY' >"$artifact_dir/freeze.txt"
import importlib.metadata

for distribution in sorted(
    importlib.metadata.distributions(),
    key=lambda item: (item.metadata.get("Name") or "").lower(),
):
    name = distribution.metadata.get("Name")
    if name:
        print(f"{name}=={distribution.version}")
PY

sha256sum "$vllm" "$python" >"$artifact_dir/entrypoint-sha256.txt"

echo "host qualification artifacts written to $artifact_dir"
echo "continue with the live-engine gate in docs/VLLM_OPERATIONS.md"
