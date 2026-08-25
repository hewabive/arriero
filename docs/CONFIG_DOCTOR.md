# Configuration doctor (host readiness)

What the tracked configuration references that **this host cannot satisfy** — computed on demand,
reported per check, never blocking anything. The report lives in `apps/api/src/doctor/report.ts`;
shapes in `packages/core/src/doctor.ts`.

## Scope and posture

Tree validation (`docs/CONFIG_GIT.md`) answers "is this configuration internally consistent" and
*does* block clone/pull/commit. The doctor answers the orthogonal question "can this machine run
it": paths that do not exist here, environments not installed, models not downloaded, secrets
absent from the machine-local stores. Those are per-host facts, so they are **advisory** —
adopting a valid tree on a host that still has provisioning to do must succeed, with the gap made
visible instead of discovered instance-by-instance at first start. The four instance status layers
(`docs/STATUS_LAYERS.md`) stay untouched: the doctor is a fifth, host-scoped view, closest in
spirit to the prerequisites report (`docs/PREREQUISITES.md`) — that one covers host tooling, this
one covers config-vs-host.

## Checks

| id | source | findings |
| --- | --- | --- |
| `instance-binaries` | `instances/repository.ts` resolved records | missing binary → error; dangling `binaryPathRefId` over a live inline path → info (expected after a clone — the catalog is machine-local) |
| `environments` | `envs/service.ts` records | spec not `installed` → warning |
| `model-requirements` | `hf/requirements.ts` satisfaction | `missing`/`partial` → warning; satisfied but revision drift → info |
| `instance-model-paths` | model-bearing args per engine kind | absolute path missing on disk → error |
| `resource-pools` | `doctorResourcePoolFindings` (injectable inventory) | orphaned pool with instance draws → warning; without → info |
| `proxy-credentials` | sources `keyConfigured`, `apiEndpointAuthHeaders`, proxy settings, webapp sources | endpoint env var empty → error; `allowAnonymous:false` with zero keyed sources → error; unkeyed source / webapp source → warning; keyless endpoint → info |
| `node-tokens` | `nodes/repository.ts` peers | enabled peer without a token → warning |
| `hf-token` | `hf/token.ts` + requirements | requirements exist, no token → info |
| `presets` | `presets/repository.ts` documents | absolute model/mmproj path missing → warning |

A check that throws is reported as `skipped` (and logged), never fails the report; embedding call
sites fetch the report via `getConfigDoctorReportOrNull`, which swallows and logs a total failure,
so a git operation can never be blocked by the doctor.

## Surfaces

- `GET /api/config-git/doctor` — fresh compute, admin-gated like the rest of `/api/*`.
- Every config-git mutation result (`ConfigGitMutationResult.doctor`) and a successful
  `POST /api/config/reload` (`ConfigReloadResult.doctor`) embed the post-operation report, so
  clone/pull/switch/restore answer "what still needs doing here" in the same response.
- Web: the **Host readiness** card on `#/config-git` (severity-colored findings, remediation in
  tooltips, per-check links to the owning pages) and the dashboard attention card (errors → red
  item, warnings → yellow, both linking to the Configuration Git page).
