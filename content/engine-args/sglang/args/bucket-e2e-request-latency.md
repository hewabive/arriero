---
schema: 1
engine: sglang
primaryName: "--bucket-e2e-request-latency"
title: "--bucket-e2e-request-latency"
summary: Задает границы гистограммы `sglang:e2e_request_latency_seconds` — полного времени запроса от приема до завершения. Единственная из трех гистограмм, чей дефолтный список доходит до 2400 секунд.
group: observability
related:
  - --bucket-time-to-first-token
  - --bucket-inter-token-latency
  - --enable-metrics
  - --max-running-requests
  - --context-length
  - --schedule-policy
  - --extra-metric-labels
---

# --bucket-e2e-request-latency

## Кратко

Один из трех аргументов-границ Prometheus-гистограмм; общий механизм описан в `--bucket-time-to-first-token`. Здесь заменяется набор границ метрики `sglang:e2e_request_latency_seconds` — времени от создания запроса в tokenizer-процессе до его завершения, то есть очередь плюс prefill плюс вся генерация. Дефолтный список — самый широкий из трех: он повторяет сетку TTFT и продолжает ее до 600, 1200, 1800 и 2400 секунд, потому что длинная генерация с большим `max_new_tokens` легко уходит за десять минут.

## Оригинальная справка

```text
The buckets of end-to-end request latency, specified as a list of floats.
```

## Паспорт аргумента

- Флаги: `--bucket-e2e-request-latency`
- Группа: `observability`
- Тип значения: список float (`Optional[List[float]]`); argparse получает `nargs="+"`, `type=float` — значения через пробел
- Допустимые значения: `choices` нет; список должен строго возрастать, `+Inf` дописывает `prometheus_client`
- Значение по умолчанию: `null`. Реальный список по умолчанию зашит в `TokenizerMetricsCollector.__init__`: `0.1, 0.2, 0.4, 0.6, 0.8, 1, 2, 4, 6, 8, 10, 20, 40, 60, 80, 100, 200, 400, 600, 1200, 1800, 2400`
- Эффективное значение: `__post_init__` его не меняет; `None` разворачивается в зашитый список в конструкторе коллектора
- Где объявлен: `ServerArgs.bucket_e2e_request_latency`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `TokenizerManager` → конструктор `TokenizerMetricsCollector`

## Что меняет в движке

Список уходит в `prometheus_client.Histogram(name="sglang:e2e_request_latency_seconds", labelnames=[*labels, "is_streaming"], buckets=…)`. Метка `is_streaming` есть, как и у TTFT.

Наблюдение делается ровно один раз на запрос, в `TokenizerManager.collect_metrics` при `state.finished`, внутри `observe_one_finished_request(...)` — там же увеличиваются счетчики `sglang:prompt_tokens_total`, `sglang:generation_tokens_total`, `sglang:num_requests_total` и обновляется `sglang:cache_hit_rate`. Значение берется как `finished_time - created_time`, то есть:

- **включает** ожидание в очереди scheduler'а и время повторных попыток prefill после retract;
- **не включает** время, потраченное HTTP-слоем на отдачу последних байтов клиенту.

Счетчик `sglang:num_aborted_requests_total` ведется отдельным путем — он инкрементируется в момент выдачи abort'а (`TokenizerManager.abort_request`), а не при завершении запроса, и с этой гистограммой напрямую не связан: попадет ли прерванный запрос еще и сюда, зависит от того, дошел ли он до состояния `finished`.

## Значения и формат

- Разделитель — пробел: `--bucket-e2e-request-latency 1 5 10 30 60 120 300 600 1800`.
- Секунды, дробные допустимы.
- Границы включающие (`le`), список должен возрастать, минимум две границы; `+Inf` дописывается автоматически.
- Специальных значений (`0`, `-1`, `auto`) нет; отключить гистограмму аргументом нельзя.
- Границы фиксируются при старте, у работающего сервера не меняются.

## Когда использовать

- Когда важен SLO на полное время ответа: пороговое значение надо внести в список явно, иначе `histogram_quantile` будет интерполировать между чужими границами и доля «уложились» окажется выдуманной.
- Когда трафик однороден и короток (чат с `max_new_tokens` в пару сотен): верхние восемь границ дефолтного списка (от 100 с и выше) не наберут ни одного наблюдения, а нижняя часть слишком редкая. Сетка вида `0.5 1 2 3 5 8 13 21 34 55` даст читаемые перцентили.
- Когда очередь — главный источник задержки: e2e и TTFT расходятся ровно на время генерации, и сравнение двух гистограмм с согласованными границами показывает, где именно теряется время.
- Не трогать, если нужен только средний e2e — на `_sum / _count` границы не влияют.
- Не задавать сетку, чей верхний предел ниже реального максимума генерации: весь хвост уедет в `+Inf`, и p99 станет неопределенным именно тогда, когда он нужен.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: число серий равно числу границ, умноженному на кардинальность меток (включая `is_streaming`).
- Latency: одно наблюдение на завершенный запрос в tokenizer-процессе — стоимость незаметна.
- Throughput: не влияет.
- Время старта: не влияет.

## Взаимодействие с другими аргументами

- `--enable-metrics`: обязателен; без него коллектор не создается и аргумент инертен.
- `--bucket-time-to-first-token` / `--bucket-inter-token-latency`: тот же механизм для своих гистограмм. Осмысленно держать нижние границы TTFT и e2e согласованными, чтобы разность читалась.
- `--max-running-requests` и `--schedule-policy`: определяют, сколько запрос проводит в очереди, а очередь входит в e2e целиком.
- `--context-length` и `max_new_tokens` в запросе: задают верхний предел генерации, а значит и верхнюю границу, которую имеет смысл поставить.
- `--chunked-prefill-size`: влияет на длительность prefill и, через нее, на нижний край распределения.
- `--extra-metric-labels`, `--tokenizer-metrics-allowed-custom-labels`: перемножаются с числом границ по кардинальности.

## Типовые проблемы и диагностика

- `invalid float value: '1,5,10'` при старте — список задан через запятую.
- `ValueError: Buckets not in sorted order` — список не возрастает.
- Гистограмма есть, границы дефолтные — нет `--enable-metrics`. Проверьте `bucket_e2e_request_latency=[…]` и `enable_metrics=True` в дампе `server_args=`.
- Число наблюдений не сходится с числом запросов в логе — в гистограмму идут только запросы, дошедшие до `finished`. Для прерванных смотрите `sglang:num_aborted_requests_total`, он инкрементируется другим путем.
- p99 «уперся» в верхнюю границу — расширяйте список либо смотрите `_sum / _count`, чтобы оценить реальный масштаб.
- **В arriero:** полное время запроса менеджер измеряет сам — поле `durationMs` в трейсе прокси (`docs/API_PROXY_FOUNDATION.md`, история 30 дней, фильтры и фасеты на `#/proxy/traces`). Это единственная из трех гистограмм, чей аналог в arriero есть. Разница в границе измерения: arriero считает время своего запроса к инстансу, включая ожидание lease в domain-coordinator, а SGLang — время внутри движка. Расхождение между ними и есть цена очереди самого менеджера.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-metrics --bucket-e2e-request-latency 0.5 1 2 3 5 8 13 21 34 55 90
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-metrics --bucket-time-to-first-token 0.5 1 2 5 10 30 --bucket-e2e-request-latency 0.5 1 2 5 10 30 60 300 900
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/observability/req_time_stats.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/docs/docs/references/production_metrics.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`
