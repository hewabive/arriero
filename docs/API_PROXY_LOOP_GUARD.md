# API Proxy Loop Guard: runaway-generation detection

The `loop-guard` pipeline node watches the response text of a proxied request
for repetition loops — the failure mode where a model repeats a phrase, cycles
through a template, or collapses into low-entropy token babble until it
exhausts `max_tokens` or the context. It exists for consumers that neither show
the generation (especially hidden reasoning) nor allow cancelling it: the
proxy is the only place that sees every token and can stop the damage.

Source map:

- `apps/api/src/proxy/loop-guard.ts` — the pure detector (no IO, unit-tested
  against real captured loops in `loop-guard-fixtures/`).
- `apps/api/src/proxy/loop-guard-stream.ts` — SSE tap, synthetic finish tails,
  non-stream body feeding.
- `apps/api/src/proxy/response-plan.ts` — effect execution, artifacts, cache
  exclusion.
- `packages/core/src/index.ts` — `ApiProxyLoopGuardConfigSchema`.

## Loop classes and signals

Three real captured failure classes drive the design (each is a test fixture):

| class | example | caught by |
| --- | --- | --- |
| token babble | `l la de L l la…` (sampling collapse) | `entropy` (≈2.3 bits/char vs ≥4 for any real text), `compression` |
| exact phrase cycle | `---Запуск. ---Погнали. ---Поехали.` | `period` (smallest-period of the tail) |
| template cycle | `Let me think about the name Сергей <X>.` | `novelty` (share of unseen 16-char fragments → 0 once the enumeration repeats) |

Four signals are evaluated per channel (answer / reasoning / tool arguments)
every ~512 chars over a 16 KiB rolling tail, each normalized to a score where
1.0 = configured threshold:

- **`period`** — smallest exact period of the tail suffix (prefix-function
  over 512–4096-char windows); score = repeats / `periodMinRepeats`. Periods
  ≤ 4 chars require a 2 KiB window so legit separator runs don't fire. All
  four windows share one prefix-function pass computed over the *reversed*
  4096-char suffix (`suffixBorderLengths`): a string and its reverse have the
  same smallest period, and every window is a suffix of the tail — i.e. a
  prefix of the reversed sample — so `period(w) = w − π[w−1]` reads each
  window's answer from the single pass.
- **`novelty`** — rolling-hash 16-grams checked against everything already
  seen in the channel; score reaches 1.0 when the share of novel grams falls
  to `noveltyThreshold`. An honest first-pass enumeration stays ~0.5; only the
  second cycle through the same template goes to zero.
- **`compression`** — deflate ratio of the last 4 KiB vs `compressionThreshold`
  (reference 0.3 for normal prose).
- **`entropy`** — character entropy (bits/char) of the last 2 KiB vs
  `entropyThreshold` (reference 4.0). Separates babble (~2.3) from prose,
  code and tables (all ≥ 4).

Detection arms only after `minSpanChars` in a channel, and a trigger requires
the same signal at score ≥ 1.0 on **two consecutive evaluations** — earliest
possible trigger is ~2 KiB into a loop. The best sub-trigger moment is tracked
as a near-miss when its score reaches `nearMissRatio`. One detector per node
per request; the trigger latches.

## Node semantics

`loop-guard` is a response effect (positional, like capture/cache): it watches
the response text as transformed at its pipeline position. `action`:

- **`observe`** (default) — never touches the stream; records artifacts only.
  This is the calibration mode; deploy it first.
- **`finish`** — on a confirmed trigger in a **streaming** OpenAI-chat or
  Anthropic reply the guard, in order: appends `markerText` to the visible
  answer channel (empty string disables), emits a protocol-correct synthetic
  finish (`finish_reason: "length"` + `[DONE]`, or `content_block_stop` for
  open blocks + `message_delta {stop_reason: "max_tokens"}` + `message_stop`),
  terminates the downstream stream, excludes the response from response-cache
  storage and coalesced fan-out (`settleAbandonedApiProxyCacheEffects` at
  trigger time plus a cacheable veto at flush), and stops the upstream request
  via `apiProxyInflight.requestFinish` — the llama-server slot frees, external
  billing stops. There is no retry by design: the partial stream has already
  reached the consumer.

Coverage boundaries:

- OpenAI Responses SSE and non-stream bodies are **detected but never cut**
  (`finish` behaves as `observe`); non-stream detection runs post-hoc over the
  final body, which still yields artifacts and statistics.
- The resumable (preemption) path buffers and applies the plan as text, so it
  is post-hoc there too. An incremental hook in
  `resumable-forward.ts:applyFrame` is the known extension point.
- Force-answer instead of finish for reasoning-channel loops on managed
  targets (the existing `reasoning_control` interrupt) is a candidate next
  step once artifact statistics show how often loops live in reasoning.

## Artifacts and calibration

At request completion the node writes at most one request-file artifact
(`data/proxy-requests/…`, visible under Files in Request history):

- kind **`loop-guard-trigger`** (`captureTrigger`) — a trigger occurred;
  `enforced` says whether the stream was actually cut (`finish` mode on a
  supported shape).
- kind **`loop-guard-near-miss`** (`captureNearMiss`) — no trigger, but the
  peak score reached `nearMissRatio`.

The payload carries the firing signal, score, channel, position, a ~2 KiB tail
sample, a score timeline and the threshold snapshot — enough to judge whether
a hit was real and to retune thresholds from live traffic. Filter
`#/proxy/traces` by these file kinds; no schema or web changes are needed for
the kinds to appear.

Rollout: start with `observe` on the routes serving opaque apps, review
trigger/near-miss artifacts for false positives (code and tables are the risk
surface), then switch the calibrated routes to `finish`.
