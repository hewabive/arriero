---
schema: 1
engine: sglang
primaryName: "--cuda-graph-prefill-max-context"
title: "--cuda-graph-prefill-max-context"
summary: Фиксированная длина контекста, под которую breakable/full prefill CUDA graph DeepSeek-V4 выделяет контекстные метаданные внимания и логиты индексера вместо максимума модели; батчи с более длинным контекстом идут eager. Принимает суффиксы `k`/`Ki` и выравнивается вверх до `--page-size`.
group: exec.graph
related:
  - --cuda-graph-config
  - --cuda-graph-backend-prefill
  - --cuda-graph-max-seq-len-prefill
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-bs-prefill
  - --context-length
  - --page-size
  - --attn-cp-size
---

# --cuda-graph-prefill-max-context

## Кратко

Захваченный граф требует статических форм. У DeepSeek-V4 часть буферов prefill-графа зависит от длины контекста: attention-метаданные и логиты C4-индексера. Без флага они при захвате рассчитаны на ширину `req_to_token`, то есть на полную длину контекста модели. Именно из-за этого давления на capture pool breakable prefill-граф для DeepSeek-V4 по умолчанию выключен.

Флаг фиксирует меньший размер: граф обслуживает только батчи, в которых самый длинный контекст не превышает значения, а остальные идут eager. Аргумент добавлен upstream PR #36534; алиас — `--context-bucket`. В закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
Maximum context length supported by DeepSeek-V4 breakable/full prefill CUDA graphs. Context-shaped attention metadata and indexer logits are allocated at this fixed size instead of the model maximum. Larger live contexts fall back to eager.

Supports standard SI suffixes (k, M, G, T) and IEC suffixes
(Ki, Mi, Gi, Ti). Suffixes are case-sensitive.

Decimals are allowed for SI suffixes only.

Examples:
    '1k' -> 1000      '1M' -> 1000000    '25.6k' -> 25600
    '1Ki' -> 1024     '1Mi' -> 1048576
```

## Паспорт аргумента

- Флаги: `--cuda-graph-prefill-max-context`, алиас `--context-bucket`
- Группа: `exec.graph`
- Тип значения: int; разбирается `human_readable_int` (`sglang/python/sglang/srt/utils/common.py`), так что принимаются суффиксы: `32Ki` = 32768, `32k` = 32000, `25.6k` = 25600; дробные значения допустимы только с SI-суффиксами
- Допустимые значения: положительное целое, не больше длины контекста модели после выравнивания
- Значение по умолчанию: `null` — контекстные буферы графа рассчитаны на `MAX_SEQ_LEN_FOR_CAPTURE`, то есть на ширину `req_to_token`
- Эффективное значение: `parse_cuda_graph_config` кладет значение в `cuda_graph_config.prefill.max_context_size` и ставит замок; JSON-ключ `max_context_size` из `--cuda-graph-config` перекрывает флаг. Последним шагом пайплайна `finalize_cuda_graph_prefill_max_context` выравнивает размер вверх до кратного `page_size` (лог `Page-aligning prefill CUDA graph max context size N -> M (page_size=P).`) и печатает `Prefill CUDA graph max context size: M; graph keys remain token-only.`
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecGraph.cuda_graph_prefill_max_context`
- Статус: обычный, новый
- Этап применения: разбор CLI → `handle_cuda_graph_config` → `finalize_cuda_graph_prefill_max_context` (после разрешения `page_size`) → конструктор `PrefillCudaGraphRunner` (проверки) → захват (`max_seq_len_override` в dummy-батче) → решение о replay каждого prefill-батча

## Что меняет в движке

`PrefillCudaGraphRunner` (`model_executor/runner/prefill_cuda_graph_runner.py`) хранит значение в `self.max_context_size` и при создании:

- проверяет, что оно не больше ширины `req_to_token`: иначе `ValueError: --cuda-graph-prefill-max-context exceeds the request-to-token pool capacity: requested size N > M`;
- для `tc_piecewise` и для CP-варианта breakable (`should_enable_cp_bcg_capture`) сбрасывает значение с предупреждением `Ignoring prefill CUDA graph max context size N for <путь>; this path does not yet preserve the fixed metadata extent.`;
- требует, чтобы backend внимания объявлял `supports_prefill_cuda_graph_max_context_size`. В checkout'е это только `DeepseekV4AttnBackend`; обертки hybrid и TBO делегируют вопрос своему backend'у. Иначе старт падает: `ValueError: --cuda-graph-prefill-max-context is only supported by attention backends that implement fixed-context prefill graph metadata; got <класс>`.

