---
schema: 1
engine: vllm
primaryName: "--disable-log-stats"
title: "--disable-log-stats"
summary: Полностью выключает сбор статистики движка: исчезают и периодические строки со скоростью и заполнением KV-cache, и все метрики `vllm:*` в `/metrics`. Не «убавляет логи», а лишает сервер основного источника наблюдаемости.
group: null
related:
  - --enable-log-requests
  - --aggregate-engine-logging
  - --api-server-count
  - --enable-per-request-metrics
  - --enable-server-load-tracking
---

# --disable-log-stats

## Кратко

Название вводит в заблуждение: `--disable-log-stats` выключает не вывод в лог, а **всю подсистему статистики**. Флаг превращается в `log_stats=False`, который прокидывается в `AsyncLLM`, в клиент `EngineCore` и в `OutputProcessor`; при `log_stats=False` `StatLoggerManager` вообще не создается, а вместе с ним не создается и `PrometheusStatLogger`.

Практический итог: в логе пропадают периодические строки вида `Engine 000: Avg prompt throughput: ..., Running: N reqs, Waiting: N reqs, GPU KV cache usage: ...%, Prefix cache hit rate: ...%`, а из `/metrics` исчезают все метрики семейства `vllm:*`. Сам эндпоинт `/metrics` остается смонтированным и продолжает отдавать HTTP-метрики инструментатора — поэтому «метрики отдаются» и «метрики движка есть» здесь не одно и то же.

## Оригинальная справка

```text
Disable logging statistics.
```

## Паспорт аргумента

- Флаги: `--disable-log-stats`
- Группа argparse: без группы (объявлен напрямую в `EngineArgs.add_cli_args`)
- Тип значения: bool, `action="store_true"` — только включение, парного `--no-disable-log-stats` нет
- Допустимые значения: флаг присутствует или отсутствует
- Значение по умолчанию: `False`, то есть статистика включена
- Эффективное значение: не переопределяется, но при `--api-server-count > 1` консольный логгер отключается автоматически и без этого флага
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: создание `AsyncLLM` и построение состояния приложения в `api_server.py`

## Что меняет в движке

1. `AsyncLLM.__init__` получает `log_stats = not disable_log_stats`. При `False` пропускается создание `StatLoggerManager`, то есть не появляются ни консольный `LoggingStatLogger`, ни `PrometheusStatLogger`, ни `log_engine_initialized()`.
2. Тот же флаг уходит в `EngineCoreClient.make_async_mp_client(log_stats=...)` и в `OutputProcessor(log_stats=...)`: `IterationStats` перестают собираться, а не просто не печататься.
3. `state.log_stats = not args.disable_log_stats` управляет фоновой задачей в `lifespan` (`vllm/entrypoints/serve/utils/server_utils.py`): при включенной статистике каждые `VLLM_LOG_STATS_INTERVAL` секунд (по умолчанию 10) вызывается `engine_client.do_log_stats()`; при выключенной задача не создается вовсе.
4. В headless-режиме и в multi-API-server режиме то же значение передается в `CoreEngineProcManager`/`launch_core_engines` как `log_stats=not engine_args.disable_log_stats`.

Отдельно: консольная строка печатается через `logger.info` только когда движок не простаивает; на простое тот же вывод уходит в `logger.debug`, чтобы не шуметь. Так что отсутствие строк на холостом сервере — это не действие флага.

## Значения и формат

- Флаг без значения. `--disable-log-stats=true` не поддерживается, парной `--no-` формы нет.
- Из YAML через `--config` включается ключом `disable-log-stats: true`; значение `false` молча отбрасывается, поскольку `--no-disable-log-stats` не зарегистрирован.
- Отменить флаг, заданный в файле конфигурации, из командной строки нельзя — только убрать его из файла.

## Когда использовать

