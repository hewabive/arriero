# Argument Source Extraction

Git-only extraction of the argument declaration of the Python engines (vLLM, SGLang/KTransformers)
from an engine checkout.

`llama.cpp` publishes a generated help block inside `tools/server/README.md`, so its source sync just
reads a file (`docs/ARGUMENT_HELP_WORKFLOW.md`). The Python engines publish no such artifact: vLLM
renders its CLI reference at docs-build time, SGLang only at `--help` time. Both would drag a venv
(and for SGLang a torch install) into the sync path. The extractors here read the declaration
straight from the sources with the stdlib `ast` module instead — no engine import, no venv, no CUDA,
no GPU.

## Scope

The extract is a **declaration** view, produced for two consumers:

- the Source-sync drift signal — a stable hash that changes when the argument surface changes, not
  when a file is reformatted;
- the human/agent writing engineering help — names, help text, defaults, choices and the exact
  source location of each argument.

It is **not** the argument catalog. The catalog stays what it is today: `--help` of the installed
engine (`apps/api/src/arguments/catalog.ts`), which is the only authority on what the running binary
accepts. An argument present in the extract but missing from the installed engine is the same
phenomenon `docs/CASE_PHANTOM_HELP_ARGS.md` describes for llama.cpp.

## Commands

```bash
python3 scripts/extract-args/vllm.py   --repo <vllm-checkout>   --out extract.json
python3 scripts/extract-args/sglang.py --repo <sglang-checkout> --out extract.json
```

`--out -` (the default) writes the extract to stdout. The diagnostics summary always goes to stderr
and is never part of the extract, so it cannot perturb the hash. Both run in under a second and
require only python3 (stdlib).

## Output

```json
{
  "schema": 1,
  "engine": "vllm",
  "entrypoint": "vllm serve",
  "sourceFiles": ["vllm/engine/arg_utils.py", "..."],
  "options": [
    {
      "flags": ["--max-model-len"],
      "group": "ModelConfig",
      "help": "Model context length (prompt and output)...",
      "choices": null,
      "optional": true,
      "default": { "kind": "literal", "value": null },
      "action": null,
      "hidden": false,
      "origin": "vllm/config/model.py:ModelConfig.max_model_len"
    }
  ]
}
```

- `flags` — every option string argparse would register, in argparse order, including the `--no-…`
  member of a `BooleanOptionalAction` pair and short aliases.
- `default` — `{"kind":"literal","value":…}` when the declaration is a literal,
  `{"kind":"expression","text":"…"}` when it is computed. Never a guessed value.
- `choices` — `null` when the list cannot be resolved statically (see gaps). Declaration order is
  preserved; vLLM sorts choices when it renders help, so compare as sets.
- `optional` — the declared type admits `None`. vLLM renders this as an extra `None` choice.
- `hidden` — declared with `argparse.SUPPRESS` as help text.
- `origin` — where a doc author should read the real behaviour.

Determinism is a contract: options are sorted by primary flag, nothing is timestamped, and no
absolute path enters the file. Two runs over the same checkout produce byte-identical output.

## What each extractor reads

vLLM (`scripts/extract-args/vllm.py`): `vllm/config/*.py` for config dataclasses and their attribute
docstrings (the same docstrings vLLM's own `get_attr_docs` parses with `ast`), then
`EngineArgs.add_cli_args`, `AsyncEngineArgs.add_cli_args` and `make_arg_parser`, resolving
`get_kwargs(SomeConfig)` bindings, `**kwargs["field"]` unpacking (including the
`**{**kwargs["field"], "default": …}` override form), argument-group titles, and `FrontendArgs`
including its base-class fields.

SGLang (`scripts/extract-args/sglang.py`): `python/sglang/srt/server_args.py` — the `ServerArgs`
`A[type, "help", NS("group")]` fields (`Arg(...)` metadata: aliases, `cli_name`, `choices`,
`action`, `no_cli`) plus the literal `parser.add_argument` calls in `add_cli_args`. `{fn.__doc__}`
interpolations in help strings are resolved from the imported module.

Both follow imports one hop to resolve `Literal` type aliases and module-level choice constants.

Each extractor asserts its structural anchors (the class, the `add_cli_args`/`make_arg_parser`
function) and exits non-zero when one is missing, so an upstream refactor produces a loud failure
rather than a silently shrunken extract.

## Known gaps

These are the cases where a declaration does not determine the runtime surface. All of them yield
`null` plus a diagnostics entry — never an invented value.

- **Registry-derived choices.** `--reasoning-parser` / `--tool-call-parser` (SGLang) and
  `--gdn-prefill-backend` / `--mm-processor-device` (vLLM) take their choices from runtime
  registries. A concatenation such as `["auto"] + registry_keys` is reported as unresolved rather
  than as the resolvable half.
- **Kwargs mutated before registration.** vLLM's `observability_kwargs["collect_detailed_traces"]["choices"] += …`
  is listed in `runtimeAdjustedKwargs`.
- **Runtime-constructed defaults.** `--eplb-config` and friends default to a constructed config
  object; the extract carries the expression text.
- **Conditional registration.** Calls guarded by an `if` are extracted unconditionally.
- **Positional arguments** (`model_tag`) are reported in diagnostics, not as options.
- **`%` escaping** differs: vLLM doubles `%` for argparse, the extract keeps the source spelling.

## Verification

The extract is checked against an independently produced runtime reference — the only reason a venv
is ever needed, and only for this offline check, never for sync:

- vLLM: run upstream's own `docs/mkdocs/gen_files/generate_argparse.py` (it mocks torch when absent;
  `NEEDS_HELP` requires `mkdocs` in `sys.modules` or `--help` in `sys.argv`, otherwise attribute
  docs are silently omitted) and compare against the generated `cli/serve.md`.
- SGLang: import `sglang.srt.server_args` with CPU torch, build the parser, dump `parser._actions`.

Measured on 2026-08-11 against vLLM `b64a270` and SGLang `b20c375`:

| | vLLM `serve` | SGLang `launch_server` |
| --- | --- | --- |
| Flags | 283 of 283, no false positives | 493 of 493, no false positives |
| Help text | 249 identical, 6 prefix of the rendered text, 27 richer than upstream's own docs, 1 `%`-escaping difference | 488 identical, 3 hidden (`SUPPRESS`), 2 registry-suffixed |
| Choices | 38 resolved (26 differing only in order), 2 unresolved | 80 resolved (1 differing only in order), 4 unresolved |

The 27 "richer" vLLM entries are base-class `BaseFrontendArgs` fields: upstream's generator reads
attribute docs of the leaf class only, so its published reference shows those arguments without help
text while the extract recovers it.

## Not wired yet

Nothing in `apps/api` consumes these extracts. The next step is the per-engine help-source adapter
(snapshot + hash + commit, mirroring `apps/api/src/arguments/docs-source.ts`), with a pure-git
fallback signal — the commit range touching the declaration paths — for hosts without python3 or
when an extractor's structural assertion fails.
