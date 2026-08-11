---
schema: 1
engine: sglang
primaryName: "--log-requests-format"
title: "--log-requests-format"
summary: Выбор между человекочитаемой строкой и JSON-записью для логов запросов. На объем и на состав данных не влияет; JSON-строка при этом всё равно предваряется меткой времени форматтера, поэтому чистым JSON Lines файл не является.
group: observability
related:
  - --log-requests
  - --log-requests-level
  - --log-requests-target
---

# --log-requests-format

## Кратко

Аргумент выбирает одну из двух веток в каждом из трех методов `RequestLogger` (`sglang/python/sglang/srt/utils/request_logger.py`). Состав полей, список вырезаемых полей и предел обрезки одинаковы для обоих форматов — их задает `--log-requests-level`. Отличаются только сериализация и имена событий.

Практически значимая деталь: в режиме `json` строка все равно проходит через форматтер целевого логгера `[%(asctime)s] %(message)s` (`sglang/python/sglang/srt/utils/log_utils.py`), поэтому каждая строка файла выглядит как `[2026-08-11 12:00:00] {"timestamp": …}`. Прежде чем скармливать такой файл парсеру JSON Lines, префикс надо снять.

## Оригинальная справка

```text
Format for request logging: 'text' (human-readable) or 'json' (structured)
```

## Паспорт аргумента

- Флаги: `--log-requests-format`
- Группа: `observability`
- Тип значения: str
- Допустимые значения: `text`, `json` (жесткий `choices` в argparse)
- Значение по умолчанию: `text`
- Эффективное значение: совпадает с заданным; меняется на живом сервере через `POST /configure_logging`
- Где объявлен: `ServerArgs.log_requests_format`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: каждый вызов `log_received_request` / `log_openai_received_request` / `log_finished_request`

## Что меняет в движке

### `text`

Строки собираются функцией `_dataclass_to_string_truncated` и печатаются с фиксированными префиксами:

```text
Receive: obj=GenerateReqInput(rid='...', text='...', sampling_params={...})
Receive OpenAI: obj={'model': '...', 'messages': [...]}
Finish: obj=GenerateReqInput(...), out={'text': '...', 'meta_info': {...}}
```

Строковые значения печатаются через `repr()`, поэтому переводы строк внутри промпта экранируются и запись остается однострочной. Обрезка вставляет разделитель ` ... ` между началом и хвостом. Заголовки из белого списка добавляются суффиксом `, headers={...}`.

### `json`

Запись собирается функцией `_transform_data_for_logging` и сериализуется `json.dumps(..., ensure_ascii=False)` в `log_json`. Верхний уровень всегда содержит:

- `timestamp` — `datetime.now().isoformat()`, локальное время без указания зоны;
- `event` — одно из `request.received`, `request.received.openai`, `request.finished`;
- далее поля записи: `rid`, `obj`, при наличии `headers`, а для завершения — `out`.

`ensure_ascii=False` означает, что кириллица и прочий не-ASCII остаются читаемыми, а не превращаются в `\uXXXX`. Обрезка длинной строки вставляет `...` внутрь самой строки, а обрезка длинного списка — отдельный элемент `"..."`. Значения типов `int`/`float`/`bool`/`None` сохраняются как есть; всё, что не строка, не список, не словарь и не dataclass, приводится к строке через `str()`.

## Значения и формат

- `text` — для чтения глазами и `grep`.
- `json` — для машинного разбора; помните про префикс форматтера. Снять его можно, например, так:
  ```bash
  sed -E 's/^\[[^]]+\] //' /var/log/sglang-requests/host_0.log | jq -c 'select(.event=="request.finished") | {rid, e2e: .out.meta_info.e2e_latency}'
  ```
- Значение вне списка отвергает argparse.
- Обе ветки существуют во всех трех методах логирования, разных наборов событий у форматов нет.
- Однострочность записи гарантирована для строк (они проходят через `repr()` в `text` и через экранирование JSON в `json`); объект произвольного типа в `text` печатается через `str()` и теоретически может содержать перевод строки.

## Когда использовать

- Внешний сборщик логов, разбор по полям, подсчет latency по `meta_info` — `json`.
- Разовая диагностика по живому логу инстанса — `text`; он компактнее и лучше читается в `tail -f`.
- Не выбирайте `json` в надежде уменьшить утечку содержимого: набор полей и уровень обрезки от формата не зависят вовсе, их задает `--log-requests-level`.

## Влияние на производительность и память

Сопоставимы: `text` строит одну строку рекурсивным обходом, `json` — словарь и затем `json.dumps`. Разница на фоне самой генерации незаметна. На VRAM, RAM модели и время старта не влияет. Объем файла у `json` обычно немного больше за счет имен ключей.

## Взаимодействие с другими аргументами

- `--log-requests`: без него формат не имеет значения.
- `--log-requests-level`: определяет состав полей и обрезку — то есть всё, что формат только оформляет.
- `--log-requests-target`: формат одинаков для stdout и для файловых целей; сменить формат отдельно для одной цели нельзя.
- `POST /configure_logging` принимает поле `log_requests_format` и меняет его без перезапуска.

## Типовые проблемы и диагностика

- **Симптом:** `jq` падает с `parse error: Invalid numeric literal`. **Причина:** префикс `[дата время] ` перед JSON-объектом. **Лечение:** срезать префикс (пример выше).
- **Симптом:** в JSON нет поля `out`. **Причина:** это событие `request.received`, а не `request.finished`. **Лечение:** фильтровать по `event`.
- **Симптом:** в JSON нет `headers`. **Причина:** клиент не прислал ни одного заголовка из белого списка (по умолчанию только `x-smg-routing-key`, расширяется переменной окружения `SGLANG_LOG_REQUEST_HEADERS`).
- **Симптом:** внутри строки встречается `...` и непонятно, обрезка это или текст пользователя. **Причина:** усечение по `max_length` из `--log-requests-level`. **Лечение:** уровень 3.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `log_requests_format=`.

## В arriero

Формат влияет на разбор лога инстанса. Разбор (`apps/api/src/process/log-parsers/sglang.ts`) ищет ключевые слова в тексте строки, поэтому `json` **не** защищает от ложных ошибок: слово `error` внутри JSON-строки промпта распознается ровно так же, как в `text`, и переводит инстанс в `degraded` (`apps/api/src/process/health-summary.ts`). Единственная защита — уровень логирования 0 или 1.

Второе следствие: в arriero лог инстанса — это один файл `runtime/logs/<instance>-<startedAtMs>.raw.log`, в который попадает и вывод движка, и записи запросов. Смешивать в нем JSON-строки с обычными строками движка имеет смысл только если записи запросов направлены в отдельный каталог через `--log-requests-target`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-requests --log-requests-level 1 --log-requests-format json
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-requests --log-requests-format json --log-requests-target /var/log/sglang-requests
```

## Источники

- `sglang/python/sglang/srt/utils/request_logger.py`
- `sglang/python/sglang/srt/utils/log_utils.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `apps/api/src/process/log-parsers/sglang.ts`, `apps/api/src/process/health-summary.ts`
