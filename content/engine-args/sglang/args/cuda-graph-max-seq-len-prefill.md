---
schema: 1
engine: sglang
primaryName: "--cuda-graph-max-seq-len-prefill"
title: "--cuda-graph-max-seq-len-prefill"
summary: Верхняя граница длины последовательности (префикс плюс новый extend), при которой prefill-батч еще реплеится из CUDA graph; длиннее — eager. В checkout'е ключ читает только backend внимания DeepSeek-V4, а для DeepSeek-V4.1 с включенным prefill-графом движок сам ставит 16384.
group: exec.graph
related:
  - --cuda-graph-config
  - --cuda-graph-backend-prefill
  - --cuda-graph-prefill-max-context
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-bs-prefill
  - --disable-prefill-cuda-graph
  - --enable-decoder-swa-bounded-replay
  - --enable-encoder-swa-bounded-replay
  - --context-length
---

# --cuda-graph-max-seq-len-prefill

## Кратко

Это обертка над ключом `max_seq_len` секции `prefill` в `--cuda-graph-config`. Захваченный prefill-граф DeepSeek-V4 содержит работу, ширина которой зависит от длины контекста: индексер слоев с низким сжатием скорит контекст фиксированной ширины. Поэтому граф ограничен длиной, и батч, в котором хотя бы одна последовательность длиннее порога, идет eager.

У других архитектур в checkout'е потребителя ключа нет, и флаг на них ничего не делает. Аргумент новый (upstream PR #38798, интеграция DeepSeek-V4.1); в закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
Longest sequence a prefill cuda graph replay admits; longer batches run eager prefill. Folds into cuda_graph_config[prefill].max_seq_len.
```

## Паспорт аргумента

- Флаги: `--cuda-graph-max-seq-len-prefill`
- Группа: `exec.graph`
- Тип значения: int, в токенах; суффиксы вроде `16k` не принимаются
- Допустимые значения: целое; диапазон не проверяется
- Значение по умолчанию: `null` — без ограничения по длине
- Эффективное значение: `parse_cuda_graph_config` кладет значение в `cuda_graph_config.prefill.max_seq_len` и ставит замок `(prefill, "max_seq_len")`. JSON-ключ `max_seq_len` из `--cuda-graph-config` перекрывает флаг. Если значение осталось `null`, модель — DeepSeek-V4.1 (`model_type` `deepseek_v41`), а prefill-граф включен, `validate_deepseek_v41_features` (`arg_groups/deepseek_v4_hook.py`) подставляет `16384` с предупреждением `Setting cuda_graph_config[prefill].max_seq_len to 16384 for DeepSeek-V4.1; longer contexts run eager prefill.`
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecGraph.cuda_graph_max_seq_len_prefill`
- Статус: обычный, новый
- Этап применения: разбор CLI → `handle_cuda_graph_config` → `handle_model_specific_adjustments` (дефолт V4.1) → конструктор `PrefillCudaGraphRunner`, который запоминает предикат backend'а `can_run_prefill_cuda_graph` → захват и решение о replay на каждом prefill-батче

## Что меняет в движке

Ключ читает только `layers/attention/deepseek_v4_backend.py` (функция `_prefill_graph_max_seq_len`), в двух местах:

1. **Допуск к replay.** `DeepseekV4AttnBackend.can_run_prefill_cuda_graph(forward_batch)` возвращает `max(seq_lens) <= max_seq_len`. `PrefillCudaGraphRunner.can_run_graph` спрашивает этот предикат последним, поэтому длинный батч целиком идет eager. `seq_lens` — полная длина последовательности: кешированный префикс плюс новый extend, а не размер чанка.
2. **Ширина индексера в графе.** `_low_ratio_prefill_indexer_metadata` обрезает page table индексера для слоев с сжатием 1 и 2 до `max_seq_len // page_size` страниц; на эту ширину захватываются логиты индексера, а строки идут чанками по 2048 (`_PREFILL_GRAPH_INDEXER_ROW_CHUNK`). Путь активен, когда у модели есть такие слои, используется dense FP4-индексер и GPU SM100 или новее (`low_ratio_prefill_graph`).

При `null` предикат пропускает любой батч, а ширину контекстных буферов определяют `--cuda-graph-prefill-max-context` или ширина `req_to_token`.

