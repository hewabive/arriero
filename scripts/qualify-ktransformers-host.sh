#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <environment-bin-directory> <artifact-directory>" >&2
  exit 2
fi

bin_dir=$1
artifact_dir=$2
sglang=$bin_dir/sglang
python=$bin_dir/python
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ ! -x $sglang || ! -x $python ]]; then
  echo "expected executable sglang and python in $bin_dir" >&2
  exit 1
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "KTransformers qualification requires Linux x86-64" >&2
  exit 1
fi
mkdir -p "$artifact_dir"
uname -a >"$artifact_dir/uname.txt"
lscpu >"$artifact_dir/lscpu.txt"
(cd "$repo_dir" && pnpm --filter @arriero/api nvml:report) \
  >"$artifact_dir/nvml.json"
if command -v lspci >/dev/null 2>&1; then
  lspci -nnk -d 10de: >"$artifact_dir/nvidia-pci.txt"
fi
if command -v numactl >/dev/null 2>&1; then
  numactl --hardware >"$artifact_dir/numa.txt"
fi

start_ns=$(date +%s%N)
"$sglang" serve --help >"$artifact_dir/sglang-serve-help.txt" 2>&1
end_ns=$(date +%s%N)
printf '%s\n' "$(((end_ns - start_ns) / 1000000))" >"$artifact_dir/help-wall-ms.txt"

"$python" - <<'PY' >"$artifact_dir/runtime.txt"
import importlib.metadata
import platform
import sys
import kt_kernel
import sglang

print("python=" + sys.version.replace("\n", " "))
print("platform=" + platform.platform())
for distribution in ("kt-kernel", "sglang-kt"):
    print(distribution + "=" + importlib.metadata.version(distribution))
print("kt_kernel=" + str(kt_kernel.__file__))
print("sglang=" + str(sglang.__file__))
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
sha256sum "$sglang" "$python" >"$artifact_dir/entrypoint-sha256.txt"

echo "host qualification artifacts written to $artifact_dir"
echo "continue with the live-engine checklist in docs/KTRANSFORMERS_OPERATIONS.md"
