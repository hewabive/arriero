---
schema: 1
engine: sglang
primaryName: "--disable-piecewise-cuda-graph"
title: "--disable-piecewise-cuda-graph"
summary: Устаревший алиас `--cuda-graph-backend-prefill=disabled` — выключает захват графа на фазе prefill, не трогая decode. Имя осталось от времен, когда единственным prefill-backend'ом был piecewise.
group: null
related:
  - --cuda-graph-backend-prefill
  - --disable-prefill-cuda-graph
  - --cuda-graph-config
  - --cuda-graph-backend-decode
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-bs-prefill
  - --mem-fraction-static
  - --chunked-prefill-size
  - --disaggregation-mode
---

# --disable-piecewise-cuda-graph

## Кратко

Выключает CUDA graph только на фазе prefill; decode продолжает работать по графу. Название устарело дважды: во-первых, флаг переименован в `--cuda-graph-backend-prefill=disabled`, во-вторых, «piecewise» сегодня — лишь один из четырех prefill-backend'ов (`full`, `breakable`, `tc_piecewise`, `disabled`), и флаг выключает любой из них, а не только piecewise.

Существует и второй, не устаревший булев эквивалент — `--disable-prefill-cuda-graph`. Он отличается местом в лестнице приоритетов: пофазный `--cuda-graph-backend-prefill` перекрывает его, а этот алиас, наоборот, сам пишет в поле `cuda_graph_backend_prefill`.

Апстрим-документ `piecewise_cuda_graph.mdx` в checkout'е все еще описывает `--disable-piecewise-cuda-graph` как штатный способ выключения — он отстал от кода. Ориентируйтесь на `server_args.py`.

## Оригинальная справка

```text
Deprecated alias for --cuda-graph-backend-prefill=disabled.
```

## Паспорт аргумента

