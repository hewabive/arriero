---
schema: 1
engine: sglang
primaryName: "--tokenizer-metrics-custom-labels-header"
title: "--tokenizer-metrics-custom-labels-header"
summary: Имя HTTP-заголовка, из которого берутся значения пользовательских меток Prometheus. Значения полностью подконтрольны клиенту: их нельзя ни проверить, ни ограничить, поэтому это одновременно канал подмены атрибуции и канал раздувания кардинальности метрик.
group: observability
related:
  - --tokenizer-metrics-allowed-custom-labels
  - --enable-metrics
  - --extra-metric-labels
  - --api-key
  - --prompt-tokens-buckets
  - --generation-tokens-buckets
---

# --tokenizer-metrics-custom-labels-header

## Кратко

Задает имя заголовка, содержимое которого `OpenAIServingBase.extract_custom_labels` разбирает как JSON-объект и превращает в метки Prometheus. Сам по себе аргумент безобиден: пока не задан `--tokenizer-metrics-allowed-custom-labels`, заголовок не читается вообще.

Опасен он в паре с белым списком, и по двум независимым причинам:

- **Подмена атрибуции.** Значения приходят от клиента и ничем не подтверждаются. Клиент, которому положено считаться `{"team":"support"}`, может прислать `{"team":"platform"}` — и все его токены, задержки и запросы будут учтены на чужой команде. Механизма связать метку с аутентификацией нет.
- **Кардинальность.** Значение не проверяется, не ограничивается по длине и не нормализуется. Каждое уникальное сочетание значений порождает новый набор рядов в `prometheus_client`, который эти ряды никогда не освобождает. Клиент, подставляющий в метку случайную строку на каждый запрос, за час превращает `/metrics` в неотдаваемую страницу и раздувает память tokenizer-процесса.

## Оригинальная справка

```text
Specify the HTTP header for passing custom labels for tokenizer metrics.
```

## Паспорт аргумента

- Флаги: `--tokenizer-metrics-custom-labels-header`
- Группа: `observability`
- Тип значения: str — имя HTTP-заголовка
- Допустимые значения: `choices` нет; любая строка. Поиск заголовка идет через `raw_request.headers.get(...)`, то есть регистр имени значения не имеет (заголовки HTTP регистронезависимы)
- Значение по умолчанию: `x-custom-labels`
- Эффективное значение: совпадает с заданным. Пустая строка вместе с непустым `--tokenizer-metrics-allowed-custom-labels` дает `ValueError` в `__post_init__`; пустая строка без белого списка допустима и просто ничего не значит
- Где объявлен: `ServerArgs.tokenizer_metrics_custom_labels_header`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: HTTP-обработчики `/v1/chat/completions` и `/v1/completions`, на каждый запрос

## Что меняет в движке

```python
def extract_custom_labels(self, raw_request):
    if (
        not self.allowed_custom_labels
        or not self.tokenizer_manager.server_args.tokenizer_metrics_custom_labels_header
    ):
        return None
    ...
    raw_labels = orjson.loads(raw_request.headers.get(header)) if ... else None
    ...
    if isinstance(raw_labels, dict):
        custom_labels = {
            label: value
            for label, value in raw_labels.items()
            if label in self.allowed_custom_labels
        }
    return custom_labels
```

Что из этого следует буквально:

- заголовок читается только если белый список непуст — то есть по умолчанию механизм выключен;
- содержимое должно быть JSON-объектом; валидный JSON другого типа (число, строка, массив) молча дает `None`;
- фильтруются ключи, значения не трогаются: пустая строка, строка на 10 килобайт, число, вложенный объект — всё попадет в метку в том виде, в каком его отдаст `prometheus_client` при приведении к строке;
- разбор ошибки JSON перехватывается и логируется через `logger.exception(f"Error in request: {e}")`, то есть **с полной трассировкой стека**, а запрос обрабатывается дальше без меток.

Дальше значения попадают в набор меток в `TokenizerManager.collect_metrics` (`labels.update(custom_labels)`) и применяются ко всем метрикам токенизатора: счетчикам токенов и запросов, гистограммам TTFT, inter-token latency, e2e latency, длины промпта и длины генерации.

## Значения и формат

- Имя заголовка: `--tokenizer-metrics-custom-labels-header x-custom-labels` (значение по умолчанию).
- Содержимое заголовка со стороны клиента: `x-custom-labels: {"team":"platform","tenant":"acme"}`.
- HTTP-заголовки не переносят переводы строк, поэтому JSON должен быть однострочным; практический предел длины задает сервер (uvicorn ограничивает суммарный размер заголовков).
- Имя стоит менять только если `x-custom-labels` уже занят чем-то в вашей инфраструктуре — семантики в самом имени нет.
- Пустое значение (`--tokenizer-metrics-custom-labels-header ""`) вместе с белым списком — ошибка старта.

## Когда использовать

