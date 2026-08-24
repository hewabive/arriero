# CLAUDE.md — process domain

Supervision of managed engine instances: preflight, launch, adoption, health summary, logs.

## Launch and survival

- Instances are launched directly as child processes (`child_process.spawn`, `detached`, own pgid) by
  `supervisor.ts` — **`systemd` is not involved**. Children write stdout/stderr straight to the
  `.raw.log` file fd (no pipes, so they survive manager death without EPIPE); the supervisor tails
  the raw file (`raw-log-tail.ts`) to build the filtered log and emit `log` events.
- Managed processes **survive manager restarts by default**: on startup `reconcile.ts` re-adopts each
  open `process_runs` row whose PID is alive and whose `/proc/<pid>/cmdline` matches the per-run
  launch snapshot (`launch-snapshot.ts`). An adopted runtime is controlled by PID — no child handle,
  exit detected by poll, `exitCode` unavailable, unexpected death ⇒ `error` — and its log tail
  resumes from raw EOF. Unmatched live PIDs fall back to `stale` (`stale.ts`). Set
  `ARRIERO_STOP_MANAGED_ON_EXIT=true` to stop children on manager exit instead.
- The launch snapshot also powers config-drift detection: `InstanceHealthSummary.configDrift` flags a
  live process whose instance args/env/binary/`numa` changed since launch (the web shows a
  `config drift` badge).

## NUMA

Optional per-instance NUMA control lives in the `numa/` domain (`topology`/`capability`/`cgroup`/
`launch`). `instance.numa` is a discriminated union of `{mode:"bind",node}` (CPUs and memory confined
to one node via a cpuset cgroup plus a spawn shim) and `{mode:"interleave",nodes}` (spawn wrapped in
`numactl --interleave`, the high-throughput mode for big CPU models). `resolveNumaLaunch(…)` is the
single place that picks the spawn wrapper; `SystemResources.numa.{bind,interleave}` gate it. On a
single-node (UMA) host `instance.numa` is inert everywhere — `numaIsApplicable` gates launch, KT
preflight and the prerequisites numa group. `bind` additionally needs a one-time `Delegate=cpuset`
drop-in (`scripts/setup-numa-cgroup-delegation.sh`) **and** the manager running inside that user
session. See `docs/NUMA_PINNING.md`.

## Health and runs

- The health summary turns an otherwise-healthy instance `degraded` on two runtime signals sampled in
  `runtime-memory.ts`: ≥64 MiB swapped out across the instance's pids (`swapBytes`), and — for a
  running `interleave` instance — NUMA placement skew where one node holds >1.5× its even share
  (`numaPlacement`, `numa skew` badge; the page-cache flood trap is in `docs/NUMA_PINNING.md`).
- `process_runs` keeps the last 20 closed runs plus open runs per instance
  (`runs-repository.ts`). Every close records a `stopReason` — `operator` / `eviction` / `idle` /
  `shutdown` / `delete` / `stale` / `crash`, owned by core `process.ts:ProcessStopReason`.
- The filtered log strips routine `/health`, `/props`, `/slots` and `/v1/models` probes;
  `ARRIERO_FILTER_PROBE_LOGS=false` disables filtering.
