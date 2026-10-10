---
schema: 1
engine: sglang
primaryName: "--speculative-draft-window-size"
title: "--speculative-draft-window-size"
summary: Ограничивает контекст, который видит draft-модель: sliding window у Llama-EAGLE3-драфтера, компактный локальный KV-кеш у DFLASH и окно (плюс опциональные sink-токены) на draft-decode шагах встроенного EAGLE/MTP на Triton и FlashInfer. На остальных алгоритмах игнорируется с предупреждением, целевую модель не затрагивает никогда.
group: spec
related:
  - --speculative-algorithm
  - --speculative-draft-sink-size
  - --speculative-draft-attention-backend
  - --speculative-num-steps
  - --speculative-num-draft-tokens
  - --speculative-dflash-block-size
  - --speculative-draft-model-path
  - --page-size
  - --context-length
---

# --speculative-draft-window-size

## Кратко

Draft видит не весь контекст, а последние N токенов. Смысл в том, что для предсказания ближайших нескольких токенов далёкий префикс почти не нужен, а платить за него приходится и памятью (KV draft'а), и временем (внимание по всей длине). Аргумент работает в трех местах — у Llama-EAGLE3 (`LlamaForCausalLMEagle3`), у DFLASH и на draft-decode шагах встроенного EAGLE/MTP (`EAGLE`, `NEXTN`, `EAGLE3`), когда draft-внимание идет через Triton или FlashInfer; там к окну можно добавить «attention sink» из первых токенов (`--speculative-draft-sink-size`). Остальные пути, включая MLA-драфтеры EAGLE3 на MLA-backend'ах, его молча не читают; для алгоритмов вне EAGLE/EAGLE3/DFLASH на старте печатается предупреждение.

## Оригинальная справка

```text
Sliding window size for the draft model. Honored by Llama EAGLE-3 (`LlamaForCausalLMEagle3`), DFLASH, and the built-in EAGLE/MTP draft-decode path on the Triton and FlashInfer draft backends; other EAGLE-3 backends (e.g. MLA-based drafters) silently ignore it. For Llama EAGLE-3, the drafter only attends to the most recent N keys (verifier hidden states + its own outputs); the verifier is unaffected. For DFLASH, the draft worker keeps a recent target-token window in its local KV cache (paged backends may retain up to one extra page on the left for alignment). For the built-in EAGLE/MTP draft, each draft-decode step attends to a --speculative-draft-sink-size sink plus the most recent N tokens, leaving the target verify pass unchanged; it is ignored (with a warning) if the draft model has a native sliding window of its own. Default is full attention/context.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-window-size`
- Группа: `spec`
- Тип значения: целое (`Optional[int]`), число токенов
- Допустимые значения: строго положительное; ноль и отрицательные отвергаются проверкой после разбора
- Значение по умолчанию: `null` — полное внимание/полный контекст
- Эффективное значение: значение приводится к `int`; для DFLASH дополнительно требуется `window_size >= speculative_num_draft_tokens`; на EAGLE/MTP-пути `resolve_draft_decode_window` обнуляет окно, если у draft-модели есть собственное sliding window
- Где объявлен: `python/sglang/srt/arg_groups/fields/spec.py:Spec.speculative_draft_window_size`
- Статус: обычный
- Этап применения: `ServerArgs.resolve_once` → шаг `handle_speculative_decoding` (`arg_groups/speculative_hook.py`: проверка и предупреждение; вызываемый из него `_handle_dflash` — сверка с block size) → конструирование draft-модели (Llama-EAGLE3), draft-воркера (DFLASH) или multi-step draft attention backend'а (`TritonMultiStepDraftBackend`, `FlashInferMultiStepDraftBackend`) → forward

## Что меняет в движке

Проверка выполняется **один раз для всех алгоритмов**: `handle_speculative_decoding` требует положительности и, если алгоритм (после сведения `NEXTN` к `EAGLE`) не `EAGLE`, не `EAGLE3` и не `DFLASH`, печатает `--speculative-draft-window-size has no effect with speculative_algorithm=<x> (honored by DFLASH, Llama EAGLE-3, and the EAGLE/MTP/NEXTN draft-decode path on the Triton/FlashInfer draft backends).`

- **Llama EAGLE-3.** В `LlamaForCausalLMEagle3.__init__` значение читается один раз и проставляется каждому слою как `layer.self_attn.attn.sliding_window_size`; оно же возвращается из `get_attention_sliding_window_size()`. Драфтер смотрит только на последние N ключей — это hidden states верификатора плюс его собственные выходы. Целевая модель не затрагивается: её окно и её KV остаются полными.
- **DFLASH.** `DFlashWorkerV2` включает компактный draft-кеш (`use_compact_draft_cache = draft_window_size is not None`) и на каждом шаге считает видимую длину как `min(seq_len, window)`. При `--page-size > 1` начало окна выравнивается вниз по границе страницы, поэтому фактически может удерживаться до `page_size − 1` лишних токенов слева; хостовая оценка использует монотонную верхнюю границу `min(len, window + page_size)`.
- **Встроенный EAGLE/MTP на Triton/FlashInfer.** Multi-step draft backend при создании вызывает `resolve_draft_decode_window` (`speculative/spec_utils.py`) и затем строит KV-индексы каждого draft-decode шага (`generate_draft_decode_kv_indices`) так, что шаг видит первые `--speculative-draft-sink-size` токенов (StreamingLLM-sink) плюс последние N. Это ограничение только на чтение: KV draft'а по-прежнему пишется на всю длину, draft-extend и verify-проход целевой модели не меняются. Если у draft-модели есть собственное sliding window (из чекпоинта или, у `LlamaForCausalLMEagle3`, из этого же флага), окно индексов не применяется: при несовпадении значений печатается `Ignoring --speculative-draft-window-size=N: this draft model has a sliding window of M, which the attention backend applies per layer. Draft-decode windowing stays off.`

## Значения и формат

- Целое число токенов, без суффиксов. Разумный порядок — сотни-тысячи, а не единицы.
- `0` и отрицательные: `ValueError: --speculative-draft-window-size must be positive, got N`.
- Не задано = полный контекст (для DFLASH — компактный кеш выключен целиком, draft хранит KV на всю длину). `--speculative-draft-sink-size` без этого флага — `ValueError`.
- Для DFLASH окно не может быть меньше блока верификации: `--speculative-draft-window-size must be >= --speculative-num-draft-tokens (block_size)`, где `block_size` — это `--speculative-dflash-block-size` либо выведенное значение.
- Верхней границы нет; значение больше фактической длины запроса эквивалентно полному вниманию.

## Когда использовать

- DFLASH на длинных контекстах: draft-KV — это отдельный пул поверх целевого, и на 32k+ он заметен. Окно в несколько сотен токенов обычно не портит accept rate, потому что DFlash предсказывает блок вперёд по недавнему тексту.
- Llama-EAGLE3-драфтер, обученный с ограниченным окном: значение надо привести в соответствие с обучением, иначе драфтер получает распределение, которого не видел.
- Встроенный EAGLE/MTP (в том числе `NEXTN`) на Triton/FlashInfer при длинном контексте: draft-decode шаги перестают читать всю историю. Окно стоит дополнять небольшим sink (`--speculative-draft-sink-size`), если без первых токенов падает accept rate.
- Не задавать «на всякий случай» на MLA-драфтерах и других draft-backend'ах — там аргумент ничего не делает.
- Не выкручивать окно в минимум ради памяти: у DFLASH это прямой обмен на accept rate, а восстановить его можно только новым замером.

## Влияние на производительность и память

- VRAM: у DFLASH сокращает объём draft-KV, участвующий в форварде (компактный кеш), у Llama-EAGLE3 и на EAGLE/MTP-пути сокращает объём вычислений внимания драфтера, но не сам KV-пул — размер пула считается на этапе конфигурации по числу слоёв, а не по окну.
- Время draft-шага: внимание по N ключам вместо всей последовательности — на длинном контексте разница заметная.
- На target'а: нулевое влияние по обоим путям.
- Accept rate: главный риск. Слишком маленькое окно снижает качество предложений, и выигрыш спекуляции падает быстрее, чем экономится память.

## Взаимодействие с другими аргументами

- `--speculative-algorithm`: значение читается у `EAGLE`/`NEXTN`/`EAGLE3` (Llama-драфтер или draft-decode на Triton/FlashInfer) и `DFLASH`.
- `--speculative-draft-sink-size`: число начальных токенов, которые draft-decode шаг EAGLE/MTP видит в дополнение к окну; без окна не принимается.
- `--speculative-draft-attention-backend`: на EAGLE/MTP-пути окно действует, только когда draft-внимание (заданное этим флагом или унаследованное от целевой модели) идет через `triton` или не-MLA `flashinfer`.
- `--speculative-num-draft-tokens` / `--speculative-dflash-block-size`: нижняя граница окна для DFLASH.
- `--page-size`: при страницах > 1 фактическое окно округляется вверх до границы страницы.
- `--context-length`: draft всегда работает в абсолютных позициях target'а; окно — это ограничение внимания, а не длины запроса.
- `--speculative-draft-model-path`: чекпоинт должен быть совместим с выбранным окном (для EAGLE3 — обучен с ним).

## Типовые проблемы и диагностика

- `--speculative-draft-window-size must be positive, got 0` — недопустимое значение.
- `--speculative-draft-window-size must be >= --speculative-num-draft-tokens (block_size). window_size=8, block_size=16` — окно меньше блока верификации DFLASH.
- `--speculative-draft-window-size has no effect with speculative_algorithm=NGRAM (honored by DFLASH, Llama EAGLE-3, and the EAGLE/MTP/NEXTN draft-decode path on the Triton/FlashInfer draft backends).` — аргумент задан не тому алгоритму.
- Задан для EAGLE/EAGLE3, предупреждения нет, но ничего не изменилось — draft-внимание идет не через Triton/FlashInfer (например, MLA-драфтер на MLA-backend'е) и драфтер не `LlamaForCausalLMEagle3`; поведение штатное, читайте оригинальную справку.
- `Ignoring --speculative-draft-window-size=…: this draft model has a sliding window of …` — у draft-модели собственное окно, оно и действует.
- Что смотреть: у DFLASH строка `Initialized DFLASH draft runner. attention_backend=…, block_size=…, draft_window_size=…, compact_cache=True`; общий дамп `server_args=` показывает принятое значение.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm DFLASH --speculative-draft-model-path z-lab/LLaMA3.1-8B-Instruct-DFlash-UltraChat --speculative-dflash-block-size 16 --speculative-draft-window-size 512
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-draft-window-size 1024
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/spec.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/models/llama_eagle3.py`
- `sglang/python/sglang/srt/speculative/dflash_worker_v2.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_backend.py`
- `sglang/python/sglang/kernels/ops/speculative/cache_locs.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
- upstream PR #32673 «[Spec] Windowed draft-decode attention for built-in EAGLE / MTP drafts» (коммит `61d0cf2074` в checkout)
