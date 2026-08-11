---
schema: 1
engine: sglang
primaryName: "--bucket-time-to-first-token"
title: "--bucket-time-to-first-token"
summary: Заменяет границы гистограммы `sglang:time_to_first_token_seconds` своим списком секунд. Единственный способ получить осмысленные перцентили TTFT, если ваш реальный диапазон не совпадает с зашитым по умолчанию.
group: observability
related:
  - --bucket-inter-token-latency
  - --bucket-e2e-request-latency
  - --enable-metrics
  - --prompt-tokens-buckets
  - --generation-tokens-buckets
  - --extra-metric-labels
  - --chunked-prefill-size
  - --max-running-requests
---

# --bucket-time-to-first-token

## Кратко

Три аргумента `--bucket-time-to-first-token`, `--bucket-inter-token-latency` и `--bucket-e2e-request-latency` — это один и тот же механизм: список границ (в секундах), который передается в конструктор соответствующей Prometheus-гистограммы вместо зашитого набора по умолчанию. Этот документ описывает механизм целиком; два соседних уточняют только свою гистограмму. Границы фиксируются в момент создания `TokenizerMetricsCollector`, то есть при старте сервера, и без `--enable-metrics` не применяются вообще: коллектор просто не создается.

## Оригинальная справка

```text
The buckets of time to first token, specified as a list of floats.
```

## Паспорт аргумента

- Флаги: `--bucket-time-to-first-token`
- Группа: `observability`
- Тип значения: список float (`Optional[List[float]]`); argparse получает `nargs="+"`, `type=float` — значения пишутся через пробел
- Допустимые значения: `choices` нет. Список должен быть строго возрастающим — проверку выполняет сам `prometheus_client` в конструкторе `Histogram`, он же дописывает верхнюю границу `+Inf`
- Значение по умолчанию: `null`. Реальные границы по умолчанию зашиты в `TokenizerMetricsCollector.__init__`: `0.1, 0.2, 0.4, 0.6, 0.8, 1, 2, 4, 6, 8, 10, 20, 40, 60, 80, 100, 200, 400`
- Эффективное значение: `__post_init__` его не трогает; подстановка дефолта происходит позже, уже в конструкторе коллектора (`if bucket_time_to_first_token is None: …`)
- Где объявлен: `ServerArgs.bucket_time_to_first_token`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `TokenizerManager` → конструктор `TokenizerMetricsCollector` (создание гистограммы)

## Что меняет в движке

Значение проходит по цепочке `ServerArgs` → `TokenizerManager.init_metric_collector_watchdog` → `TokenizerMetricsCollector(bucket_time_to_first_token=…)` → `prometheus_client.Histogram(name="sglang:time_to_first_token_seconds", labelnames=[*labels, "is_streaming"], buckets=…)`.

Наблюдение делается в `TokenizerManager.collect_metrics` на **первом** выходном чанке запроса:

```python
if not state.ttft_observed and self.disaggregation_mode != DisaggregationMode.PREFILL:
    state.ttft_observed = True
    self.metrics_collector.observe_time_to_first_token(
        labels, state.time_stats.get_first_token_latency(), stream=getattr(state.obj, "stream", False)
    )
```

Отсчет ведется от момента создания запроса в tokenizer-процессе, то есть **включает** ожидание в очереди scheduler'а, а не только prefill. Метка `is_streaming` разделяет потоковые и непотоковые запросы: у непотоковых TTFT все равно измеряется, потому что tokenizer-процесс получает выход от детокенайзера инкрементально независимо от того, стримит ли клиент.

Три гистограммы этой группы (`time_to_first_token_seconds`, `inter_token_latency_seconds`, `e2e_request_latency_seconds`) создаются рядом, в одном конструкторе, и подчиняются одному правилу: `None` — значит зашитый список.

Списки в примере вывода из `sglang/docs/docs/references/production_metrics.mdx` (там видны `le="0.001"`, `le="0.02"`, …) сняты с другой конфигурации и с дефолтами в коде не совпадают; авторитет — код.

## Значения и формат

- Пробел как разделитель, не запятая: `--bucket-time-to-first-token 0.05 0.1 0.25 0.5 1 2 5 10`. Запятая приведет к `invalid float value: '0.05,0.1'`.
- Границы включающие (`le`), как принято в Prometheus: наблюдение попадает в первый bucket, у которого `значение <= граница`.
- `+Inf` добавлять не нужно и не следует — `prometheus_client` дописывает его сам.
- Минимум две границы; список должен возрастать. Нарушение обоих условий валит старт в момент создания коллектора, то есть в tokenizer-процессе, до готовности HTTP.
- Значения — секунды, дробные. Отрицательные argparse примет, но смысла в них нет.
- Ни `0`, ни `-1` специального смысла не имеют. «Отключить гистограмму» этим аргументом нельзя — только не включать `--enable-metrics`.
- Изменить границы у работающего сервера нельзя: гистограмма регистрируется в реестре один раз.

