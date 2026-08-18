# System metrics

The `#/system` page plots CPU, memory, accelerator, disk, network and host-wide RDMA activity over
time instead of showing instantaneous bars. This document covers the sampler that produces the
series, the retention tiers, and the constraints that shaped both.

## The recorder owns every delta

`apps/api/src/system/metrics-history.ts` runs one always-on sampler (`systemMetricsRecorder`) at 1 Hz,
started from `src/index.ts` before anything reads host resources and stopped during shutdown. It is
the **only** thing allowed to advance the counter-delta state of the rate-based samplers, and that is
structural rather than conventional: each counter module exports a pure counter read plus a pure
activity builder, and the previous-counter state lives exclusively in recorder fields
(`previousCpu`/`previousNet`/`previousDisk`/`previousRdma`).

- `system/cpu.ts` — `readCpuCounters()` + `computeCpuActivity()`, `/proc/stat`, aggregate and
  per-core busy share (`total - idle - iowait`).
- `system/net.ts` — `readNetCounters()` + `buildNetworkActivity()`, `/proc/net/dev`, per-interface
  rx/tx bytes and packets.
- `system/disk.ts` — `readDiskCounters()` + `buildDiskActivity()`, `/proc/diskstats`.
- `system/rdma.ts` — `readRdmaCounters()` + `computeRdmaActivity()`, the receive/transmit data
  counters for a single active `/sys/class/infiniband/<device>/ports/<port>`.
- `system/storage-space.ts` — mounted local/BeeGFS filesystem discovery plus per-mount `statfs`
  capacity.

Before the recorder existed, disk rates were computed between two arbitrary HTTP requests, so every
page that polled `/api/system/resources` (environments, the instance form, fleet) perturbed the rates
the others saw. `getSystemResources()` now reads `systemMetricsRecorder.current()` — a pure snapshot
read that never ticks — for `cpu`/`network`/`disk`/`rdma`; only memory, accelerators and NUMA are
still read inline, because none of them is a delta.

Filesystem capacity is intentionally separate from the 1 Hz counter recorder. The resources
endpoint discovers mounted local storage filesystems plus BeeGFS, starts an asynchronous `statfs`
refresh for each mount, and returns the last successful value immediately. Pseudo, in-memory and
unrelated network filesystems are excluded so the compact table represents disk space rather than
every mount namespace entry. Mount paths that never hold application data are also excluded:
`/boot` (including `/boot/efi`), `/efi`, and container-runtime internals (`/var/lib/docker`,
`/var/lib/containers`, `/var/lib/kubelet`, `/run/containerd`) — the latter keep per-container
overlay mounts from flooding the table while an overlay root filesystem stays visible. Refreshes have a 30-second TTL and never overlap for the same mount, so
a BeeGFS kernel-client call that waits for its own cluster-side capacity refresh does not hold the
HTTP response. BeeGFS reports inode totals as zero when they are unsupported; those values become
`null` and are omitted from the page. No BeeGFS userspace CLI or package is required. Without a
BeeGFS mount the shared storage table still shows local filesystems, while BeeGFS-specific rows and
the RDMA chart are absent.

RDMA traffic is sampled at 1 Hz only when exactly one active HCA port exposes both standard data
counters. The counters are 64-bit values in four-byte units, so the recorder keeps them as `bigint`,
computes the delta, multiplies by four, and only then emits numeric bytes per second. A reset, port
change or read failure creates a gap. The counters cover all traffic on the port: on a BeeGFS host
they commonly approximate filesystem reads (receive) and writes (transmit), but concurrent NCCL or
other RDMA traffic is inseparable and is labelled accordingly in the UI. Zero or multiple active
ports produce no RDMA series rather than a guessed port or an aggregate.

The recorder must therefore start before the first `getSystemResources()` caller
(`ensureResourcePoolsScaffold()`), otherwise that caller sees an all-null snapshot until the first
tick. Starting it after that call is what used to produce a bogus startup sample: the request-path
bootstrap tick and `start()` landed ~30 ms apart, and a jiffy delta that small rounds to 100% CPU and
showed up as a spike at the left edge of the graph.

## Why it runs unconditionally

Measured on a 4-core / 1-NUMA-node / 1-disk host, a full `getSystemResources()` costs 0.36 ms avg
(p95 0.46 ms). At 1 Hz that is ~0.04% of one core; extrapolated to a 64-core, multi-GPU, 8-disk box
it stays near 0.1–0.2%. That is cheap enough that gating the sampler on active viewers buys nothing
and costs the history a user opens the page to look at.

Two things keep it cheap and must stay that way:

- **Static metadata is cached.** Disk model/rotational/size (`/sys/block/<dev>/…`) is read once per
  device, and so is the reportability probe that decides whether a `/proc/diskstats` name is a whole
  block device — partitions are not directories under `/sys/block`, so an uncached probe threw and
  caught one `ENOENT` per partition per tick. Interface speed and operstate
  (`/sys/class/net/<if>/…`) carry a 30 s TTL. RDMA active-port discovery uses the same TTL; only the
  two selected counter files are read every tick. Re-reading static metadata every tick was the
  single largest avoidable cost.
