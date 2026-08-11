---
schema: 1
engine: sglang
primaryName: "--disable-prefill-cuda-graph"
title: "--disable-prefill-cuda-graph"
summary: Выключает захват CUDA graph для фазы prefill — самый дешевый способ убрать со старта компиляцию и захват десятков токен-бакетов. Эквивалент `--cuda-graph-backend-prefill disabled`.
group: exec.graph
related:
  - --cuda-graph-backend-prefill
  - --disable-decode-cuda-graph
  - --disable-cuda-graph
  - --disable-piecewise-cuda-graph
  - --cuda-graph-config
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-bs-prefill
  - --cuda-graph-tc-compiler
  - --chunked-prefill-size
  - --mem-fraction-static
---

# --disable-prefill-cuda-graph

## Кратко

Флаг-переключатель: `cuda_graph_config[prefill].backend = disabled`. Prefill идет через `EagerRunner`, prefill-граф не компилируется и не захватывается. Prefill-граф моложе decode-графа и отключается движком автоматически в десятках конфигураций; этот флаг просто делает решение явным и убирает со старта самую дорогую его часть — проход компиляции `tc_piecewise` и захват до 58–74 токен-бакетов.

## Оригинальная справка

```text
Disable the prefill-phase CUDA graph. Convenience for --cuda-graph-backend-prefill=disabled.
```

## Паспорт аргумента

- Флаги: `--disable-prefill-cuda-graph`
- Группа: `exec.graph`
- Тип значения: bool, `action="store_true"` — значение не принимает
- Допустимые значения: флаг либо есть, либо его нет
- Значение по умолчанию: `false`
- Эффективное значение: в `_parse_cuda_graph_config` пишет `disabled` в `cuda_graph_config[prefill].backend` и фиксирует пару `(prefill, "backend")`. Перекрывается более поздним `--cuda-graph-backend-prefill` и `--cuda-graph-config`
- Где объявлен: `ServerArgs.disable_prefill_cuda_graph`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный. Устаревший аналог — `--disable-piecewise-cuda-graph` (транслируется в `--cuda-graph-backend-prefill=disabled`), а `--disable-cuda-graph` гасит сразу обе фазы
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config`) → `capture_prefill_graph` направляет prefill в `EagerRunner`

## Что меняет в движке

`capture_prefill_graph` в `model_runner_components/cuda_graph_setup.py` видит `prefill.backend == disabled`, печатает

```text
Disable prefill CUDA graph because cuda_graph_config resolved prefill.backend='disabled' (e.g. via --cuda-graph-backend-prefill=disabled or auto-disable rules).
```

и возвращает `EagerRunner` в качестве prefill-runner'а (его `can_run_graph()` всегда `False`, поэтому ветка extend в `_forward_raw` уходит на eager-путь).

Дополнительно флаг гасит два побочных эффекта:

- `reserve_for_graph_mb()` перестает добавлять prefill-слагаемое в резерв автоподбора `--mem-fraction-static` (`len(prefill.bs) * 8` МиБ для не-MLA моделей, 1.5 ГиБ для MLA, плюс 1 ГиБ при `breakable` вместе с DeepEP);
- `post_capture_kv_sizing_planned()` отключает досчет KV-пула после захвата.

Флаг также раньше всех выключает `_apply_inkling_prefill_cuda_graph_default` — архитектурное переопределение prefill-графа на `full` для Inkling проверяет его напрямую.

## Значения и формат

- Значения не принимает.
- Отменяется только более приоритетным флагом: `--cuda-graph-backend-prefill breakable` или `--cuda-graph-config '{"prefill":{"backend":"breakable"}}'`.
- Замок на `(prefill, "backend")` пропускает каскад `_apply_cuda_graph_compatibility` и правило DeepSeek/`trtllm_mla`. Смысла в этом нет — фаза и так выключена, — но в логе вы не увидите ни одной строки `… is incompatible with …`, и это не признак того, что конфигурация совместима.

## Когда использовать

- Ускорить старт. Prefill-граф на `chunked_prefill_size 8192` — это 58 захватываемых форм; при `tc_piecewise` перед захватом идет еще проход компиляции по всем формам (`Compiling num tokens (num_tokens=…)`), который на inductor занимает минуты.
- Prefill-граф дает регресс TTFT. Такое бывает на MLA-backend'ах: движок сам гасит prefill-граф для DeepSeek-V3 на `trtllm_mla` именно поэтому, но похожие случаи бывают и вне зашитого правила — проверяется измерением TTFT с флагом и без.
- Сузить круг подозреваемых при странных ответах или падениях в prefill: eager-путь исключает захват/реплей.
- Не отключайте prefill-граф «за компанию» с decode: decode-граф отвечает за скорость генерации токенов, prefill-граф — за TTFT, и это независимые бюджеты.

## Влияние на производительность и память

- **Время старта:** убирается самый долгий этап инициализации на многих конфигурациях. Величина видна в паре строк `Capture target prefill CUDA graph begin/end. elapsed=… s`.
- **VRAM:** освобождается фактический объем prefill-графов (строка `mem usage=… GB`) и убирается априорный резерв. Для MLA-моделей резерв фиксированный — 1.5 ГиБ, и это самая заметная разница в автоподборе `--mem-fraction-static`.
- **TTFT:** растет. Насколько — зависит от длины запроса: на коротких prefill доля python-overhead велика, на длинных чанках она тонет в вычислениях.
- **Decode:** не затрагивается.
- Даже с включенным prefill-графом часть батчей идет в eager: реплей отвергается, если округление до ближайшего захваченного бакета более чем удваивает число токенов (`_MAX_PREFILL_CUDA_GRAPH_PADDING_FACTOR = 2`).

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-prefill`: полный эквивалент со значением `disabled`, применяется позже и выигрывает.
- `--cuda-graph-config`: ключ `prefill.backend` выигрывает у обоих.
- `--disable-cuda-graph` (устаревший): гасит обе фазы.
- `--cuda-graph-max-bs-prefill` / `--cuda-graph-bs-prefill` / `--cuda-graph-tc-compiler`: становятся бессмысленными.
- `--chunked-prefill-size`: без prefill-графа перестает влиять на длину списка форм, но по-прежнему определяет размер активаций и резерв автоподбора.
- `--mem-fraction-static`: при незаданном значении KV-пул вырастет; при заданном — освободившаяся память останется незанятой.
- `--disaggregation-mode decode`: и так гасит prefill-граф, флаг избыточен.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, а в логе `Capture target prefill CUDA graph begin`. **Причина:** позже задан `--cuda-graph-backend-prefill` или `--cuda-graph-config`. **Проверка:** `cuda_graph_config=` в дампе `server_args=`.
- **Симптом:** старт все равно долгий. **Причина:** остался decode-граф (`Capture target decode CUDA graph …`) или загрузка весов; prefill был только частью времени.
- **Симптом:** после отключения выросло TTFT на коротких запросах. Ожидаемо.
- **Что смотреть:** строка `Disable prefill CUDA graph because cuda_graph_config resolved prefill.backend='disabled' …` и отсутствие пары `Capture target prefill CUDA graph begin/end`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --disable-prefill-cuda-graph
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --disable-prefill-cuda-graph --cuda-graph-max-bs-decode 32 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/tc_piecewise_cuda_graph_backend.py`
