---
schema: 1
engine: vllm
primaryName: "--performance-mode"
title: "--performance-mode"
summary: Пресет из трех значений, который меняет ровно две вещи: `throughput` удваивает автоподобранные `--max-num-batched-tokens` и `--max-num-seqs`, `interactivity` заменяет сетку CUDA graphs на поштучную 1…32. На явно заданные значения не влияет.
group: VllmConfig
related:
  - --max-num-batched-tokens
  - --max-num-seqs
  - --cudagraph-capture-sizes
  - --max-cudagraph-capture-size
  - --optimization-level
  - --gpu-memory-utilization
  - --enforce-eager
---

# --performance-mode

## Кратко

Несмотря на формулировки в справке про «throughput-oriented kernels» и «latency-oriented kernels», в коде этого commit'а `performance_mode` читается ровно в трех местах: в `EngineArgs._set_default_max_num_seqs_and_batched_tokens_args()`, в `VllmConfig._set_cudagraph_sizes()` и в `VllmConfig.__post_init__` для строки лога. Никакого выбора ядер по этому полю нет — ни MoE-, ни linear-, ни attention-backend его не читают.

Практически это означает: `--performance-mode` полезен только если вы **не задали** `--max-num-batched-tokens`, `--max-num-seqs` и `--cudagraph-capture-sizes` явно. На управляемом сервере, где эти значения обычно фиксируют, флаг остается инертным.

## Оригинальная справка

```text
Performance mode for runtime behavior, 'balanced' is the default.
'interactivity' favors low end-to-end per-request latency at small batch
sizes (fine-grained CUDA graphs, latency-oriented kernels).
'throughput' favors aggregate tokens/sec at high concurrency (larger CUDA
graphs, more aggressive batching, throughput-oriented kernels).
```

## Паспорт аргумента

- Флаги: `--performance-mode`
- Группа argparse: `VllmConfig`
- Тип значения: строка из фиксированного списка
- Допустимые значения: `balanced`, `interactivity`, `throughput`
- Значение по умолчанию: `balanced`
- Эффективное значение: не переопределяется, но **эффект аннулируется** явными значениями: удвоение батч-лимитов применяется только когда `--max-num-batched-tokens`/`--max-num-seqs` не заданы, а поштучная сетка графов — только когда не задан `--cudagraph-capture-sizes`
- Где объявлен: `vllm/config/vllm.py:VllmConfig.performance_mode`
- Этап применения: `create_engine_config` (подбор батч-лимитов) и `VllmConfig.__post_init__` → `_set_cudagraph_sizes()`

## Что меняет в движке

**`throughput`** — в `_set_default_max_num_seqs_and_batched_tokens_args`, сразу после подбора значений по классу устройства и до всех последующих зажимов:

- если `--max-num-batched-tokens` не задан, автоподобранное значение умножается на 2;
- если `--max-num-seqs` не задан, автоподобранное значение умножается на 2.

Дальше действуют обычные ограничители: подъем до `max_model_len` при выключенном chunked prefill, подъем под крупнейший мультимодальный элемент для prefix-LM моделей и финальное `min(max_num_seqs × max_model_len, значение)`, затем `max_num_seqs = min(max_num_seqs, max_num_batched_tokens)`. Поэтому фактическое удвоение может «съесться» этими зажимами.

**`interactivity`** — в `_set_cudagraph_sizes`, в ветке автоподбора сетки: вместо разреженного набора `[1, 2, 4] + шаг 8 до 256 + шаг 16 дальше` строится сплошной список `range(1, min(max_cudagraph_capture_size, 32) + 1)`, то есть каждый размер батча от 1 до 32 получает собственный граф. Разреженные размеры сверх 32 добавляются как обычно. Смысл — убрать паддинг батча до ближайшего захваченного размера на малых батчах, где паддинг с 5 до 8 стоит заметных процентов.

**`balanced`** — обе ветки работают как без флага.

Любое значение, отличное от `balanced`, дополнительно печатает в лог `Performance mode set to 'X'.`

## Значения и формат

- Ровно одно из трех значений, регистр важен (argparse-`choices`).
- Специальных значений (`auto`, `None`) нет.
- Флаг ничего не задает напрямую: он лишь модифицирует автоподбор. Если вы задали и `--max-num-batched-tokens`, и `--max-num-seqs`, и `--cudagraph-capture-sizes`, `--performance-mode` не изменит ничего, кроме строки в логе.

## Когда использовать

