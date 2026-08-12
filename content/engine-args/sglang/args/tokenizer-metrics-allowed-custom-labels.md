---
schema: 1
engine: sglang
primaryName: "--tokenizer-metrics-allowed-custom-labels"
title: "--tokenizer-metrics-allowed-custom-labels"
summary: Белый список имен меток Prometheus, которые разрешено брать из клиентского заголовка. Фильтруются только имена — значения приходят от клиента как есть, поэтому каждое разрешенное имя это потенциально неограниченная кардинальность.
group: observability
related:
  - --tokenizer-metrics-custom-labels-header
  - --enable-metrics
  - --extra-metric-labels
  - --prompt-tokens-buckets
  - --generation-tokens-buckets
  - --api-key
  - --enable-priority-scheduling
---

# --tokenizer-metrics-allowed-custom-labels

## Кратко

Список имен меток, которые `OpenAIServingBase.extract_custom_labels` (`sglang/python/sglang/srt/entrypoints/openai/serving_base.py`) готов принять из HTTP-заголовка, заданного аргументом `--tokenizer-metrics-custom-labels-header`. Всё, чего в списке нет, из присланного словаря выбрасывается.

Фильтруются **только имена**. Значения не проверяются, не нормализуются и не ограничиваются по длине — они попадают в метки Prometheus такими, какими их прислал клиент. Каждое новое сочетание значений создает новый набор временных рядов, поэтому решение «разрешить метку» это решение «разрешить клиенту создавать серии метрик».

## Оригинальная справка

```text
The custom labels allowed for tokenizer metrics. The labels are specified via a dict in '--tokenizer-metrics-custom-labels-header' field in HTTP requests, e.g., {'label1': 'value1', 'label2': 'value2'} is allowed if '--tokenizer-metrics-allowed-custom-labels label1 label2' is set.
```

## Паспорт аргумента

- Флаги: `--tokenizer-metrics-allowed-custom-labels`
- Группа: `observability`
- Тип значения: список строк, `nargs="+"` — имена меток через пробел
- Допустимые значения: `choices` нет. Имена должны быть корректными именами меток Prometheus (`prometheus_client` отвергнет недопустимое имя при создании метрики)
- Значение по умолчанию: `None` — пользовательские метки выключены
- Эффективное значение: совпадает с заданным. `__post_init__` проверяет связку: непустой список при пустом `--tokenizer-metrics-custom-labels-header` дает `ValueError: Please set --tokenizer-metrics-custom-labels-header when setting --tokenizer-metrics-allowed-custom-labels.`
- Где объявлен: `ServerArgs.tokenizer_metrics_allowed_custom_labels`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверка) → инициализация `TokenizerManager` (регистрация имен меток в коллекторе) → HTTP-обработчики `/v1/chat/completions` и `/v1/completions`

## Что меняет в движке

### Регистрация имен

При создании `TokenizerMetricsCollector` (`sglang/python/sglang/srt/managers/tokenizer_manager.py`) каждое разрешенное имя добавляется в базовый набор меток со значением пустой строки:

```python
if self.server_args.tokenizer_metrics_allowed_custom_labels:
    for label in self.server_args.tokenizer_metrics_allowed_custom_labels:
        labels[label] = ""
```

Поэтому метка появляется во **всех** метриках токенизатора: счетчиках токенов и запросов, гистограммах TTFT, inter-token latency, e2e latency, длины промпта и длины генерации. Запросы без заголовка получают пустое значение.

### Заполнение значений

`extract_custom_labels` вызывается ровно из двух мест — `serving_chat.py` и `serving_completions.py`. Значит, пользовательские метки применимы только к `/v1/chat/completions` и `/v1/completions`; запросы на `/generate`, `/v1/embeddings` и прочие маршруты меток не несут.

Дальше значения переносятся в набор меток при сборе статистики (`TokenizerManager.collect_metrics`): `labels.update(custom_labels)`.

## Значения и формат

- Список имен: `--tokenizer-metrics-allowed-custom-labels team tenant`.
- Клиент присылает заголовок с JSON-объектом; ключи, которых нет в списке, молча отбрасываются.
- Пустой список (аргумент не задан) отключает механизм: `extract_custom_labels` выходит по первой проверке.
- Имен стоит держать минимум: каждое имя это дополнительное измерение, а суммарное число рядов равно произведению мощностей всех измерений.
- Ограничить **значения** нечем: ни списка допустимых значений, ни предела длины, ни нормализации в коде нет.

## Когда использовать

