---
schema: 1
engine: sglang
primaryName: "--piecewise-cuda-graph-max-tokens"
title: "--piecewise-cuda-graph-max-tokens"
summary: Устаревший алиас `--cuda-graph-max-bs-prefill` — верхняя граница числа токенов, для которого захватывается prefill-граф. По умолчанию равна `--chunked-prefill-size`, а для MLA-моделей жестко 2048.
group: null
related:
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-bs-prefill
  - --cuda-graph-backend-prefill
  - --cuda-graph-config
  - --cuda-graph-max-bs-decode
  - --chunked-prefill-size
  - --max-total-tokens
  - --context-length
  - --mem-fraction-static
---

# --piecewise-cuda-graph-max-tokens

## Кратко

Потолок, из которого строится сетка форм prefill-графа. Измеряется в токенах суммарного forward-батча, а не в запросах. Флаг устарел и переименован в `--cuda-graph-max-bs-prefill` — имя `max-bs` выбрано ради симметрии с decode, хотя единица измерения у фаз разная.

Значение по умолчанию не константа: движок подбирает его в `_handle_gpu_memory_settings` из `--chunked-prefill-size` (для не-MLA моделей) или берет 2048 (для MLA), затем при необходимости ограничивает его `--max-total-tokens` и отдельным потолком 4096 для семейства Llama-2.

## Оригинальная справка

```text
Deprecated alias for --cuda-graph-max-bs-prefill.
```

## Паспорт аргумента

- Флаги: `--piecewise-cuda-graph-max-tokens`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне пофазной группы `exec.graph`
- Тип значения: int
- Допустимые значения: положительное целое количество токенов; argparse границ не проверяет
- Значение по умолчанию: у алиаса значения по умолчанию нет; `dest` (`cuda_graph_max_bs_prefill`) инициализируется значением `None` от актуального флага
- Эффективное значение: при `None` подбирается в `_handle_gpu_memory_settings`: `chunked_prefill_size` для не-MLA и `2048` для MLA-моделей, затем `min(…, max_total_tokens)` при заданном `--max-total-tokens` и `min(…, 4096)`, если в пути к модели встречается `llama-2`. Дополнительно `capture_prefill_graph` обрезает уже сгенерированные формы пределом `max_capture_requests * context_length`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `cuda_graph_max_bs_prefill`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--cuda-graph-max-bs-prefill`
- Этап применения: разбор CLI (предупреждение) → `_handle_cuda_graph_config` → `_handle_gpu_memory_settings` (подбор и генерация сетки) → `capture_prefill_graph` → захват prefill-графа

## Что меняет в движке

### Предупреждение и трансляция

```text
'--piecewise-cuda-graph-max-tokens' is deprecated and will be removed in a future release. Use '--cuda-graph-max-bs-prefill' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Почему у MLA-моделей потолок фиксирован

В `_handle_gpu_memory_settings` явно закомментировано: у MLA-backend'а введение piecewise-графа меняет диспетчеризацию ядер относительно обычного режима, и, чтобы не получить регрессию производительности, потолок принудительно ставится равным 2048 вне зависимости от `--chunked-prefill-size`. Для остальных моделей потолок равен размеру chunk'а prefill — то есть по умолчанию граф покрывает ровно те формы, которые планировщик реально формирует.

### Из потолка получается сетка

`_generate_prefill_cuda_graph_batch_sizes(max_bs)` строит логарифмическую сетку: шаг 4 до 32, 16 до 256, 32 до 512, 64 до 1024, 256 до 4096, дальше 512. Количество форм: 2048 → 42, 4096 → 50, 8192 → 58, 16384 → 74. Это и есть множитель времени старта на фазе prefill.

Итоговый список после всех обрезок печатается в логе:

```text
Capture target prefill CUDA graph begin. backend=breakable, num_tokens=[4, 8, 12, ..., 2048], avail mem=12.41 GB
Capture target prefill CUDA graph end. elapsed=7.13 s, mem usage=0.11 GB, avail mem=12.30 GB.
```