## Когда использовать

- Когда весь ваш трафик укладывается в первый-второй bucket и `histogram_quantile` даёт бесполезное «p95 между 0.1 и 0.2». На коротких промптах и малом `--chunked-prefill-size` дефолтная сетка начинается слишком грубо — имеет смысл добавить 0.02/0.05.
- Когда TTFT наоборот регулярно упирается в верхнюю границу: длинный контекст, включенная очередь при `--max-running-requests`, CPU-оффлоад экспертов. Тогда добавляйте 600/1200, иначе весь хвост схлопнется в `+Inf` и перцентиль станет неопределенным.
- Когда SLO задан числом: границу SLO надо явно внести в список, иначе доля «уложились в X» будет считаться интерполяцией между чужими границами.
- Не трогать, если дашборд использует только `_sum`/`_count` (средний TTFT) — на среднее границы не влияют.
- Не делать список из полусотни границ ради «точности»: число серий гистограммы равно числу границ, умноженному на кардинальность меток, и растет линейно.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: каждая граница — отдельная серия в `/metrics` и отдельная ячейка в mmap-файле `PROMETHEUS_MULTIPROC_DIR`. Умножается на кардинальность меток (`model_name`, `engine_type`, `is_streaming` и всё, что добавлено `--extra-metric-labels` и `--tokenizer-metrics-allowed-custom-labels`).
- Latency: одно наблюдение на запрос, в tokenizer-процессе. Стоимость — линейный поиск по списку границ внутри `prometheus_client`; на десятке-двух границ это наносекунды.
- Throughput: не влияет.
- Время старта: не влияет.

## Взаимодействие с другими аргументами

- `--enable-metrics`: обязателен. Без него `TokenizerMetricsCollector` не создается и значение никуда не попадает — аргумент полностью инертен.
- `--bucket-inter-token-latency` / `--bucket-e2e-request-latency`: соседние ручки того же механизма, каждая для своей гистограммы. Задаются независимо; незаданная остается на своем зашитом списке.
- `--prompt-tokens-buckets` / `--generation-tokens-buckets`: тот же принцип для гистограмм числа токенов, но синтаксис другой — там правила (`default`, `tse …`, `custom …`), а не голый список чисел.
- `--extra-metric-labels`, `--tokenizer-metrics-allowed-custom-labels`: перемножаются с числом границ по кардинальности.
- `--chunked-prefill-size`, `--max-running-requests`: определяют, в каком диапазоне реально живет TTFT, — от них и надо отталкиваться при выборе границ.
- `--disaggregation-mode prefill`: в этом режиме TTFT из tokenizer-процесса не наблюдается вовсе (условие `disaggregation_mode != PREFILL` в `collect_metrics`).

## Типовые проблемы и диагностика

- `invalid float value: '0.1,0.2'` при старте — список задан через запятую. Нужны пробелы.
- `ValueError: Buckets not in sorted order` в tokenizer-процессе, HTTP не поднимается — список не возрастает.
- Аргумент задан, а в `/metrics` границы дефолтные — почти всегда просто нет `--enable-metrics`. Проверьте `bucket_time_to_first_token=[…], enable_metrics=True` в дампе `server_args=` при старте.
- Все наблюдения падают в `+Inf`, перцентиль не считается — верхняя граница ниже реального TTFT. Смотрите `_sum / _count`, чтобы понять фактический масштаб, и раздвигайте список.
- TTFT в гистограмме заметно больше времени prefill из логов — это ожидаемо: измеряется полное время от приема запроса, включая ожидание в очереди.
- **В arriero:** менеджер ведет свой per-request учет (`docs/API_PROXY_FOUNDATION.md`) с полями `durationMs`, `genMs`, `promptTokens`, `completionTokens`, но **не** записывает TTFT и не строит гистограмм — распределение времени до первого токена доступно только через `/metrics` движка.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-metrics --bucket-time-to-first-token 0.05 0.1 0.25 0.5 1 2 5 10 30 60
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-metrics --bucket-time-to-first-token 0.5 1 2 5 10 30 60 120 300 600 --bucket-e2e-request-latency 1 5 10 30 60 120 300 600 1800
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/docs/docs/references/production_metrics.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`