- Практически никогда на управляемом сервере. Периодическая строка со статистикой — основной способ увидеть заполнение KV-cache, число ожидающих запросов и вытеснения, а `vllm:*` в `/metrics` — единственный машинно-читаемый источник тех же величин.
- Разумные сценарии ограничены микробенчмарками, где важен каждый процент CPU фронтенда, и офлайн-использованием (`LLM(...)` по умолчанию сам выставляет `disable_log_stats=True`).
- Не используйте, чтобы «уменьшить объем логов»: строки статистики выводятся раз в `VLLM_LOG_STATS_INTERVAL` секунд, и их вклад в объем логов ничтожен по сравнению с `--enable-log-requests`.
- Не используйте вместе с `--enable-per-request-metrics`: комбинация отвергается при разборе аргументов.

## Влияние на производительность и память

- **VRAM.** Не влияет.
- **CPU и RAM.** Экономия символическая: агрегация `IterationStats` и обновление счетчиков Prometheus стоят доли процента. Ощутимой выгоды по throughput ждать не стоит.
- **Наблюдаемость.** Основная цена. Пропадают: скорость prefill и decode, `Running`/`Waiting`, `GPU KV cache usage`, `Prefix cache hit rate`, число вытеснений, статистика спекулятивного декодирования и KV-connector'а — как в логе, так и в `/metrics`.
- **Диагностика проблем с емкостью.** Без этих величин невозможно отличить «мало KV-cache» от «мало слотов планировщика», то есть решения по `--gpu-memory-utilization` и `--max-num-seqs` приходится принимать вслепую.

## Взаимодействие с другими аргументами

- `--enable-log-requests`: независимая подсистема — логирование отдельных запросов, а не агрегатов. Флаги не связаны и не заменяют друг друга.
- `--aggregate-engine-logging`: выбирает форму консольного логгера при data parallelism; при выключенной статистике не действует, потому что логгера нет.
- `--api-server-count`: при значении больше 1 консольный логгер отключается автоматически (`AsyncLLM created with api_server_count more than 1; disabling stats logging to avoid incomplete stats.`), а Prometheus продолжает работать в multiprocess-режиме. То есть в этой конфигурации `--disable-log-stats` уже почти ничего не добавляет, кроме потери `vllm:*`.
- `--enable-per-request-metrics`: взаимоисключающий. Проверка `validate_parsed_serve_args` падает с `Error: --enable-per-request-metrics requires engine statistics logging; remove --disable-log-stats to enable per-request metrics.`
- `--enable-server-load-tracking`: отдельный счетчик нагрузки на уровне HTTP; этим флагом не выключается.

## Типовые проблемы и диагностика

- **Симптом:** `Error: --enable-per-request-metrics requires engine statistics logging; remove --disable-log-stats to enable per-request metrics.` **Лечение:** убрать один из двух флагов.
- **Симптом:** `/metrics` отвечает, но метрик `vllm:*` в выводе нет. **Причина:** статистика выключена — эндпоинт монтируется всегда, а метрики движка регистрирует только `PrometheusStatLogger`. **Лечение:** убрать флаг.
- **Симптом:** периодических строк со статистикой нет, хотя флаг не задан. **Причины по убыванию вероятности:** сервер простаивает (вывод уходит на уровень DEBUG); задан `--api-server-count > 1`; уровень логирования выше INFO (`VLLM_LOGGING_LEVEL`). **Проверка:** предупреждение `AsyncLLM created with api_server_count more than 1; ...` в логе старта.
- **Симптом:** строки появляются слишком редко или слишком часто. **Причина:** интервал задается не аргументом, а переменной `VLLM_LOG_STATS_INTERVAL` (по умолчанию 10 секунд; неположительное значение возвращается к 10).
- **Подтверждение принятого значения:** наличие или отсутствие строк с префиксом `Engine 000: ` и присутствие метрик `vllm:` в выводе `/metrics`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --disable-log-stats --max-num-seqs 4
```

```bash
vllm serve /models/Qwen3-4B --disable-log-stats --enable-log-requests --max-log-len 200
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `vllm/vllm/entrypoints/serve/instrumentator/metrics.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/engine/async_llm.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/vllm/envs.py`
