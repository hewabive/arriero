---
schema: 1
engine: sglang
primaryName: "--piecewise-cuda-graph-tokens"
title: "--piecewise-cuda-graph-tokens"
summary: Устаревший алиас `--cuda-graph-bs-prefill` — явный список размеров, под которые захватывается prefill-граф. В отличие от decode, числа здесь означают суммарное количество токенов в батче, а не количество запросов.
group: null
related:
  - --cuda-graph-bs-prefill
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-backend-prefill
  - --cuda-graph-config
  - --cuda-graph-bs-decode
  - --chunked-prefill-size
  - --context-length
  - --moe-a2a-backend
  - --mem-fraction-static
---

# --piecewise-cuda-graph-tokens

## Кратко

Список форм для захвата prefill-графа. Ключевое отличие от decode: единица измерения — **суммарное число токенов в forward-батче**, а не число запросов. Имя `bs` в актуальном флаге `--cuda-graph-bs-prefill` сохранено ради симметрии с decode, а в коде эта величина везде называется `num_tokens`. Старое имя аргумента (`tokens`) было точнее, но оно устарело.

Обычно список не задают: движок строит сетку сам из потолка `--cuda-graph-max-bs-prefill`.

## Оригинальная справка

```text
Deprecated alias for --cuda-graph-bs-prefill.
```

## Паспорт аргумента

- Флаги: `--piecewise-cuda-graph-tokens`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне пофазной группы `exec.graph`
- Тип значения: список целых (`nargs="+"`), значения через пробел
- Допустимые значения: положительные целые количества токенов
- Значение по умолчанию: у алиаса значения по умолчанию нет; `dest` (`cuda_graph_bs_prefill`) инициализируется значением `None` от актуального флага
- Эффективное значение: `None` означает «построить сетку из потолка» функцией `_generate_prefill_cuda_graph_batch_sizes`. Заданный список позже дополнительно урезается в `capture_prefill_graph` пределом `max_capture_requests * context_length` и, при `--moe-a2a-backend deepep` с backend'ом `breakable`, выравнивается вверх до кратности восьми
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `cuda_graph_bs_prefill`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--cuda-graph-bs-prefill`
- Этап применения: разбор CLI (предупреждение) → `_handle_cuda_graph_config` → `_handle_gpu_memory_settings` → `capture_prefill_graph` (обрезка по контексту и пулу запросов) → захват prefill-графа

## Что меняет в движке

### Предупреждение и трансляция

```text
'--piecewise-cuda-graph-tokens' is deprecated and will be removed in a future release. Use '--cuda-graph-bs-prefill' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Автоматическая сетка, которую список замещает

```python
capture_sizes = (
    list(range(4, 33, 4))
    + list(range(48, 257, 16))
    + list(range(288, 513, 32))
    + list(range(576, 1024 + 1, 64))
    + list(range(1280, 4096 + 1, 256))
    + list(range(4608, max_bs + 1, 512))
)
capture_sizes = [s for s in capture_sizes if s <= max_bs]
```

Сетка логарифмическая: густая на коротких формах, редкая на длинных. Количество форм: потолок 2048 → 42 формы, 4096 → 50, 8192 → 58, 16384 → 74. Каждая форма — отдельный проход захвата, поэтому число форм и есть основной множитель времени старта на этой фазе.

Обратите внимание: сетка начинается с 4 токенов, а не с 1. Батч меньше минимальной формы дополняется вверх — там это дешево.

### Дополнительная обрезка перед захватом

