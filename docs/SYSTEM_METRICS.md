# System metrics

The `#/system` page plots CPU, memory, accelerator, disk and network activity over time instead of
showing instantaneous bars. This document covers the sampler that produces the series, the retention
tiers, and the constraints that shaped both.

## The recorder owns every delta

`apps/api/src/system/metrics-history.ts` runs one always-on sampler (`systemMetricsRecorder`) at 1 Hz,
started from `src/index.ts` before anything reads host resources and stopped during shutdown. It is
the **only** thing allowed to advance the counter-delta state of the rate-based samplers, and that is
structural rather than conventional: each `/proc` module exports a pure counter read plus a pure
activity builder, and the previous-counter state lives exclusively in recorder fields
(`previousCpu`/`previousNet`/`previousDisk`).

- `system/cpu.ts` — `readCpuCounters()` + `computeCpuActivity()`, `/proc/stat`, aggregate and
  per-core busy share (`total - idle - iowait`).
- `system/net.ts` — `readNetCounters()` + `buildNetworkActivity()`, `/proc/net/dev`, per-interface
  rx/tx bytes and packets.
- `system/disk.ts` — `readDiskCounters()` + `buildDiskActivity()`, `/proc/diskstats`.

Before the recorder existed, disk rates were computed between two arbitrary HTTP requests, so every
page that polled `/api/system/resources` (environments, the instance form, fleet) perturbed the rates
the others saw. `getSystemResources()` now reads `systemMetricsRecorder.current()` — a pure snapshot
read that never ticks — for `cpu`/`network`/`disk`; only memory, accelerators and NUMA are still read
inline, because none of them is a delta.

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
  (`/sys/class/net/<if>/…`) carry a 30 s TTL. Re-reading them every tick was the single largest
  avoidable cost.
- **GPU telemetry is a resident NVML session.** `nvidia/telemetry.ts` initialises NVML once and holds
  device handles, so a tick is three FFI calls per GPU rather than an `nvidia-smi` process spawn. The
  3 s accelerator cache means GPU series are stair-stepped relative to the 1 Hz CPU/disk series; if
  that becomes a problem, lower `acceleratorCacheMs` and re-measure on a host with real GPUs — NVML
  call latency was never measured here, only reasoned about.

## Retention tiers

`SYSTEM_METRICS_TIERS` defines three in-memory ring buffers. It lives in `packages/core` because the
web side derives its refetch cadence and live-buffer bound from the same table — mirroring the
numbers by hand let a server-side tier change drift silently past the client. Coarse tiers are fed by
averaging the 1 Hz samples inside each wall-clock bucket (`Math.floor(at / intervalMs)`), so tier
boundaries are aligned rather than relative to when the process started:

| Window | Interval | Capacity | Span |
| ------ | -------- | -------- | ---- |
| `live` | 1 s | 300 | 5 minutes |
| `hour` | 10 s | 360 | 1 hour |
| `day` | 60 s | 1440 | 24 hours |

A sample carries only what a chart plots. Per-core CPU detail and iowait were recorded at first, but
nothing ever read them — the per-core bars and the iowait line come from the `/api/system/resources`
poll, not from history — so an `ncores`-long array per second was ~40% of the live payload for a
series nobody drew. Add such a field back only together with the chart that consumes it, and give it
a retention rule instead of a per-field special case inside `averageSamples()`.

History is memory-only and does not survive a manager restart. On a self-update restart the graphs
start empty again.

## Surfaces

- `GET /api/system/metrics?window=live|hour|day` → `SystemMetricsHistory` (the tier's samples).
- `GET /api/system/metrics/stream` → SSE, one `sample` event per tick. The route buffers at most 300
  pending samples per subscriber so a stalled client cannot grow the queue without bound.
- Both are `/api/*` routes, so they are admin-gated and reverse-proxied to fleet peers by
  `app.all("/api/nodes/:id/*")` — `forwardToNode` streams the response body, so remote-node graphs
  work with no extra plumbing. Each peer runs its own recorder.

The web side (`ui/components/use-system-metrics.ts`) seeds from the history endpoint and then appends
live SSE samples for the `live` window; `hour` and `day` refetch on the tier interval instead, since
their samples are produced by server-side averaging. Samples are merged by timestamp, so a reconnect
cannot duplicate points.

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