Важно для DeepSeek-V4: prefill-граф у этой архитектуры по умолчанию выключен. Каскад совместимости гасит дефолтный `breakable` с причиной `DeepSeek-V4 (heavy capture-pool memory pressure)`. Флаг начинает влиять только после явного `--cuda-graph-backend-prefill breakable` (или `full`), который снимает каскад.

## Значения и формат

- Целое число токенов.
- `null` — без ограничения; на DeepSeek-V4.1 с включенным prefill-графом превращается в `16384`.
- Значения `<= 0` движок не отвергает, но тогда любой непустой батч не проходит предикат, и prefill всегда идет eager. Такая конфигурация бессмысленна.
- Значение больше `--context-length` ничего не ограничивает.

## Когда использовать

- DeepSeek-V4.1 с явно включенным prefill-графом, где заметная доля промптов длиннее 16384 и граф для них дает выигрыш. Поднимите порог, приняв более широкую работу индексера внутри графа. Комментарий в `deepseek_v4_hook.py` объясняет выбор 16k: так индексер остается в окне кандидатов и стоит меньше 1 мс на слой.
- Захват или replay prefill-графа на длинных контекстах ведет себя плохо (память, ошибки) — опустите порог, длинные пойдут eager.
- На других моделях не трогайте: потребителя нет.

## Влияние на производительность и память

- **VRAM.** При активном пути low-ratio индексера ширина его логитов в захваченном графе пропорциональна порогу: больше порог — больше буферы захвата. Фактическую стоимость показывает строка `Capture target prefill CUDA graph end. … mem usage=… GB`.
- **TTFT.** Батчи с последовательностями длиннее порога теряют выигрыш графа.
- **Время старта.** Число захватов не меняется: формы графа — токен-бакеты (`--cuda-graph-max-bs-prefill`, `--cuda-graph-bs-prefill`).

## Взаимодействие с другими аргументами

- `--cuda-graph-config`: ключ `prefill.max_seq_len` перекрывает флаг.
- `--cuda-graph-backend-prefill`, `--disable-prefill-cuda-graph`: на DeepSeek-V4 без явного backend'а prefill-граф выключен, и флаг ни на что не влияет.
- `--cuda-graph-prefill-max-context`: соседний ключ `max_context_size`. Он задает фиксированный размер контекстных метаданных всего графа и проверяется runner'ом (только для `breakable`/`full`). `max_seq_len` — предикат backend'а и ширина low-ratio индексера. Граф реплеится, только если батч проходит оба порога.
- `--cuda-graph-max-bs-prefill`, `--cuda-graph-bs-prefill`: ограничивают число токенов в батче, а не длину отдельной последовательности; проверки независимы.
- `--enable-decoder-swa-bounded-replay`, `--enable-encoder-swa-bounded-replay`: требуют выключенного prefill-графа, поэтому вместе с ними флаг теряет смысл.
- `--context-length`: естественный потолок.

## Типовые проблемы и диагностика

- **Какое значение действует.** В дампе `server_args=` (`sglang/python/sglang/srt/entrypoints/engine.py`) — `cuda_graph_config=CudaGraphConfig(…, prefill=PhaseConfig(…, max_seq_len=…))`.
- **На DeepSeek-V4.1 появилось предупреждение про 16384.** Это автоподстановка: значение не задано, prefill-граф включен.
- **Флаг задан, эффекта нет.** На DeepSeek-V4 проверьте строку `Breakable CUDA graph is incompatible with DeepSeek-V4 (heavy capture-pool memory pressure); disabling prefill CUDA graph.` — граф выключен каскадом. На других моделях потребителя нет.
- **Длинные запросы не ускорились после включения графа.** Ожидаемо: они длиннее порога.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4.1-Flash --trust-remote-code --tp-size 8 --cuda-graph-backend-prefill breakable --cuda-graph-max-seq-len-prefill 32768
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4.1-Flash --trust-remote-code --tp-size 8 --cuda-graph-config '{"prefill":{"backend":"breakable","max_seq_len":8192}}'
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/cuda_graph_hook.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/arg_groups/model_hook.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/layers/attention/deepseek_v4_backend.py`
- upstream PR #38798 «dsv4.1: remaining model and runtime integration» (коммит `a6cf05817f` в checkout)