- Разделение учета между арендаторами **при доверенном звене перед SGLang**, которое само проставляет заголовок и вычищает клиентский. Только в такой схеме метка означает то, что вы думаете.
- Не открывайте эту связку наружу. Минимальный набор мер, если открыли: `--api-key`, ограниченный белый список имен, отдельный мониторинг числа рядов в `/metrics`.
- Не используйте для постоянных меток инстанса — для них есть `--extra-metric-labels`, где значения задаются при запуске и клиенту недоступны.

## Влияние на производительность и память

- На VRAM и скорость генерации не влияет.
- На запрос — один `orjson.loads` заголовка и фильтрация словаря; незначимо.
- Основная стоимость отложенная и накопительная: память `prometheus_client` под ряды, которые не освобождаются, и линейный рост тела ответа `/metrics`. Дороже всего гистограммы: одна гистограмма с 35 границами дает 37 рядов на каждый набор меток.
- Ошибка разбора заголовка стоит записи трассировки в лог — при массовой отправке битого заголовка это еще и поток записи на диск.

## Взаимодействие с другими аргументами

- `--tokenizer-metrics-allowed-custom-labels`: включает механизм; без него заголовок не читается.
- `--enable-metrics`: без него метрик нет, и метки некуда прикладывать.
- `--extra-metric-labels`: серверные метки; их значения клиент подменить не может.
- `--prompt-tokens-buckets`, `--generation-tokens-buckets`: число границ гистограмм умножается на число уникальных наборов меток.
- `--api-key`: единственный встроенный барьер, ограничивающий, кто вообще может прислать заголовок.

## Типовые проблемы и диагностика

- **Симптом:** в логе периодически `Error in request: …` с трассировкой, запросы при этом обрабатываются. **Причина:** клиент шлет в заголовке не JSON. **Лечение:** починить клиента; на стороне сервера этого не отключить.
- **Симптом:** заголовок отправляется, метки пустые. **Причина №1:** имени нет в белом списке. **Причина №2:** в заголовке JSON не-объект. **Причина №3:** запрос идет не на `/v1/chat/completions` и не на `/v1/completions` — из других обработчиков `extract_custom_labels` не вызывается.
- **Симптом:** `/metrics` отдается секундами и весит мегабайты. **Причина:** взрыв кардинальности по значениям метки. **Лечение:** убрать имя из белого списка; уже созданные ряды исчезнут только с перезапуском процесса.
- **Симптом:** цифры по командам не сходятся. **Причина:** значение метки задает клиент, подтверждения нет. **Лечение:** проставлять заголовок в доверенном звене и вычищать пришедший от клиента.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `tokenizer_metrics_custom_labels_header=`.

## В arriero

Ключевой факт: прокси arriero вырезает клиентский заголовок с метками намеренно. Имя по умолчанию `x-custom-labels` не форвардится ни на какой upstream (`proxyRequestHeaders` в `apps/api/src/proxy/http.ts`), а имя, переименованное этим аргументом на управляемом инстансе, вычисляется из аргументов инстанса и вырезается тоже (`instanceMetricsLabelHeader` в `apps/api/src/proxy/upstream-context.ts`). Причина — два свойства механизма, описанные выше: значения меток не проверяются и не ограничиваются, поэтому сквозной проход через открытый фасад означал бы подмену атрибуции и клиентоуправляемый рост кардинальности. Preflight KTransformers предупреждает, что метки не пройдут через прокси, как только на инстансе задан белый список. Пользовательские метки доходят до движка только от клиентов, работающих с портом инстанса напрямую.

Если задача — разделить потребление по потребителям, в arriero для этого есть собственный механизм, устроенный правильно: источники запросов (`config/proxy/sources.json`, ключи в `.secrets.json`), которые резолвятся по входящему `Authorization`/`x-api-key` и стамповываются в трассу как `sourceId`/`sourceName` (`docs/API_PROXY_FOUNDATION.md` § Request sources, arriero). Значение там определяется ключом, а не заголовком, и подменить его клиент не может. История трасс с фильтрами и фасетами по источнику доступна на `#/proxy/traces`.

Второе следствие — эксплуатационное: на битый JSON в заголовке движок пишет в лог полную трассировку (`logger.exception`), и разбор лога arriero (`apps/api/src/process/log-parsers/sglang.ts`) честно считает строки трейсбека ошибками — инстанс уходит в `degraded` (`apps/api/src/process/health-summary.ts`). Через прокси этот канал закрыт вырезанием заголовка; спровоцировать его может только клиент с прямым доступом к порту инстанса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics --tokenizer-metrics-custom-labels-header x-tenant-labels --tokenizer-metrics-allowed-custom-labels tenant
```

```bash
curl -sS http://127.0.0.1:30000/v1/completions -H 'Content-Type: application/json' -H 'x-tenant-labels: {"tenant":"acme"}' -d '{"model":"Qwen3-30B-A3B","prompt":"ping","max_tokens":8}'
```

## Источники

- `sglang/python/sglang/srt/entrypoints/openai/serving_base.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `apps/api/src/proxy/http.ts`, `docs/API_PROXY_FOUNDATION.md`, `apps/api/src/process/log-parsers/sglang.ts`, `apps/api/src/process/health-summary.ts`
