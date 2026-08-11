---
schema: 1
engine: sglang
primaryName: "--disable-decode-cuda-graph"
title: "--disable-decode-cuda-graph"
summary: Полностью выключает захват CUDA graph для фазы decode — сокращает старт и освобождает VRAM ценой заметно более медленного декодирования. Ровно то же самое, что `--cuda-graph-backend-decode disabled`.
group: exec.graph
related:
  - --cuda-graph-backend-decode
  - --disable-prefill-cuda-graph
  - --disable-cuda-graph
  - --cuda-graph-config
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs-decode
  - --mem-fraction-static
  - --max-running-requests
  - --torchao-config
---

# --disable-decode-cuda-graph

## Кратко

Флаг-переключатель: `cuda_graph_config[decode].backend = disabled`. Decode-runner на графах не создается, каждый шаг декодирования идет через `EagerRunner` с полным python-обходом модели. Вспоминают о нем в двух ситуациях: захват графов падает по памяти или по несовместимости, либо нужно быстро поднять сервер и не ждать десятки секунд захвата.

## Оригинальная справка

```text
Disable the decode-phase CUDA graph. Convenience for --cuda-graph-backend-decode=disabled.
```

## Паспорт аргумента

- Флаги: `--disable-decode-cuda-graph`
- Группа: `exec.graph`
- Тип значения: bool, `action="store_true"` — значение не принимает
- Допустимые значения: флаг либо есть, либо его нет
- Значение по умолчанию: `false`
- Эффективное значение: в `_parse_cuda_graph_config` пишет `disabled` в `cuda_graph_config[decode].backend` и фиксирует пару `(decode, "backend")`. Перекрывается более поздним `--cuda-graph-backend-decode` и `--cuda-graph-config`
- Где объявлен: `ServerArgs.disable_decode_cuda_graph`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный (это актуальная замена части контракта устаревшего `--disable-cuda-graph`, который гасит обе фазы сразу)
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config`) → `capture_decode_graph` пропускает создание runner'а

## Что меняет в движке

`capture_decode_graph` в `model_runner_components/cuda_graph_setup.py` проверяет `check_cuda_graph_backend(Phase.DECODE, Backend.DISABLED)` и возвращает пустой `GraphCapture`: runner отсутствует, `graph_memory_usage["decode"] = 0`, `graph_time_usage["decode"] = 0`. Строки `Capture target decode CUDA graph begin/end` в логе не появляются вовсе.

Дальше это значение читают и другие места: `reserve_for_graph_mb()` перестает добавлять `decode.max_bs * 2` МиБ в резерв автоподбора `--mem-fraction-static`, `reserve_for_deepep_a2a_mb()` перестает резервировать 2 ГиБ под буферы DeepEP a2a, а `post_capture_kv_sizing_planned()` отключает досчет KV-пула после захвата. Итог: при незаданном `--mem-fraction-static` отключение decode-графа автоматически увеличивает KV-пул.

Флаг не влияет на prefill-граф: его отключают `--disable-prefill-cuda-graph` или `--cuda-graph-backend-prefill disabled`.

## Значения и формат

- Значения не принимает; `--disable-decode-cuda-graph true` argparse отвергнет как лишний позиционный аргумент.
- Отменить его можно только более приоритетным флагом: `--cuda-graph-backend-decode full` или `--cuda-graph-config '{"decode":{"backend":"full"}}'` (оба применяются позже в цепочке приоритетов).
- Флаг ставит замок на `(decode, "backend")`, поэтому дальнейшая автоматика (`--disaggregation-mode prefill`, XPU-дефолт) для этого ключа не срабатывает. Практического эффекта это не дает: она бы тоже поставила `disabled`.

## Когда использовать

- Захват падает с `torch.OutOfMemoryError` в строках `Capturing batches (bs=…)`, а уменьшать `--cuda-graph-max-bs-decode` уже некуда.
- Диагностика: нужно понять, воспроизводится ли ошибка вычислений без графов. Eager-путь исполняет тот же код, но без записи и реплея.
- `--torchao-config int8dq`: апстрим-документация по квантизации прямо рекомендует отключать CUDA graph для этого метода из-за известных проблем с захватом.
- Быстрая проверка конфигурации инстанса, когда важен только факт «поднялось и отвечает», а не latency.
- Не оставляйте флаг в продовом профиле ради экономии памяти: `decode.max_bs * 2` МиБ — это единицы-сотни мегабайт, а потеря скорости декодирования измеряется десятками процентов и больше на маленьких батчах.

## Влияние на производительность и память

- **Время старта:** убирает весь этап захвата decode-графов. На профиле arriero (RTX A5000, Qwen3-30B-A3B с оффлоадом экспертов, две захваченные формы) это 47.9 с.
- **VRAM:** освобождает фактический объем графов (строка `mem usage=… GB` при включенном захвате) и убирает априорный резерв из автоподбора `--mem-fraction-static`.
- **Latency:** главная плата. Каждый шаг декода снова включает python-обход всех слоев; чем меньше батч и модель, тем больше относительная потеря.
- **Throughput:** падает вместе с latency, но на больших батчах слабее — там доля overhead меньше.
- RAM хоста и CPU-потоки: без изменений, кроме того что eager-путь нагружает python-поток шедулера сильнее.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-decode`: полный эквивалент со значением `disabled`, применяется позже и потому выигрывает при конфликте.
- `--cuda-graph-config`: ключ `decode.backend` выигрывает у обоих.
- `--disable-cuda-graph` (устаревший): гасит обе фазы; для decode это то же самое.
- `--cuda-graph-max-bs-decode` / `--cuda-graph-bs-decode`: становятся бессмысленными, но по-прежнему записываются в конфиг и видны в дампе.
- `--mem-fraction-static`: при незаданном значении автоподбор станет щедрее (меньше резерв → больше KV-пул). Если значение задано явно — освободившаяся память просто останется свободной.
- `--max-running-requests`: без графов ограничение конкурентности остается прежним, меняется только стоимость шага.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но в логе все равно `Capture target decode CUDA graph begin`. **Причина:** позже по цепочке приоритетов задан `--cuda-graph-backend-decode` или `--cuda-graph-config` с включенным backend'ом. **Проверка:** `cuda_graph_config=` в дампе `server_args=`.
- **Симптом:** после отключения графов декодирование стало заметно медленнее при том же батче. Это ожидаемое поведение, а не регресс.
- **Симптом:** ждали освобождения нескольких гигабайт, освободились сотни мегабайт. **Причина:** графы decode обычно занимают немного; крупные аллокации на старте — это веса и KV-пул.
- **Что смотреть:** отсутствие пары строк `Capture target decode CUDA graph begin/end` в логе и `cuda_graph_config=CudaGraphConfig(decode=PhaseConfig(backend='disabled', …` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --disable-decode-cuda-graph
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --disable-decode-cuda-graph --disable-prefill-cuda-graph --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/docs/docs/advanced_features/quantization.mdx`
- arriero: `docs/qualification/ktransformers/0.6.4-2026-07-30.md`