- **`interactivity`** — одиночная интерактивная сессия (chat, агент, IDE), где батч почти всегда меньше 32 и важна каждая миллисекунда межтокенной задержки. Плата — более долгий захват CUDA graphs при старте и больше памяти под них.
- **`throughput`** — пакетная обработка на карте с запасом VRAM, когда лень подбирать `--max-num-batched-tokens`/`--max-num-seqs` вручную. Удвоение обоих лимитов сразу увеличивает и пик активаций, и сетку графов, поэтому на тесной карте это прямой путь к OOM при захвате графов.
- **Не используйте как «режим быстрее/медленнее» поверх заданной конфигурации** — на явно заданных значениях он не делает ничего.
- **На управляемом инстансе arriero предпочтительнее явные значения:** `docs/VLLM_OPERATIONS.md` требует осознанных `--max-model-len`, `--max-num-seqs`, `--max-num-batched-tokens`, а автоподбор зависит от модели карты и потому не воспроизводится при переезде инстанса.

## Влияние на производительность и память

- **VRAM.** `throughput` через удвоение бюджета шага увеличивает пик активаций и сетку графов — обе величины вычитаются из бюджета `--gpu-memory-utilization` до KV-cache. `interactivity` добавляет до 32 отдельных графов вместо примерно 7 в том же диапазоне.
- **Время старта.** `interactivity` заметно удлиняет фазу `Capturing CUDA graphs`: графов становится в несколько раз больше.
- **Latency.** `interactivity` убирает паддинг батча на малых размерах; выигрыш измеряется единицами процентов ITL и полностью зависит от профиля нагрузки.
- **Throughput.** `throughput` помогает только если автоподобранные лимиты были узким местом и памяти хватает.

## Взаимодействие с другими аргументами

- `--max-num-batched-tokens`, `--max-num-seqs`: явные значения полностью отключают эффект `throughput`.
- `--cudagraph-capture-sizes`: явный список полностью отключает эффект `interactivity`.
- `--max-cudagraph-capture-size`: ограничивает сверху сетку в обоих режимах; в `interactivity` поштучный диапазон обрезается до `min(max_cudagraph_capture_size, 32)`.
- `--enforce-eager`: графы не захватываются вообще, ветка `interactivity` не выполняется.
- `--optimization-level`: ортогонален — уровень решает, компилировать ли и какой режим графов включить, `--performance-mode` — какие размеры графов захватывать.
- `--gpu-memory-utilization`: общий бюджет, из которого удвоенные лимиты `throughput` забирают память до KV-cache.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но ничего не изменилось. **Причина:** `--max-num-batched-tokens`/`--max-num-seqs`/`--cudagraph-capture-sizes` заданы явно. **Проверка:** строка `Performance mode set to 'X'.` в логе подтверждает только то, что значение принято, а не что оно на что-то повлияло. **Лечение:** убрать явные значения либо задать нужные числа напрямую.
- **Симптом:** OOM на этапе `Capturing CUDA graphs` после включения `throughput`. **Причина:** удвоенные `max_num_batched_tokens` и `max_num_seqs` расширили сетку графов. **Лечение:** вернуть `balanced` и задать лимиты явно либо ограничить `--max-cudagraph-capture-size`.
- **Симптом:** старт стал заметно дольше после `interactivity`. **Причина:** захватывается до 32 дополнительных графов. **Лечение:** ограничить `--max-cudagraph-capture-size` (например, 16) либо вернуть `balanced`.
- **Симптом:** предупреждение `max_num_batched_tokens (N) exceeds max_num_seqs * max_model_len (M).` после `throughput`. **Причина:** удвоение вывело бюджет за пределы достижимого. **Лечение:** задать `--max-num-batched-tokens` явно.
- **Подтверждение принятого значения:** `Performance mode set to 'X'.` (только для не-`balanced`) и строка `Chunked prefill is enabled with max_num_batched_tokens=N.` — по ней видно, удвоился ли бюджет.
- **Симптом (arriero):** после переезда инстанса на другую карту `throughput` дал другой результат. **Причина:** удваивается значение, подобранное по объему памяти устройства. **Лечение:** зафиксировать батч-лимиты явно.

## Примеры

```bash
vllm serve /models/Qwen3-4B --performance-mode interactivity --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --performance-mode throughput --max-cudagraph-capture-size 256
```

## Источники

- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/docs/configuration/optimization.md`
- `docs/VLLM_OPERATIONS.md` (arriero)