`capture_prefill_graph` пересчитывает верхнюю границу как `max_capture_requests * context_length`, где `max_capture_requests` — размер пула запросов (для backend'а `full` — резолвленный `full_prefill_max_req`, по умолчанию `chunked_prefill_size // 512`). Формы выше этого предела выбрасываются, а если после фильтрации не осталось ни одной:

```text
Disable prefill CUDA graph capture because no configured capture size fits backend=%s with max_capture_tokens=%s (max_capture_requests=%s, context_length=%s, request-pool size=%s).
```

Итоговый список печатается строкой `Capture target prefill CUDA graph begin. backend=…, num_tokens=[…]` — сверяться нужно с ней.

Во время захвата на ранге 0 идет прогресс-бар `Capturing num tokens (num_tokens=… avail_mem=… GB)`.

## Значения и формат

- Перечисление через пробел: `--cuda-graph-bs-prefill 512 1024 2048`. Запятые не поддерживаются.
- Список сортируется; захват идет от большего к меньшему для лучшего переиспользования пула памяти.
- Форма — число токенов в батче, а не число запросов. Ориентируйтесь на `--chunked-prefill-size`: именно он ограничивает размер одного prefill-шага, и по умолчанию для не-MLA моделей потолок prefill-графа равен ему.
- Батч токенов выше максимальной формы выполняется eager-путем.
- В YAML через `--config` ключ `cuda-graph-bs-prefill` задать нельзя — он отвергается из-за этого устаревшего алиаса на общем `dest`. Обходной путь — `cuda-graph-config`.

## Когда использовать

- Не использовать: пишите `--cuda-graph-bs-prefill`.
- Сам параметр (под новым именем) оправдан, когда `chunked_prefill_size` фиксирован и реальные prefill-шаги почти всегда одного размера: две-три формы вместо пятидесяти заметно сокращают старт.
- Оправдан и как способ ограничить память под prefill-граф для MLA-моделей, где резерв фиксированный, но фактический расход растет с числом форм.
- Не задавать при разнородной нагрузке с включенным chunked prefill: попадание вне списка дает либо padding вверх (лишняя работа), либо eager (потеря latency).

## Влияние на производительность и память

- VRAM: оценочный резерв движка для не-MLA моделей равен `len(prefill.bs) * 8` МиБ, то есть напрямую зависит от длины списка; для MLA берется фиксированные 1.5 ГиБ независимо от длины. Фактический расход — `mem usage` в строке `Capture target prefill CUDA graph end`.
- Время старта: линейно по числу форм. С backend'ом `tc_piecewise` и компилятором `inductor` множитель гораздо больше, чем с `breakable`.
- Latency prefill: формы из списка идут по графу, остальные дополняются вверх или выполняются eager.
- Throughput: косвенно, через резерв VRAM в автоподборе `--mem-fraction-static`.

## Взаимодействие с другими аргументами

- `--cuda-graph-bs-prefill`: актуальное имя того же поля.
- `--cuda-graph-max-bs-prefill`: потолок, из которого строится сетка, если список не задан. При заданном списке потолок сеткой не пересчитывается — в отличие от decode, где `max_bs` становится `max(bs)`.
- `--chunked-prefill-size`: определяет реальный размер prefill-шага и служит значением по умолчанию для потолка prefill-графа у не-MLA моделей.
- `--context-length`: входит в предел `max_capture_requests * context_length`, по которому список обрезается.
- `--moe-a2a-backend deepep` с backend'ом `breakable`: формы выравниваются вверх до кратности восьми.
- `--cuda-graph-backend-prefill disabled`: список перестает что-либо значить.
- `--cuda-graph-bs-decode`: аналог другой фазы, где числа означают запросы, а не токены.

## Типовые проблемы и диагностика

- `'--piecewise-cuda-graph-tokens' is deprecated …` — замените на `--cuda-graph-bs-prefill`.
- `Disable prefill CUDA graph capture because no configured capture size fits backend=… ` — все формы выше предела по контексту и пулу запросов. Добавьте меньшие значения.
- Список в логе короче переданного — сработала обрезка; сверяйтесь с `num_tokens=[…]` в строке `Capture target prefill CUDA graph begin`.
- `Breakable prefill CUDA graph with DeepEP requires bucket sizes divisible by 8; aligning [...] -> [...].` — формы выровнены автоматически.
- OOM во время `Capturing num tokens (num_tokens=…)` — слишком много форм или слишком большие; сократите список или уменьшите `--mem-fraction-static`.
- Prefill идет eager при больших запросах — размер шага выше максимальной формы.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-bs-prefill 512 1024 2048
```

Согласованная пара с размером chunk'а prefill:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chunked-prefill-size 2048 --cuda-graph-bs-prefill 1024 2048
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
