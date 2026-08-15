# NUMA pinning

Manual, per-instance binding of a managed `llama-server` to one NUMA node on
multi-socket hosts (e.g. dual-socket Xeon/EPYC). The topology is surfaced and
the binding is enforced. Memory budgeting per node is **not** implemented —
fitting a node's RAM is the operator's responsibility (see "Scope" below).

## Two states, no soft tier

- **cgroup v2 cpuset available** → hard isolation: the instance's CPUs and memory
  are confined to the chosen node and `llama-server` cannot escape it (a
  `cpuset.cpus`/`cpuset.mems` ceiling overrides any `sched_setaffinity` the
  process makes itself, unlike the soft `--numa`/`--cpu-mask` flags).
- **otherwise** → the feature is off and the instance launches exactly as before
  (kernel schedules across all nodes). A stored `numa` binding is inert on such a
  host. There is deliberately no soft `numactl`/`taskset` fallback for `bind`.

`instance.numa` is a discriminated union: `{ mode: "bind", node }` (this doc) and
`{ mode: "interleave", nodes }` (memory interleaved across nodes via `numactl
--interleave` — the high-throughput mode for big CPU models; no cgroup needed).
The whole concern lives in the `numa/` domain (`topology`/`capability`/`cgroup`/
`launch`), and `resolveNumaLaunch(instance, …)` is the single place that turns a
config into a spawn wrapper.

## Single-node (UMA) hosts

Everything above presumes ≥2 nodes. `numaIsApplicable(topology)`
(`apps/api/src/numa/topology.ts`, true only for a multi-node topology) is the
one predicate for "NUMA matters on this host", and on a single-node machine the
whole feature is inert by construction:

- `resolveNumaLaunch` returns the plain launch for **any** stored `numa` config
  — including a `bind` to a node id that does not exist here. Config carried
  over from a multi-socket host via config-git stays valid and launches
  normally; the "node not present" error is reserved for genuinely multi-node
  hosts with a wrong id.
- The KTransformers preflight skips manager-NUMA validation (interleave
  forbidden, bind/`--kt-numa-nodes` match); engine-internal `--kt-*` argument
  checks still run against the real topology.
- The `numactl`/`cpuset-delegation` prerequisites are not applicable
  (`docs/PREREQUISITES.md`), and the web UI hides the topology panel and the
  NUMA form section — the instance form shows only an inert-config notice with
  a clear action when an imported instance carries a `numa` binding.

`SystemResources.numa.{ bind, interleave }` stay raw host facts (probed
regardless of node count); consumers gate on the topology, not on the
capability flags.

Capabilities are probed at startup (`apps/api/src/numa/capability.ts`) into
`SystemResources.numa.{ bind, interleave }` (booleans, shown in the UI): `bind`
needs cgroup v2 unified **and** `cpuset` enabled in the delegated
`user@<uid>.service` `cgroup.subtree_control` (children we create there can
actually use it — not merely that the controller is _available_); `interleave`
needs only `numactl` on `PATH`.

## Why cgroup, not numactl

`llama-server`'s own `--numa`/`--cpu-mask` flags are hints: they steer thread
spawn but not physical page placement, and llama's help even warns to drop the
page cache before NUMA runs. `cpuset.mems` instead governs the page faults of the
mmap'd weights, so placement is guaranteed without `--no-mmap`. The trade-off:
`cpuset.mems` is a hard cap — exceed the node's free RAM and you OOM (this is why
budgeting must eventually land; until then it is on the operator).

## cgroup layout

Instance cgroups live under the **delegated user manager root**, not under the
manager's own cgroup — so they are writable regardless of how the manager was
launched (login `session.scope` or a `user@.service` unit), and a manager
restart with the default `KillMode=control-group` does not reap the children:

```
/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/arriero-instances/<instance-name>/
```

Only `user@<uid>.service` is delegated (writable) — `user-<uid>.slice` is not — so
`resolveInstancesGroupDir` (`apps/api/src/numa/cgroup.ts`) anchors there: it
reads `/proc/self/cgroup` and, whether self is a session scope under the slice or
already inside `user@<uid>.service`, resolves the group under that delegated root.
Overridable with `ARRIERO_NUMA_CGROUP_ROOT` (e.g. for the system-service
model). On start the manager `mkdir`s the group,
enables `+cpuset` in its `cgroup.subtree_control`, creates the per-instance
cgroup, and writes `cpuset.mems = <node id>` then `cpuset.cpus = <node cpulist>`.

## Race-free join via a shim

To bind the _first_ allocation (so weight faulting lands on the node), the
process must start already inside the cgroup. The supervisor therefore launches

```
sh -c 'echo $$ > <cgroup>/cgroup.procs && exec <binary> <args…>'
```

`exec` replaces the shell image in the same PID, so `/proc/<pid>/cmdline` becomes
the plain `llama-server` argv — the launch-snapshot adoption (`reconcile.ts`,
matched on the binary path) is unaffected. `&&` means a failed join aborts the
launch instead of silently running unpinned.

## Restart / adoption