- Учет по арендаторам или командам на сервере, где вы контролируете всех клиентов и можете гарантировать конечный набор значений (например, прокси перед SGLang перезаписывает заголовок сам).
- Не используйте на сервере, куда ходят недоверенные клиенты: см. разбор кардинальности и подмены в `tokenizer-metrics-custom-labels-header.md`. Значение приходит от того, кто отправил запрос, и ничем не подтверждается.
- Не используйте, если нужны просто постоянные метки инстанса — для этого есть `--extra-metric-labels`, значения которого задаются на сервере и клиенту недоступны.

## Влияние на производительность и память

- VRAM и скорость генерации не затрагиваются.
- RAM tokenizer-процесса: `prometheus_client` держит по объекту-ребенку на каждый уникальный набор меток и **никогда их не удаляет**. Гистограммы особенно дороги: одна гистограмма с 35 границами это 37 рядов на набор меток, а таких гистограмм в коллекторе несколько.
- Объем ответа `/metrics` растет линейно по числу уникальных наборов; при неконтролируемых значениях страница метрик способна вырасти до мегабайтов и начать таймаутить скрейп.
- Стоимость на запрос — разбор JSON заголовка и обновление словаря; сама по себе незначима.

## Взаимодействие с другими аргументами

- `--tokenizer-metrics-custom-labels-header`: обязателен; без него старт падает с `ValueError`.
- `--enable-metrics`: без него коллектор не создается и метки некуда класть, хотя проверка связки все равно выполняется.
- `--extra-metric-labels`: серверные метки, задаются в JSON на стороне запуска; безопасная альтернатива, когда значения известны заранее.
- `--prompt-tokens-buckets`, `--generation-tokens-buckets`: число границ умножается на число наборов меток.
- `--enable-priority-scheduling`: добавляет еще одно измерение `priority`.
- `--api-key`: единственный встроенный барьер между произвольным клиентом и вашими метками.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Please set --tokenizer-metrics-custom-labels-header when setting --tokenizer-metrics-allowed-custom-labels.` **Причина:** имя заголовка пустое (например, задано `--tokenizer-metrics-custom-labels-header ""`). **Лечение:** задать непустое имя или убрать белый список.
- **Симптом:** метка есть в `/metrics`, но всегда пустая. **Причина №1:** клиент не шлет заголовок. **Причина №2:** имя в заголовке не совпадает со списком (сравнение точное, с учетом регистра). **Причина №3:** запросы идут не на `/v1/chat/completions` и не на `/v1/completions`.
- **Симптом:** `/metrics` разрастается и медленно отвечает. **Причина:** неограниченные значения меток. **Лечение:** убрать метку из белого списка и вернуть ее только после того, как значения будут проставляться доверенным звеном.
- **Симптом:** ошибка `prometheus_client` при старте про недопустимое имя метки. **Причина:** имя не соответствует требованиям Prometheus. **Лечение:** переименовать.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `tokenizer_metrics_allowed_custom_labels=`; фактические метки видны в `curl -s http://127.0.0.1:30000/metrics | head`.

## В arriero

Метрики Prometheus самого движка arriero не собирает и не показывает — учет по источникам запросов ведет прокси менеджера, помечая каждую трассу `sourceId`/`sourceName` по ключу из `config/proxy/sources.json` (`docs/API_PROXY_FOUNDATION.md` § Request sources, arriero). Это и есть штатный ответ на задачу «разделить потребление по командам»: значение метки там определяется ключом источника на сервере, а не заголовком клиента.

Через прокси arriero эта связка не работает намеренно: форвардер вырезает клиентский заголовок с метками — `x-custom-labels` всегда (`apps/api/src/proxy/http.ts`), а переименованное через `--tokenizer-metrics-custom-labels-header` имя — по аргументам управляемого инстанса (`instanceMetricsLabelHeader` в `apps/api/src/proxy/upstream-context.ts`). Причина: значения меток не проверяются движком, и открытый фасад превращал бы их в канал подмены атрибуции и раздувания кардинальности. Preflight KTransformers предупреждает об этом, когда белый список задан. Метки дойдут до движка только от клиентов, обращающихся к порту инстанса напрямую, минуя прокси.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics --tokenizer-metrics-allowed-custom-labels team tenant --tokenizer-metrics-custom-labels-header x-custom-labels
```

```bash
curl -sS http://127.0.0.1:30000/v1/chat/completions -H 'Content-Type: application/json' -H 'x-custom-labels: {"team":"platform","tenant":"acme"}' -d '{"model":"Qwen3-30B-A3B","messages":[{"role":"user","content":"ping"}]}'
```

## Источники

- `sglang/python/sglang/srt/entrypoints/openai/serving_base.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `apps/api/src/proxy/http.ts`