Эти две строки — авторитетный ответ на вопрос, сколько стоил захват prefill: `elapsed` в секундах, `mem usage` в гигабайтах. Те же величины доступны в `GET /server_info` (`startup_time.cuda_graph.prefill`, `memory_usage.graph.prefill`) и как gauge `sglang:graph_memory_usage_gb{phase="prefill"}` при `--enable-metrics`.

## Значения и формат

- Одно положительное целое количество токенов.
- Значения нет отдельного «авто»: не задавать — и есть авто.
- Явно заданный `--cuda-graph-bs-prefill` полностью замещает сетку; потолок при этом **не** пересчитывается по списку (в отличие от decode, где `max_bs` становится `max(bs)`), поэтому задавать оба одновременно бессмысленно.
- Потолок выше реального `--chunked-prefill-size` только удлиняет старт: формы, которых планировщик не создает, все равно будут захвачены.
- В YAML через `--config` ключ `cuda-graph-max-bs-prefill` задать нельзя — он отвергается из-за этого устаревшего алиаса на общем `dest`. Обходной путь — `cuda-graph-config`.

## Когда использовать

- Не использовать: пишите `--cuda-graph-max-bs-prefill`.
- Сам параметр (под новым именем) снижают, когда старт слишком долгий, а prefill-шаги короткие: потолок 2048 вместо 16384 убирает 32 формы из захвата.
- Повышают редко и только вместе с `--chunked-prefill-size`: смысл потолка в том, чтобы покрывать реальный размер шага, а не превышать его.
- Не поднимать на MLA-моделях без измерений: фиксированные 2048 стоят там именно из-за наблюдавшейся регрессии.

## Влияние на производительность и память

- VRAM: через число форм. Для не-MLA моделей резерв движка равен `len(prefill.bs) * 8` МиБ, для MLA — фиксированные 1.5 ГиБ. Фактический расход — `mem usage` в строке `Capture … end`.
- Время старта: линейно по числу форм; с backend'ом `tc_piecewise` и компилятором `inductor` каждая форма дополнительно компилируется.
- Latency prefill: шаги в пределах потолка идут по графу, выше — eager.
- Throughput: косвенно, через резерв VRAM в автоподборе `--mem-fraction-static`.

## Взаимодействие с другими аргументами

- `--cuda-graph-max-bs-prefill`: актуальное имя того же поля.
- `--cuda-graph-bs-prefill`: явный список форм; замещает сетку целиком.
- `--chunked-prefill-size`: значение по умолчанию для потолка у не-MLA моделей и главный ориентир при ручной настройке.
- `--max-total-tokens`: ограничивает автоподобранный потолок сверху.
- `--context-length`: входит в предел `max_capture_requests * context_length`, которым обрезается итоговый список форм.
- `--cuda-graph-max-bs-decode`: потолок другой фазы, измеряемый в запросах.
- `--cuda-graph-backend-prefill disabled`: потолок перестает что-либо значить.
- `--mem-fraction-static`: при незаданном значении резерв под prefill-граф уменьшает KV-пул.

## Типовые проблемы и диагностика

- `'--piecewise-cuda-graph-max-tokens' is deprecated …` — замените на `--cuda-graph-max-bs-prefill`.
- Потолок поднят, а формы в логе те же — сработала обрезка `max_capture_requests * context_length` либо ограничение `--max-total-tokens`.
- `Disable prefill CUDA graph capture because no configured capture size fits backend=…` — все формы выше предела; уменьшите потолок.
- Старт затянулся на десятки секунд именно на prefill — слишком высокий потолок; сверьтесь с `elapsed` в строке `Capture target prefill CUDA graph end`.
- OOM во время `Capturing num tokens (num_tokens=…)` — уменьшайте потолок или `--mem-fraction-static`.
- Что смотреть: `cuda_graph_config=` в дампе `server_args=`, строки `Capture target prefill CUDA graph begin/end`, `GET /server_info`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-max-bs-prefill 2048
```

Согласованная пара с размером chunk'а prefill:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chunked-prefill-size 4096 --cuda-graph-max-bs-prefill 4096 --mem-fraction-static 0.82
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
