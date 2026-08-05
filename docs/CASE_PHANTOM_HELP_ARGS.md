# Case: Phantom Args In The Generated Help Block

A worked example of the verification step in `ARGUMENT_HELP_WORKFLOW.md`: the `tools/server/README.md` help block can list arguments that the source and built binary do not actually have.

## What happened

Syncing argument docs against llama.cpp `2187e00`, the help diff showed two new rows:

```text
+| -tk, --talker-model FILE  | path to the qwen3-omni talker gguf, enables the /v1/audio/speech endpoint |
+| -c2w, --code2wav-model FILE | path to the qwen3-omni code2wav gguf, the talker code detokenizer |
```

They looked like ordinary new flags. They were not:

- `common/arg.cpp` does not define them; `LLAMA_ARG_TALKER_MODEL` / `LLAMA_ARG_CODE2WAV_MODEL` appear nowhere in the source.
- The built `llama-server --help` does not print them.
- `tools/server/server.cpp` registers only `/v1/audio/transcriptions`; the advertised `/v1/audio/speech` endpoint does not exist.
- `git log --all -S talker-model -- common/arg.cpp` is empty — the string was never in `arg.cpp`.

The rows entered the README via [PR #23865](https://github.com/ggml-org/llama.cpp/pull/23865) ("app: add llama update self updater"), a doc-regeneration commit that touched only README files. The README was regenerated from a tree with an experimental talker build applied, but that feature code is not in mainline. Only the audio **input** side (qwen3-omni ASR, `/v1/audio/transcriptions`) is merged ([PR #19441](https://github.com/ggml-org/llama.cpp/pull/19441)).

## Why it matters

arriero builds its argument catalog from the binary's `--help`, so a phantom arg never gets a catalog entry — a doc written for it as a working flag would be misleading, and a user passing the flag gets an unknown-argument error.

## How it was handled

- The three real changes (`--timeout` default `600 -> 3600`, `granite-4.1` added to the chat-template lists) were applied to their docs.
- `talker-model.md` and `code2wav-model.md` were written with a `Статус в upstream` section stating the feature is not implemented in the current checkout, linking the PR that leaked the rows.
- The snapshot was written with `--write` so the warning clears and the docs track the upstream README, with the phantom status recorded in the docs themselves.

## The cheap signal

A README help row with no matching entry in the parsed argument catalog (i.e. not printed by the configured binary's `--help`) is a phantom row. This is now automated: `args:docs:source-sync` reports help rows whose flags appear nowhere in the checkout's `common/arg.cpp` as `phantomRows` (also surfaced as a warning on the Arguments page). The check is a literal flag lookup — it cannot see `set_examples` per-tool gating, so a row that passes it can still be absent from the server build; the built `llama-server --help` remains the final arbiter.

## The wrong-ref trap: "removed" vocoder args that were still real

A second worked example, this time of syncing against the wrong ref. An earlier
revision of this section claimed four vocoder/TTS arguments
(`--model-vocoder`, `--hf-repo-v`, `--hf-file-v`, `--tts-use-guide-tokens`)
had been removed from the server by
[PR #26254](https://github.com/ggml-org/llama.cpp/pull/26254), and their
Arriero docs were deleted. Every one of those claims was checked against an
out-of-band upstream state (an unmerged PR branch whose base master was ahead
of the configured checkout), not against the checkout itself: locally the
removal commit did not exist, `common/arg.cpp` still defined all four options
with `LLAMA_EXAMPLE_SERVER` enabled, and the built `llama-server --help`
printed them. The deletions were premature and the docs were restored.

The forward-looking part stays true: once the checkout pulls past the upstream
removal, the rows disappear from the generated help and the docs are deleted
then, through the ordinary removed-argument step of the workflow — not before.

Memory coverage: `llama-server` parses these options (and `--hf-repo-v` can
even download the file at startup) but never loads a vocoder — only the
separate `llama-tts` tool consumes it (`tools/tts/tts.cpp`; `tools/server/`
has no vocoder code in its entire history). The options are therefore
memory-neutral for a server instance and classified `estimation: "normal"`:
the estimate is complete without the vocoder, and rejecting it would be
wrong.