A cgroup is a kernel object independent of its creator, so it survives manager
death like the detached child does, and the kernel keeps enforcing the binding.
On restart the manager re-adopts the live PID as usual and reconstructs the
cgroup path from the instance name. Cleanup of empty leftover cgroups runs after
reconcile (`cleanupOrphanNumaCgroups`); a live instance's cgroup is non-empty and
left alone. On exit the supervisor `rmdir`s the instance's (now empty) cgroup.

Prerequisite for survival across logout: the cgroup parent must outlive the
children — run the manager under a lingering session (`loginctl enable-linger`)
or a persistent unit. This is the same constraint the detached-survival feature
already has; cgroups do not worsen it.

## Privilege: a one-time delegation, no per-launch sudo

`cpuset` is **not** delegated to user sessions by default. Enable it once as root
with the helper:

```
sudo scripts/setup-numa-cgroup-delegation.sh <user-that-runs-arriero>
```

It writes the drop-in below, `daemon-reload`s, enables linger, enables `+cpuset`
down the `cgroup.subtree_control` chain (root → `user.slice` →
`user-<uid>.slice` → `user@<uid>.service`) so it activates live, and verifies:

```
# /etc/systemd/system/user@.service.d/delegate-cpuset.conf
[Service]
Delegate=cpu cpuset memory pids
```

The drop-in makes delegation persistent across reboots; the `subtree_control`
chain-enable makes it active immediately. (Delegation only puts `cpuset` in a
cgroup's `cgroup.controllers` — _available_ — but children can use it only once
it is also in `cgroup.subtree_control` at every level down to the delegated root.)
If the live enable can't be applied, the change takes effect when
`user@<uid>.service` next **restarts** — `systemctl restart user@<uid>.service`
or a reboot. Note: with linger enabled a plain logout/login does **not** restart
the user manager, so re-login alone is not enough. After this the manager creates
and writes cgroups as the normal user — **no sudo at launch**. Without it the
`bind` capability is `false` and bindings stay inert. If the manager runs as a
_system_ service instead, put the same `Delegate=` on that unit.

**The manager must run inside that delegated user session.** Delegation only
grants the `user@<uid>.service` subtree; a process started from a shell that
landed in `system.slice` (e.g. SSH with logind not registering sessions, common
on AD/SSSD servers) cannot create/move cgroups into the delegated subtree (the
cross-tree move needs root over the common ancestor). Run the manager as a
`systemctl --user` service (lingering already on) or via `systemd-run --user
--scope` so it lives under `user@<uid>.service`. `bind` reports `false` otherwise.

## Drift

`numa` is part of the launch snapshot, so changing an instance's binding while it
runs raises the existing `configDrift` badge (a live process cannot be re-pinned
without restart — `cpuset.mems` changes do not migrate resident pages).

## Interleave placement skew (the page-cache trap)

`numactl --interleave` (and `--no-mmap` / `--numa distribute`) only place memory
evenly **if every target node has free pages at fault time**. A node whose RAM is
already full of clean page cache — classically after a bulk file copy that floods
one node's cache via a single-threaded reader — cannot take its interleave share,
so with the default `vm.zone_reclaim_mode=0` the allocator falls back to other
nodes instead of reclaiming. The weight buffer ends up lopsided, memory bandwidth
collapses to a single controller (~30% throughput loss), and the skew **survives
process restarts** because the polluting page cache is system-wide and clean.
`sync; echo 1 | sudo tee /proc/sys/vm/drop_caches` (or copying with `nocache`)
clears it; `vm.zone_reclaim_mode=1` prevents it structurally on a dedicated box.

Two read-only signals surface this without a CLI:

- **System resources** shows per-node free RAM and page cache (`FilePages`) from
  `node*/meminfo`, with the cache badge reddening as a node fills — the predictor.
- **Health summary** measures the actual layout once per run: when an
  `interleave` instance is `running` and healthy, `getInstanceNumaPlacement`
  reads `/proc/<pid>/numa_maps` (summing `N<node>=` weighted by
  `kernelpagesize_kB` across the instance's pids), computes the max-node share vs
  the ideal `1/nodes`, and caches it by run id. A node holding more than
  `1.5 × ideal` flips `numaPlacement.even` to false, turning the otherwise-healthy
  instance `degraded` with a `numa skew` badge. The page-table walk is the reason
  the measurement is one-shot-per-run and gated on `health.ok` (post-load), not
  polled on every health tick.

## Config & update semantics

`numa` is an optional discriminated-union field on the instance config
(file-backed, portable; inert on hosts without the capability). It replaced the
flat `numaNode` field (migration `0008` rewrites `numaNode: N` → `{ mode: "bind",
node: N }` and drops the source). The web form submits the full desired state, so
updates use **replace** semantics: an omitted `numa` clears the binding.

## Scope (what is intentionally absent)

- **No per-node memory budgeting.** The scheduler/admission ledger still treats
  `host` as one pool; nothing prevents over-subscribing a node's RAM. Fitting the
  node is on the operator. Splitting `host` per node is a later phase (see
  `RESOURCE_MANAGEMENT.md`).
- **No auto-binding.** Binding is manual; the topology panel shows which GPU sits
  on which node so the operator can bind by hand.
- **No cgroup v1.** v2 unified only; v1 hosts land on the off state.
