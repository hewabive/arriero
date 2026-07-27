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

A README help row with no matching entry in the parsed argument catalog (i.e. not printed by the configured binary's `--help`) is a phantom row. Cross-check new rows against `common/arg.cpp` and the built `--help` before documenting them as real.
