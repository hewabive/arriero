# GGUF quantization label

How `GgufMetadata.quantization` is derived in `apps/api/src/models/gguf.ts`, and why it does not
blindly trust the file's own metadata.

## The problem

The canonical source is the GGUF key `general.file_type`, an `llama_ftype` enum value stamped by the
quantization tool. Quantization pipelines sometimes stamp it wrong: the real-world trigger was
Unsloth's `Qwen3.8-27B-UD-IQ2_XXS.gguf`, whose metadata claims `14` (Q4_K_S) while the tensor table
contains no Q4_K data at all — it is an IQ2-family dynamic mix dominated by `iq2_s`. llama.cpp
itself reports the same wrong label at load time, because it also just reads `general.file_type`.

## The cross-check

`readGgufMetadata` already walks the tensor table for `parameterCount`; it now also accumulates
element counts per ggml tensor type. `readQuantization` then validates the claimed ftype against
that histogram:

- `LLAMA_FTYPE_EXPECTED_GGML_TYPES` maps each `llama_ftype` to the ggml tensor type(s) the
  quantizer's `default_type` uses for that ftype (mirrors the `switch` in llama.cpp
  `llama_model_quantize_impl`; entries with two types cover ftypes whose default is a near-even mix,
  e.g. `IQ3_XS`, `IQ2_S`).
- The claim is accepted when the expected types together hold at least 5% of all tensor elements
  (`FILE_TYPE_TENSOR_SHARE_FLOOR`). Legitimate `_S`/`_M`/`_L`/Unsloth-UD mixes keep large shares of
  their base type, so the floor is deliberately loose — it only trips when the claimed type is
  essentially absent from the file.
- On mismatch the label is derived from the dominant tensor type by element count and marked, e.g.
  `IQ2_S (tensors)`. The marker distinguishes a tensor-derived label from a metadata one (llama.cpp
  uses `(guessed)` the same way for its own fallback).

Dominance is measured in elements, not tensor count — norm/bias tensors are numerous but tiny, so
counting tensors would elect `f32` in almost every quantized model.

## Fallbacks

- `general.file_type` absent → the tensor-derived `<TYPE> (tensors)` label directly.
- Tensor table unreadable, empty, or the ftype unknown to the expected-types map → the metadata
  claim stands unchallenged.
