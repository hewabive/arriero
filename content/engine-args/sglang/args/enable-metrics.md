---
schema: 1
engine: sglang
primaryName: "--enable-metrics"
title: "--enable-metrics"
summary: Главный выключатель Prometheus-телеметрии: монтирует `/metrics` на тот же порт, что и API, и включает сбор в tokenizer- и scheduler-процессах. Без него все остальные аргументы метрик инертны.
group: observability
related:
  - --enable-metrics-for-all-schedulers
  - --enable-mfu-metrics
  - --extra-metric-labels
  - --bucket-time-to-first-token
  - --bucket-inter-token-latency
  - --bucket-e2e-request-latency
  - --prompt-tokens-buckets
  - --generation-tokens-buckets
  - --tokenizer-metrics-allowed-custom-labels
  - --decode-log-interval
  - --export-metrics-to-file
  - --uvicorn-access-log-exclude-prefixes
  - --port
---

# --enable-metrics

## Кратко

Флаг делает три вещи: до старта подпроцессов выставляет `PROMETHEUS_MULTIPROC_DIR` (prometheus_client работает в multiprocess-режиме, потому что метрики пишут несколько процессов сразу), монтирует в FastAPI маршрут `GET /metrics` на **том же** хосте и порте, что и `/v1/*`, и создает коллекторы в tokenizer-процессе и в scheduler-процессах. Всё, что относится к метрикам в этой группе (`--enable-mfu-metrics`, `--bucket-*`, `--extra-metric-labels`, `--tokenizer-metrics-*`, `--enable-metrics-for-all-schedulers`), без него не создает ни одной серии. Эндпоинт ничем не защищен — это первое, о чем надо помнить на сервере, доступном не только с localhost.

## Оригинальная справка

```text
Enable log prometheus metrics.
```

## Паспорт аргумента

