---
schema: 1
engine: sglang
primaryName: "--speculative-draft-sink-size"
title: "--speculative-draft-sink-size"
summary: Число первых токенов контекста («attention sink»), которые draft-модель EAGLE/MTP видит на каждом draft-decode шаге в дополнение к окну `--speculative-draft-window-size`. Работает только на Triton и FlashInfer draft-backend'ах и только вместе с окном.
group: spec
related:
  - --speculative-draft-window-size
  - --speculative-algorithm
  - --speculative-draft-attention-backend
  - --speculative-num-steps
  - --speculative-eagle-topk
---

# --speculative-draft-sink-size

## Кратко

`--speculative-draft-window-size` для встроенного EAGLE/MTP draft-пути ограничивает внимание draft-модели последними `N` токенами контекста — на длинных контекстах draft-шаги дешевеют, но draft теряет начало промпта. Этот аргумент добавляет к окну `S` первых токенов последовательности, как attention sink в StreamingLLM: системный промпт и первые токены остаются видимыми. Target verify и draft extend аргумент не трогает. Аргумент новый в checkout'е; наличие в установленной сборке проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Number of leading 'attention sink' tokens the draft always attends to, in addition to the --speculative-draft-window-size recent window (StreamingLLM-style). Honored only by the built-in EAGLE/MTP draft-decode path on the Triton and FlashInfer draft backends; the Llama EAGLE-3 and DFLASH windows ignore it. 0/unset => pure recent window. Requires --speculative-draft-window-size.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-sink-size`
- Группа: `spec`
- Тип значения: optional int
- Допустимые значения: целое `≥ 0`
- Значение по умолчанию: `null` — то же, что `0`: чистое окно без sink
- Эффективное значение: `handle_speculative_decoding` (`arg_groups/speculative_hook.py`) проверяет `≥ 0` и наличие окна и декларирует значение как `int` через `declare_resolution`; на рантайме `resolve_draft_decode_window` (`speculative/spec_utils.py`) обнуляет и окно, и sink, если у draft-модели есть собственное скользящее окно
- Где объявлен: `python/sglang/srt/arg_groups/fields/spec.py:Spec.speculative_draft_sink_size`
- Статус: обычный
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline`, шаг `handle_speculative_decoding` (проверка) → инициализация multi-step draft-backend'а (`TritonMultiStepDraftBackend`, `FlashInferMultiStepDraftBackend`) → построение KV-индексов каждого draft-decode шага

## Что меняет в движке

Проверка на старте (`handle_speculative_decoding`): отрицательное значение — `ValueError: --speculative-draft-sink-size must be non-negative, got N.`; значение без `--speculative-draft-window-size` — `ValueError: --speculative-draft-sink-size requires --speculative-draft-window-size.`

Multi-step draft-backend'ы Triton и FlashInfer при инициализации берут пару `(window, sink)` из `resolve_draft_decode_window`. Пара обнуляется (полное внимание draft), если окно не задано или если у draft-модели есть собственный `sliding_window_size`; при несовпадении собственного окна с заданным печатается `Ignoring --speculative-draft-window-size=…: this draft model has a sliding window of …`. Llama EAGLE-3 (`LlamaForCausalLMEagle3`) применяет то же окно у себя по слоям, поэтому для нее sink не действует.

Сам sink работает в Triton-ядре `generate_draft_decode_kv_indices` (`kernels/ops/speculative/cache_locs.py`), которое собирает список KV-слотов для каждого draft-decode шага. При `window > 0` вместо всего префикса длины `L` в список идут:

- первые `min(S, L)` позиций (sink);
- последние `min(L, window + S) − min(S, L)` позиций (окно);
- плюс токены, уже сгенерированные draft'ом на предыдущих шагах.

Если префикс короче `window + S`, draft видит его целиком — разницы с полным вниманием нет. KV-кеш draft-модели при этом хранится полностью: меняется только набор слотов, которые читает attention, а не то, что лежит в пуле.

## Значения и формат

- Целое `≥ 0`. `0` и «не задан» равнозначны: чистое окно последних `window` токенов.
- Значение задается в токенах, без выравнивания по `--page-size`.
- Типичный диапазон — единицы–сотни токенов: sink нужен, чтобы удержать начало промпта (BOS, системный промпт), а не чтобы заменить окно.

## Когда использовать

- Задано `--speculative-draft-window-size` для EAGLE/MTP на длинных контекстах, и после этого заметно упала accept length: draft потерял системный промпт или формат, заданный в начале. Sink в несколько десятков–сотен токенов часто возвращает acceptance без отказа от окна.
- Не нужен без окна (старт упадет), для DFLASH и Llama EAGLE-3 (их окна sink игнорируют) и при draft-backend'ах, отличных от Triton и FlashInfer.

## Влияние на производительность и память

- VRAM не меняется: KV draft-модели хранится полностью, CUDA graph и буферы индексов рассчитаны на полный контекст.
- Стоимость каждого draft-decode шага растет на `S` позиций внимания по сравнению с чистым окном — на фоне длинного контекста это несущественно.
- Влияние на скорость генерации идет через accept length: если sink повышает долю принятых draft-токенов, растет число токенов на один target verify.
- Target verify и draft extend считаются как без окна и sink.

## Взаимодействие с другими аргументами

- `--speculative-draft-window-size`: обязателен; sink добавляется к окну, а не заменяет его. Для DFLASH и Llama EAGLE-3 окно действует, sink — нет.
- `--speculative-algorithm`: окно и sink для draft-decode действуют на встроенном EAGLE/EAGLE3/NEXTN-пути; для других алгоритмов окно само по себе печатает предупреждение «has no effect».
- `--speculative-draft-attention-backend`: только Triton и FlashInfer multi-step draft-backend'ы строят индексы с sink; на других backend'ах аргумент молча не действует.
- `--speculative-num-steps`, `--speculative-eagle-topk`: определяют, сколько draft-токенов добавляется к окну на каждом шаге и сколько веток строится; на окно и sink не влияют.

## Типовые проблемы и диагностика

- `ValueError: --speculative-draft-sink-size requires --speculative-draft-window-size.` — задайте окно или уберите sink.
- `ValueError: --speculative-draft-sink-size must be non-negative, got N.` — отрицательное значение.
- `Ignoring --speculative-draft-window-size=…: this draft model has a sliding window of …` — у draft-модели собственное окно; окно и sink из CLI выключены.
- Нет эффекта на accept length — проверьте draft-backend (итоговый `speculative_draft_attention_backend` в дампе `server_args=`) и что контекст длиннее `window + sink`.
- Принятые значения — `speculative_draft_window_size=` и `speculative_draft_sink_size=` в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --speculative-algorithm NEXTN --speculative-draft-attention-backend triton --speculative-draft-window-size 4096 --speculative-draft-sink-size 64
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/Qwen3-30B-A3B-EAGLE3 --speculative-draft-attention-backend flashinfer --speculative-draft-window-size 2048 --speculative-draft-sink-size 128
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/spec.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/kernels/ops/speculative/cache_locs.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_backend.py`
- `sglang/test/registered/kernels/ops/speculative/test_draft_decode_window.py`
