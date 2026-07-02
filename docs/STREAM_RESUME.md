# Stream resume across manager restarts

Goal: a llama-manager restart (self-update, crash-free redeploy) must not cost
in-flight managed generations. The client's HTTP connection to the manager
necessarily breaks; what this feature guarantees is that a client retry of the
same request recovers the exact original generation instead of recomputing it.

## Upstream mechanism (llama.cpp SSE Replay Buffer)

llama.cpp commit `1a87dcdc4` (2026-06-26) added resumable stream sessions to
`llama-server` (`tools/server/server-stream.{h,cpp}`):

- A completion request carrying an `X-Conversation-Id` header gets a
  server-side session: SSE bytes are mirrored into a ring buffer and, on peer
  disconnect, generation continues into the buffer instead of being cancelled
  (`stream_aware_should_stop`).
- `GET /v1/stream/:conv_id?from=N` replays buffered bytes and tails the live
  generation until finalize. The replay is byte-identical upstream SSE, so all
  existing manager post-processing (usage meter, Anthropic translation,
  non-stream rebuild) applies unchanged.
- `POST /v1/streams/lookup` (`{"conversation_ids": [...]}`) reports liveness
  for ids the caller already owns; `DELETE /v1/stream/:conv_id` cancels and
  evicts, idempotently.
- Constraints that shape the design: the ring buffer is 4 MiB per session
  (constexpr — a longer generation loses its prefix and `from=0` returns 400),
  completed sessions are GC'd 300 s after finalize (live sessions never
  expire), and `create_or_replace` cancels a previous session with the same
  conversation id.

The `stream-resume` capability probe (`llama/capabilities.ts`) detects support
via `POST /v1/streams/lookup` with an empty id list (200 = supported, 404 =
old binary).

## Manager design

Four pieces, one per implementation phase:

1. **Header hygiene** (`proxy/http.ts`): client-supplied `X-Conversation-Id` /
   `X-Stream-Resume` are stripped from forwarded headers. Pass-through would
   let one client request cancel another's live session via
   `create_or_replace`, and conversation ids must be manager-owned for resume
   to work.

2. **Session registry** (`proxy/stream-session.ts`): every managed
   chat.completions/messages forward whose upstream is SSE (the plain
   `respond()` path) registers a session keyed by the in-flight request id: a
   fresh uuidv7 conversation id sent upstream via `X-Conversation-Id`, plus a
   **resume key** — sha256 over the canonicalized post-pipeline,
   post-translation upstream body (attribution `cch` churn pinned by
   `sanitizeClaudeCodeAttribution`, `stream`/`stream_options` excluded) ⊕
   instance ⊕ upstream path ⊕ model. When the request settles or the client
   aborts, the registry fires `DELETE /v1/stream/:id` — required because a
   session-attached upstream no longer stops on connection drop, so
   cancellation semantics must be restored explicitly. The preemptible
   `respondResumable()` path deliberately does **not** attach sessions: its
   preemption cycle frees slots by aborting the upstream fetch, and a detached
   generation would keep the slot busy through slot-save.

3. **Persist/adopt** (`proxy/pending-resume.ts`): on SIGTERM the registry
   snapshot is written to `data/proxy-pending-resume.json` before the HTTP
   server closes (suppressing the settle-time DELETEs); skipped when
   `LLAMA_MANAGER_STOP_MANAGED_ON_EXIT=true` since the children die anyway. On
   boot the file is consumed (single-shot), entries are verified via
   `/v1/streams/lookup`, and survivors wait for a claim within
   `LLAMA_MANAGER_PROXY_RESUME_CLAIM_WINDOW_MS` (default 180 000, kept under
   the llama.cpp 300 s post-completion TTL). Expired entries are DELETEd by
   the idle-maintenance sweep so orphaned generations stop burning compute.
   While pending or claimed, the entries' targets ride
   `pinnedTargetIds` — a hard scheduler exclusion from memory eviction and
   idle-unload (unlike the soft `protectedTargetIds` ordering bias) — because
   a detached generation is invisible to the manager's `activeRequests` after
   a restart and would otherwise be unloaded mid-run.

4. **Replay forward** (`proxy/resume-replay.ts`): before gateway/lease,
   `serveResolvedTarget` recomputes the resume key from the incoming request
   and claims a matching pending entry. On a hit it serves
   `GET /v1/stream/:conv_id?from=0` through the standard downstream tract
   (usage meter with the original strip decisions, Anthropic translation,
   non-stream rebuild via `consumeResumableSse`), marks `trace.resumed`, and
   DELETEs the session when the response settles. Gateway and lease are
   bypassed like a cache hit: a replay reads a buffer, it does not consume a
   slot. Replay failures (404 expired, 400 offset lost) fall through to a
   normal forward — an honest regeneration.

## What survives, what does not

- Survives: managed llama.cpp chat.completions/messages with an SSE upstream —
  including translated Anthropic clients and non-stream clients (the manager
  already force-streams those upstream). Clients recover via their normal
  retry: non-stream SDK retries are fully transparent; broken streams surface
  an error to the app, whose retry receives the complete stream from the
  beginning.
- Does not survive: external providers, `n>1`/logprobs requests, embeddings,
  the preemptible-lease path (see above), crashes (the snapshot is written on
  SIGTERM only), generations whose SSE exceeds the 4 MiB ring buffer, and
  retries whose body differs from the original beyond the pinned attribution
  churn.

## Self-update drain

When the update runner reaches its restart step it flips the proxy into drain
mode (`proxy/drain.ts`): new public proxy requests get an immediate 503 with
`Retry-After: 5` (protocol-shaped error body), so well-behaved clients back
off and land after the restart. The runner then waits up to
`LLAMA_MANAGER_UPDATE_DRAIN_TIMEOUT_MS` (default 10 s) for in-flight requests
*without* stream sessions — externals, embeddings — to finish; resumable ones
are not waited for, they persist. Then SIGTERM → persist → systemd restart.
Replayed requests are marked `resumed` on the trace and counted in
`GET /api/proxy/stats` totals; the traces table shows a `resumed` badge.

## Retry-window arithmetic

The manager must be back up before the client stops retrying. Self-update
builds before restarting, so its downtime is seconds of process restart —
within agent-loop and Claude Code retry budgets; default OpenAI SDK gives only
two quick retries, which may miss the gap. The claim window (3 min) and the
llama.cpp completed-session TTL (5 min) bound the recoverable horizon.