- **GPU telemetry is a resident NVML session.** `nvidia/telemetry.ts` initialises NVML once and holds
  device handles, so a tick is three FFI calls per GPU rather than an `nvidia-smi` process spawn. The
  3 s accelerator cache means GPU series are stair-stepped relative to the 1 Hz CPU/disk series; if
  that becomes a problem, lower `acceleratorCacheMs` and re-measure on a host with real GPUs — NVML
  call latency was never measured here, only reasoned about.

## Retention tiers

`SYSTEM_METRICS_TIERS` defines four in-memory ring buffers. It lives in `packages/core` because the
web side derives its refetch cadence and live-buffer bound from the same table — mirroring the
numbers by hand let a server-side tier change drift silently past the client; the coarse subset is
`SystemMetricsCoarseWindowSchema` (the window enum minus `live`), so a new tier reaches
accumulation/persistence/prune without touching a hand-kept list. Each coarse tier folds samples
from a source tier declared in `COARSE_TIER_SOURCES` (`system/metrics-history.ts`): `hour` and `day`
average the 1 Hz ticks inside each wall-clock bucket (`Math.floor(at / intervalMs)`), while `month`
averages closed `day` buckets — the same average-of-averages the boot backfill produces, and it caps
the pending state at ~30 held samples instead of 1800 raw ticks per month bucket. A tier's interval
must be a whole multiple of its source tier's interval so buckets nest; a cascaded tier closes one
source interval later than its wall-clock boundary (the closing signal is the first source sample
of the next bucket). Bucket boundaries are aligned rather than relative to when the process
started:

| Window | Interval | Capacity | Span |
| ------ | -------- | -------- | ---- |
| `live` | 1 s | 300 | 5 minutes |
| `hour` | 10 s | 360 | 1 hour |
| `day` | 60 s | 1440 | 24 hours |
| `month` | 30 min | 1440 | 30 days |

A sample carries only what a chart plots. Per-core CPU detail and iowait were recorded at first, but
nothing ever read them — the per-core bars and the iowait line come from the `/api/system/resources`
poll, not from history — so an `ncores`-long array per second was ~40% of the live payload for a
series nobody drew. Add such a field back only together with the chart that consumes it, and give it
a retention rule instead of a per-field special case inside `averageSamples()`.

## Persistence

The `live` tier is memory-only, but closed `hour`/`day`/`month` buckets survive a manager restart.
When `accumulate()` finishes a wall-clock bucket, the recorder emits the averaged sample to coarse
subscribers, and `attachSystemMetricsPersistence` (`system/metrics-repository.ts`) upserts it into
the `system_metrics_history` table keyed by `(window, bucket start)`. On boot
`seedSystemMetricsRecorder()` reads each tier's span back into its ring buffer before the recorder
starts, so the coarse graphs resume where they left off and the downtime renders as an honest gap
via the chart's gap-break rule. The order matters — prune, then month backfill, then seed, then
attach, all before `recorder.start()` — so the whole sequence is one call,
`initSystemMetricsPersistence()`, and the entrypoint cannot reorder it.

Two deliberate limits. The pending partial bucket is dropped at shutdown rather than flushed —
merging pre- and post-restart state into one bucket would hide the restart, and the counter-delta
state is process-local anyway, so the first post-boot tick has no rates. And a tier is only ever
seeded from rows written for that same tier: samples spaced at a different interval would trigger
the gap-break logic between every pair of points.

The month tier is additionally backfilled at boot: `backfillSystemMetricsMonthTier()` derives every
missing complete 30-minute bucket by averaging the persisted `day` rows inside it, skipping the
in-progress bucket and buckets that already have a month row. That gave the tier up to 30 days of
history the day it shipped, and it keeps healing afterwards — a month bucket the manager slept
through entirely is reconstructed from its `day` rows at the next boot, while a bucket spanning the
restart keeps its post-restart average only (the same class of loss as the dropped pending bucket).

Retention is per window: a tier's rows are kept for its own span (exactly what reseeding needs),
except `day` rows are kept for `max(day span, month span)` = 30 days because they double as the
backfill source for the month tier — computed from `SYSTEM_METRICS_TIERS` so a month-tier resize
cannot silently shrink the source window. A boot-time prune plus an hourly loop
(`startSystemMetricsRetentionLoop`, the shared `db/retention.ts` scaffold) keep the table
bounded. The write cost is one upsert per closed bucket (6/min + 1/min + 2/h), small enough that
the recorder's own WAL traffic stays invisible in its disk charts — persisting every 1 Hz tick was
rejected for exactly that self-observation plus the fact that no chart reads 1 s resolution beyond
the 5-minute live window.

## Surfaces