- Флаги: `--enable-metrics`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — значения не принимает
- Допустимые значения: `choices` нет; флаг либо задан, либо нет. Парной формы `--no-enable-metrics` не существует
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным, ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.enable_metrics`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `_set_envs_and_config` до запуска подпроцессов (переменная окружения) → конструктор `TokenizerManager` → конструктор `Scheduler` → lifespan FastAPI (монтирование `/metrics`)

## Что меняет в движке

### Порядок инициализации

1. `_set_envs_and_config` (`sglang/python/sglang/srt/entrypoints/engine.py`) вызывает `set_prometheus_multiproc_dir()`: если `PROMETHEUS_MULTIPROC_DIR` уже задан снаружи, внутри него создается временный подкаталог, иначе создается `tempfile.TemporaryDirectory()` и переменная выставляется на него. Делается это **до** форка подпроцессов, потому что prometheus_client читает переменную в момент импорта — отсюда во всем коде метрик импорты `from prometheus_client import ...` спрятаны внутрь функций.
2. `TokenizerManager.init_metric_collector_watchdog` создает `TokenizerMetricsCollector` с базовыми метками `model_name` (это `--served-model-name`) и `engine_type`.
3. В каждом scheduler-процессе `SchedulerMetricsCollectorContext.init_new` создает `SchedulerMetricsCollector` с метками `model_name`, `engine_type`, `tp_rank`, `pp_rank`, `moe_ep_rank` (плюс `dp_rank`, если DP включен).
4. В lifespan HTTP-сервера `add_prometheus_middleware(app)` собирает `CollectorRegistry` с `multiprocess.MultiProcessCollector` и монтирует его как `/metrics`; там же `enable_func_timer()` включает гистограмму `sglang:func_latency_seconds` для декорированных обработчиков. Отдельно вешается `add_prometheus_track_response_middleware(app)` — счетчики `sglang:http_requests_total`, `sglang:http_responses_total` и gauge `sglang:http_requests_active`.

### Что появляется в `/metrics`

Из tokenizer-процесса (`TokenizerMetricsCollector`) — всё, что относится к запросу целиком: `sglang:prompt_tokens_total`, `sglang:generation_tokens_total`, `sglang:time_to_first_token_seconds`, `sglang:inter_token_latency_seconds`, `sglang:e2e_request_latency_seconds`, `sglang:num_requests_total`, `sglang:num_so_requests_total`, `sglang:num_aborted_requests_total`.

Из scheduler-процесса (`SchedulerMetricsCollector`) — состояние очереди и пулов: `sglang:num_running_reqs`, `sglang:num_queue_reqs`, `sglang:token_usage`, `sglang:kv_available_tokens`, `sglang:kv_used_tokens`, `sglang:cache_hit_rate`, `sglang:gen_throughput`, `sglang:num_retracted_reqs`, `sglang:is_cuda_graph`, `sglang:new_token_ratio`, `sglang:queue_time_seconds`, `sglang:per_stage_req_latency_seconds`, метрики grammar-бэкенда, при HiCache — `sglang:hicache_host_used_tokens`. Значения пулов и очереди обновляются не на каждой итерации, а раз в `--decode-log-interval` decode-шагов.

Флаг также включает метрики radix-кеша и storage-слоя: `enable_metrics` пробрасывается в `CacheInitParams` и дальше в `RadixCache`/`HiRadixCache`/`SWARadixCache`.

Пример живого вывода со списком метрик — `sglang/docs/docs/references/production_metrics.mdx`, готовый дашборд — `examples/monitoring/grafana/dashboards/json/sglang-dashboard.json` в том же checkout'е.

## Значения и формат

- Флаг без аргумента. `--enable-metrics true` argparse не примет: `true` будет разобран как позиционный аргумент и старт упадет.
- Выключить метрики после старта нельзя: коллекторы и маршрут создаются один раз при инициализации.
- Отдельного порта для метрик в HTTP-режиме нет — `/metrics` живет на `--port`. Отдельный порт (`--smg-http-sidecar-port`) существует только в legacy SMG gRPC-режиме.
- Каталог `PROMETHEUS_MULTIPROC_DIR` временный и удаляется при штатном завершении процесса; при `SIGKILL` он останется в системном temp.

## Когда использовать

- Когда нужна внутренняя картина движка, которой arriero не видит: заполнение KV-пула (`token_usage`), длина очереди, доля попаданий в radix-кеш, количество retract'ов. Именно эти четыре величины объясняют «почему стало медленно» на KTransformers-профиле, и никаким внешним измерением их не получить.
- Когда собираете Grafana поверх нескольких инстансов: без `--enable-metrics` придется довольствоваться `/api/proxy/stats` менеджера, а он не знает про пулы.
- Не включать, если сервер слушает не только на loopback и порт доступен извне: `/metrics` отдается **без аутентификации** и раскрывает имя модели, объем трафика и внутренние тайминги. Ограничивайте доступ на уровне сети или закрывайте порт, оставляя наружу только прокси arriero.
- Не включать «на всякий случай» вместе с `--extra-metric-labels`, где значение метки берется из чего-то с высокой кардинальностью — это единственный способ реально навредить производительностью в этой группе.

## Влияние на производительность и память

- VRAM: не затрагивается.
- RAM хоста: каталог `PROMETHEUS_MULTIPROC_DIR` содержит mmap-файлы по одному на процесс и на тип метрики; размер растет с числом уникальных комбинаций меток, а не с числом запросов. При базовых метках это единицы мегабайт.
- Время старта: не меняет заметно.
- Latency: в tokenizer-процессе на каждый чанк потокового ответа вызывается `collect_metrics` — одно наблюдение TTFT на первый чанк и по одному наблюдению inter-token latency на последующие. Для inter-token latency сделан ускоренный путь (`observe_inter_token_latency` инкрементирует ровно один bucket вместо полного `observe`), поэтому накладные расходы порядка микросекунд на чанк.
- Throughput: в scheduler-процессе тяжелая часть отчета выполняется раз в `--decode-log-interval` итераций; на итерациях между отчетами считаются только `realtime_tokens`.
- Сбор `/metrics` со стороны Prometheus в multiprocess-режиме читает и агрегирует все mmap-файлы каталога — при частоте скрейпа 1 с и большом числе TP-рангов с `--enable-metrics-for-all-schedulers` это заметная нагрузка на CPU главного процесса.

## Взаимодействие с другими аргументами

- `--enable-metrics-for-all-schedulers`: расширяет сбор с ранга `attn_tp_rank == 0` на все TP-ранги. Без `--enable-metrics` не делает ничего.
- `--enable-mfu-metrics`: в `SchedulerMetricsReporter` читается **внутри** ветки `if self.enable_metrics`, то есть строго требует этот флаг.
- `--bucket-time-to-first-token` / `--bucket-inter-token-latency` / `--bucket-e2e-request-latency`, `--prompt-tokens-buckets`, `--generation-tokens-buckets`: границы гистограмм, применяются в конструкторе `TokenizerMetricsCollector`, который создается только при `--enable-metrics`.
- `--extra-metric-labels`, `--tokenizer-metrics-custom-labels-header`, `--tokenizer-metrics-allowed-custom-labels`: добавляют метки в те же серии.
- `--decode-log-interval`: задает период, с которым scheduler обновляет gauge'и пулов и очереди. Значение по умолчанию 40 итераций — метрики пулов «дискретны» с этим шагом.
- `--export-metrics-to-file`: **независимый** механизм, работает и без `--enable-metrics`.
- `--enable-forward-pass-metrics`: тоже независимый, публикует данные в ZMQ, а не в Prometheus.
- `--uvicorn-access-log-exclude-prefixes`: если Prometheus скрейпит `/metrics` раз в секунду, каждая такая строка попадает в лог uvicorn. Добавьте `/metrics` в этот список.

## Типовые проблемы и диагностика

- `curl http://127.0.0.1:30000/metrics` возвращает `404` — флаг не задан либо сервер стартовал не через HTTP-точку входа. Проверьте итоговый дамп `server_args=` в логе: там должно быть `enable_metrics=True`.
- `/metrics` отдает пустой или обрезанный вывод, серий scheduler'а нет — почти всегда каталог `PROMETHEUS_MULTIPROC_DIR` был выставлен снаружи в путь, недоступный подпроцессам на запись, либо подпроцесс импортировал `prometheus_client` до установки переменной. В логе на уровне `debug` есть строка `PROMETHEUS_MULTIPROC_DIR: …`.
- Метрики есть, но `token_usage` и `num_running_reqs` «залипают» — они обновляются раз в `--decode-log-interval` decode-итераций и не двигаются, пока идет длинный prefill.
- `ValueError: SGLANG_LOG_SCHEDULER_STATUS_TARGET is set but --enable-metrics is not active` при старте — переменная окружения включена, а флаг нет.
- В Grafana видно только один `tp_rank`, хотя `--tp-size` больше единицы — это штатно: запросные метрики пишет только ранг `attn_tp_rank == 0`. Смотрите `--enable-metrics-for-all-schedulers`.
- **В arriero:** менеджер `/metrics` не опрашивает. Для инстанса `ktransformers` probe — `openai-http` (`apps/api/src/process/engine-probe.ts`): только `GET /health` и `GET /v1/models`. Собственная телеметрия arriero живет на другом уровне — per-request трейсы прокси (`docs/API_PROXY_FOUNDATION.md`: модель, цель, `promptTokens`/`completionTokens`/`genMs`/`durationMs`, 30 дней хранения) и хостовые метрики 1 Гц (`docs/SYSTEM_METRICS.md`: CPU, память, GPU через NVML, диск, сеть). Пересечение — только счетчики токенов и время ответа; заполнение KV-пула, длина очереди scheduler'а и cache hit rate есть **только** в `/metrics` движка. Дублирования, которое стоило бы избегать, здесь нет.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --host 127.0.0.1 --enable-metrics
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-metrics --decode-log-interval 20 --uvicorn-access-log-exclude-prefixes /metrics /health
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/observability/func_timer.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/docs/docs/references/production_metrics.mdx`
- `sglang/docs/docs/advanced_features/observability.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `docs/SYSTEM_METRICS.md`