- Флаги: `--disable-piecewise-cuda-graph`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне пофазной группы `exec.graph`
- Тип значения: флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `None` (`DeprecatedStoreConstAction` с `default=None`) — поле остается незаданным
- Эффективное значение: кладет константу `disabled` в `cuda_graph_backend_prefill`; `_parse_cuda_graph_config` переносит ее в `cuda_graph_config.prefill.backend` и блокирует пару `(prefill, backend)` в `_cuda_graph_config_locked`, что заодно отменяет каскад авто-отключения (отключать уже нечего) и защищает значение от ролевых правок PD
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `cuda_graph_backend_prefill`
- Статус: устаревший (`DeprecatedStoreConstAction`), замена — `--cuda-graph-backend-prefill disabled`
- Этап применения: разбор CLI (предупреждение) → `_handle_cuda_graph_config` → `capture_prefill_graph` (создание eager-runner'а вместо графа)

## Что меняет в движке

### Предупреждение и трансляция

```text
'--disable-piecewise-cuda-graph' is deprecated and will be removed in a future release. Use '--cuda-graph-backend-prefill=disabled' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Что происходит при выключенном prefill-графе

`capture_prefill_graph` (`sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`) первым же условием проверяет резолвленный backend и, если он `disabled`, возвращает `EagerRunner`:

```text
Disable prefill CUDA graph because cuda_graph_config resolved prefill.backend='disabled' (e.g. via --cuda-graph-backend-prefill=disabled or auto-disable rules).
```

Строк `Capture target prefill CUDA graph begin/end` в логе не будет, а `memory_usage.graph.prefill` и `startup_time.cuda_graph.prefill` в `GET /server_info` останутся нулевыми. Каждый extend-шаг после этого выполняется eager-путем.

Второй эффект — на память: `reserve_for_graph_mb()` перестает добавлять резерв за prefill (`len(prefill.bs) * 8` МиБ для не-MLA, 1.5 ГиБ для MLA, плюс 1 ГиБ для связки breakable+DeepEP). При незаданном `--mem-fraction-static` это увеличивает автоподобранное значение, то есть KV-пул.

Третий эффект менее очевиден: `post_capture_kv_sizing_planned()` требует, чтобы prefill-backend не был `disabled`. Экспериментальная схема досчета KV-пула после захвата (`SGLANG_ENABLE_POST_CAPTURE_KV_SIZING`) с этим флагом не включится.

### Блокировка ролевых правок PD

`_apply_cuda_graph_disaggregation_roles` выключает prefill-граф на decode-воркере и decode-граф на prefill-воркере, но только если соответствующая пара не заблокирована. Явное `disabled` для prefill блокировку ставит, поэтому конфигурация остается ровно такой, как задана.

## Значения и формат

- Булев флаг без значения; «не задан» означает «backend prefill выбирается по умолчанию» (`breakable` на CUDA, `tc_piecewise` на прочих платформах) и может быть отключен автоматически по правилам совместимости.
- Взаимно исключающие соседи по тому же полю: `--enable-breakable-cuda-graph` и `--enforce-piecewise-cuda-graph`. При одновременной передаче побеждает разобранный последним; передавать их вместе не нужно.
- Пофазный `--cuda-graph-backend-prefill` перекрывает алиас, JSON `--cuda-graph-config` перекрывает всё.
- Флаг не трогает decode. Чтобы выключить обе фазы, нужны два флага либо legacy `--disable-cuda-graph`.
- В YAML через `--config` ключ `cuda-graph-backend-prefill` недоступен — он отвергается из-за алиасов на общем `dest`.

## Когда использовать

- Не использовать: пишите `--cuda-graph-backend-prefill disabled`.
- Сам режим оправдан, когда захват prefill падает или подвешивает старт на конкретной модели, а decode-граф при этом ценен и его хочется сохранить. Это дешевле, чем `--disable-cuda-graph`, который убивает и decode.
- Оправдан при отладке численных расхождений на prefill: eager-путь дает нормальную трассировку и работающие forward-хуки.
- Не выключать prefill-граф ради VRAM, если модель не MLA: там резерв составляет десятки мегабайт (`len(bs) * 8` МиБ), а не гигабайты.
- На decode-воркере PD-disaggregation флаг избыточен: prefill-граф там и так отключается ролевой правкой.

## Влияние на производительность и память

- VRAM: освобождается prefill-часть резерва — единицы-десятки мегабайт для не-MLA моделей, около 1.5 ГиБ для MLA, плюс 1 ГиБ при breakable+DeepEP.
- Время старта: пропадает фаза захвата prefill (десятки форм, каждая — отдельный прогон).
- Latency prefill: растет на величину накладных расходов запуска ядер. На длинных chunk'ах доля мала, на коротких chunk'ах и на мелких запросах заметна.
- Decode: не затрагивается.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-prefill disabled`: актуальная форма.
- `--disable-prefill-cuda-graph`: не устаревший булев эквивалент; приоритетом ниже пофазного флага, но выше legacy `--disable-cuda-graph`.
- `--cuda-graph-max-bs-prefill` / `--cuda-graph-bs-prefill`: перестают что-либо значить.
- `--cuda-graph-backend-decode`: независим; decode остается на `full` по умолчанию.
- `--mem-fraction-static`: при незаданном значении автоподбор вырастет.
- `--chunked-prefill-size`: определяет и prefill-потолок графа (для не-MLA), и активационный резерв; при выключенном графе остается только вторая связь.
- `--disaggregation-mode decode`: prefill-граф выключается сам, флаг избыточен.

## Типовые проблемы и диагностика

- `'--disable-piecewise-cuda-graph' is deprecated …` — замените на `--cuda-graph-backend-prefill disabled`.
- Флаг задан, а в логе все равно `Capture target prefill CUDA graph begin` — рядом стоит `--cuda-graph-backend-prefill` с другим значением или JSON `--cuda-graph-config`. Смотрите итог в `cuda_graph_config=` дампа `server_args=`.
- Prefill стал медленнее ровно на константу на запрос — это и есть ожидаемая цена eager-пути.
- KV-пул вырос после добавления флага — обнулился резерв под prefill-граф при незаданном `--mem-fraction-static`.
- Что смотреть: строка `Disable prefill CUDA graph because cuda_graph_config resolved prefill.backend='disabled' …`, нулевые `memory_usage.graph.prefill` / `startup_time.cuda_graph.prefill` в `GET /server_info`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill disabled
```

Выключить prefill-граф, оставив decode на полном графе с ограниченным потолком:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill disabled --cuda-graph-backend-decode full --cuda-graph-max-bs-decode 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/eager_runner.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/piecewise_cuda_graph.mdx` (отстал от кода: описывает устаревшие имена как актуальные)