- `GET /api/system/metrics?window=live|hour|day|month` → `SystemMetricsHistory` (the tier's samples).
- `GET /api/system/metrics/stream` → SSE, one `sample` event per tick. The route buffers at most 300
  pending samples per subscriber so a stalled client cannot grow the queue without bound.
- Both are `/api/*` routes, so they are admin-gated and reverse-proxied to fleet peers by
  `app.all("/api/nodes/:id/*")` — `forwardToNode` streams the response body, so remote-node graphs
  work with no extra plumbing. Each peer runs its own recorder.

The web side (`ui/components/use-system-metrics.ts`) seeds from the history endpoint and then appends
live SSE samples for the `live` window; `hour` and `day` refetch on the tier interval instead, since
their samples are produced by server-side averaging. Samples are merged by timestamp, so a reconnect
cannot duplicate points.

## Event-loop stall verdicts

`system/event-loop.ts` owns the stall monitor: the recorder tick calls `eventLoopMonitor.sample(at)`
once per second, and a max lag ≥ 250 ms becomes an `EventLoopStall` served at
`GET /api/system/event-loop` and logged as a `warn`. Culprit attribution via `traceBlockingSection`
only sees code that opted in, so every stall also carries a **verdict** answering the question
attribution cannot: did arriero's own code block the loop, or did the host starve the process?

Three per-tick counters are read alongside the lag histogram (the whole set costs ~16 µs, measured):

- `/proc/thread-self/schedstat` — the event-loop thread's on-CPU time and, crucially, its
  **run_delay**: time spent runnable but waiting in the scheduler queue. Kernel-maintained,
  per-thread, and the only signal that names external CPU contention directly. `thread-self`
  matters: the tick runs on the main thread, which *is* the event loop; `process.cpuUsage()` was
  rejected because it sums worker threads (GGUF parser) and would misattribute their burn.
- `performance.eventLoopUtilization()` — active time distinguishes "the loop sat inside a callback"
  from "the wakeup itself was delayed".
- `process.resourceUsage().majorPageFault` — page-in from disk (swap or mmap). Process-wide, hence
  used only as a refinement, never as the primary discriminator.

Deltas are taken between consecutive `sample()` calls, so they cover the same ~1 s window as the lag
histogram. Classification (`classifyStall`) checks in strict order, first match wins:

1. `starved` — run_delay ≥ 50 % of the lag. Checked first because starvation while executing a
   callback also inflates ELU active time (a stretched callback is still "active"), so ELU cannot
   veto this verdict.
2. `self-cpu` — own thread CPU ≥ 70 % of the lag: the loop computed through the stall (GC included).
3. `paging` / `self-wait` — ELU active ≥ 70 % of the lag with low CPU: the loop sat in a callback
   waiting on something synchronous. ≥ 16 major faults in the window means the wait was page-in
   (`paging`); otherwise sync I/O or a sync child (`self-wait`), where `traceBlockingSection`
   culprits usually name the call site.
4. `unknown` — nothing dominant (also: schedstat unreadable, e.g. non-Linux, or the first tick after
   boot, which has no delta window yet).

The share thresholds come from measured separation on a 4-core host: an injected 300 ms sync block
scored 307 ms CPU / 1.5 ms run_delay, an `execSync` wait scored 315 ms ELU active / 6 ms CPU, and
scheduler starvation under pinned CPU hogs scored 1792 ms run_delay against 229 ms CPU over a 2 s
window — each scenario saturates exactly one signal, so 50–70 % shares leave wide margins on both
sides. Pure CPU pressure against an *idle* loop produces almost no lag on EEVDF kernels (sleepers
wake with priority); starvation stalls appear when the loop is busy, which is when run_delay
accumulates. The verdict and its signal receipt land in the stall record, the `warn` log line, and
the System resources page, so a one-off stall is attributable after the fact without any profiler.

## Charts

`ui/components/MetricChart.tsx` is a hand-written SVG area chart — no charting dependency. It plots
against a **time** axis over a fixed window, not against sample index: when the buffer is only
partly full the data occupies the right-hand edge and fills leftwards, and a gap longer than 2.5×
the tier's `intervalMs` breaks the path instead of interpolating across it. That matters because a
manager restart, a suspended host, or a backgrounded browser tab all produce real gaps — and the
spacing has to come from the tier (the `axis` prop carries `times`/`windowMs`/`intervalMs` together),
not from dividing the window by however many samples happen to be in hand, which under-reports gaps
on a partly filled buffer. Segment geometry and path strings are memoized on the axis and series, so
hovering only moves the crosshair instead of rebuilding every path per pointer event.

Series colors come from `ui/components/metric-palette.ts`, keyed by role (`cpu`, `memory`, `gpuLoad`,
`gpuMemory`, `inbound`, `outbound`) with separate light and dark steps validated for colorblind
separation against both surfaces. Two of the light-mode steps sit below 3:1 contrast, which is why
every chart carries its current value as a visible headline rather than relying on the mark alone.