При захвате dummy-батч несет `max_seq_len_override = max_context_size`, и `DeepseekV4AttnBackend` строит контекстные метаданные под этот размер вместо `MAX_SEQ_LEN_FOR_CAPTURE`.

При replay `can_replay_locally` отказывает, если максимальная длина контекста в батче (`seq_lens`: префикс плюс extend) больше значения. При DP attention тот же голос собирается через `scheduler_components/dp_attn.py`, и решение общее для группы. Ключи графа остаются токенными: один размер контекста на все токен-бакеты.

Prefill-граф для DeepSeek-V4 по умолчанию выключен каскадом совместимости, поэтому флаг имеет смысл вместе с явным `--cuda-graph-backend-prefill breakable` или `full`.

## Значения и формат

- `<= 0` → `ValueError: --cuda-graph-prefill-max-context must be a positive integer`.
- После выравнивания значение должно быть не больше длины контекста модели: `ValueError: --cuda-graph-prefill-max-context exceeds the model context length: aligned size N > M`.
- Выравнивание идет вверх до `page_size`. У DeepSeek-V4 движок сам ставит страницу 256 (128 на NPU), поэтому `30000` превратится в `30208`.
- `k` — десятичный суффикс, `Ki` — двоичный. `32k` = 32000 (кратно 256), `32Ki` = 32768.
- `null` — полная ширина, как до появления флага.

## Когда использовать

- DeepSeek-V4/V4.1 с явно включенным prefill-графом, когда захват не помещается в память или отъедает KV-пул, а основная нагрузка — короткие и средние промпты. Длинные пусть идут eager.
- Не используйте на других моделях: с `breakable`/`full` старт упадет на проверке backend'а, с `tc_piecewise` значение молча сбросят с предупреждением.
- Без явного prefill-backend'а на DeepSeek-V4 граф выключен, runner не создается, и флаг влияет только на проверки пайплайна.

## Влияние на производительность и память

- **VRAM.** Основная цель флага — уменьшить capture pool: контекстные метаданные и логиты индексера масштабируются с этим размером, а не с полным контекстом модели. Фактическую стоимость показывает строка `Capture target prefill CUDA graph end. … mem usage=… GB`.
- **TTFT.** Батчи с контекстом длиннее значения идут eager и теряют выигрыш графа.
- **Время старта.** Число захватов не меняется: формы — токен-бакеты.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-prefill`: действует для `breakable` и `full`; `tc_piecewise` значение игнорирует.
- `--cuda-graph-max-seq-len-prefill`: второй порог (предикат backend'а DeepSeek-V4 и ширина low-ratio индексера). Граф реплеится, только если батч проходит оба.
- `--cuda-graph-config`: ключ `prefill.max_context_size` перекрывает флаг; значение в JSON — целое, суффиксы там не разбираются.
- `--context-length`: верхняя граница после выравнивания.
- `--page-size`: шаг выравнивания.
- `--attn-cp-size`: CP-путь breakable пока игнорирует значение.
- `--cuda-graph-max-bs-prefill`, `--cuda-graph-bs-prefill`: ограничивают число токенов в батче; от длины контекста не зависят.

## Типовые проблемы и диагностика

- **Что принято.** Лог `Prefill CUDA graph max context size: M; graph keys remain token-only.`, при выравнивании — `Page-aligning …`. Дамп `server_args=` показывает `max_context_size` внутри `cuda_graph_config`.
- **Старт падает с `only supported by attention backends that implement fixed-context prefill graph metadata`.** Модель не DeepSeek-V4; уберите флаг.
- **`Ignoring prefill CUDA graph max context size`.** Выбран `tc_piecewise` или CP-путь breakable; значение не используется.
- **Флаг задан, а память захвата не изменилась.** Prefill-граф выключен (`Breakable CUDA graph is incompatible with DeepSeek-V4 …` в логе); задайте backend явно.
- **`unrecognized arguments`.** Установленная сборка старше PR #36534.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4-Flash --trust-remote-code --tp-size 8 --cuda-graph-backend-prefill breakable --cuda-graph-prefill-max-context 32Ki
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4-Flash --trust-remote-code --tp-size 8 --cuda-graph-config '{"prefill":{"backend":"breakable","max_context_size":16384}}'
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/cuda_graph_hook.py`
- `sglang/python/sglang/srt/arg_groups/pipeline.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/layers/attention/deepseek_v4_backend.py`
- `sglang/python/sglang/srt/layers/attention/base_attn_backend.py`
- `sglang/python/sglang/srt/managers/scheduler_components/dp_attn.py`
- `sglang/python/sglang/srt/utils/common.py`
- upstream PR #36534 «[DSV4][BCG] Optimize the heavy memory use of C4 Indexer when BCG is enabled» (коммит `c9a8fba991` в checkout)
