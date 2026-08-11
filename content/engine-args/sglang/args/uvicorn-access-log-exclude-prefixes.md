---
schema: 1
engine: sglang
primaryName: "--uvicorn-access-log-exclude-prefixes"
title: "--uvicorn-access-log-exclude-prefixes"
summary: Убирает из access-лога uvicorn строки, чей путь начинается с одного из перечисленных префиксов. Прямое лекарство от шума служебных проб; при --enable-http2 не действует, потому что Granian конфигурацию uvicorn не читает.
group: observability
related:
  - --log-level-http
  - --log-level
  - --enable-http2
  - --enable-metrics
  - --tokenizer-worker-num
---

# --uvicorn-access-log-exclude-prefixes

## Кратко

Значение попадает в фильтр `UvicornAccessLogFilter` (`sglang/python/sglang/srt/utils/common.py`), который `_configure_uvicorn_access_log_filter` регистрирует в `uvicorn.config.LOGGING_CONFIG` и подвешивает к обработчику `access` и логгеру `uvicorn.access`. Фильтр вытаскивает путь из записи access-лога и отбрасывает строку, если путь начинается с любого из указанных префиксов.

Это единственный способ выборочно заглушить служебный HTTP-шум, оставив видимым прикладной трафик: `--log-level-http warning` убирает access-лог целиком, а этот аргумент — только выбранные пути.

## Оригинальная справка

```text
Exclude uvicorn access logs whose request path starts with any of these prefixes. Defaults to empty (disabled). Example: --uvicorn-access-log-exclude-prefixes /metrics /health
```

## Паспорт аргумента

- Флаги: `--uvicorn-access-log-exclude-prefixes`
- Группа: `observability`
- Тип значения: список строк, `nargs="*"` — допускается и ноль значений
- Допустимые значения: `choices` нет; произвольные строки-префиксы пути
- Значение по умолчанию: в extract это выражение `dataclasses.field(default_factory=lambda: list(DEFAULT_UVICORN_ACCESS_LOG_EXCLUDE_PREFIXES))`. Раскрывается в **пустой список**: `DEFAULT_UVICORN_ACCESS_LOG_EXCLUDE_PREFIXES = ()` (`sglang/python/sglang/srt/server_args.py`). Фильтрация выключена
- Эффективное значение: перед регистрацией список нормализуется — пустые строки выбрасываются, дубликаты убираются с сохранением порядка; если после этого список пуст, фильтр не регистрируется вовсе
- Где объявлен: `ServerArgs.uvicorn_access_log_exclude_prefixes`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: HTTP-слой, `set_uvicorn_logging_configs` непосредственно перед стартом сервера

## Что меняет в движке

На инференс не влияет. Фильтр применяется к каждой записи access-лога и определяет путь так:

1. берет атрибут `record.request_line` (uvicorn кладет туда строку вида `GET /metrics HTTP/1.1`) и вырезает второй токен;
2. если атрибута нет — ищет первую пару кавычек в отформатированном сообщении и разбирает request-line оттуда;
3. если путь имеет абсолютную форму (`GET https://host/metrics HTTP/1.1`), берет из него компонент пути через `urlparse`;
4. отбрасывает query-string по первому `?`;
5. возвращает `False` (запись подавляется), если путь начинается с любого префикса.

Если путь извлечь не удалось, запись **сохраняется** — фильтр консервативен и не глотает то, чего не понял.

Важное ограничение области действия: конфигурация ставится в `uvicorn.config.LOGGING_CONFIG`. При `--enable-http2` HTTP обслуживает Granian (`_run_granian_server`), который этот словарь не читает, поэтому фильтр не работает. Аргумент при этом молча ничего не делает — предупреждения нет.

## Значения и формат

- Список путей через пробел: `--uvicorn-access-log-exclude-prefixes /health /metrics /v1/models`.
- Сравнение — обычный `str.startswith`, без регулярных выражений и без учета границ сегмента: префикс `/health` подавит и `/health`, и `/health_generate`, и гипотетический `/healthcheck-of-someone-else`.
- Регистр значим.
- Query-string на сравнение не влияет: `/metrics?foo=1` матчится префиксом `/metrics`.
- Ноль значений (`--uvicorn-access-log-exclude-prefixes` без аргументов) допустимо благодаря `nargs="*"` и означает «фильтрация выключена» — так можно перебить значение из YAML-конфига `--config`.
- Пустые строки в списке отбрасываются при нормализации; пустой префикс не может случайно подавить весь лог.

## Когда использовать

- Сервер под оркестратором или мониторингом: пробы готовности и опрос Prometheus дают постоянный поток строк, в котором тонет прикладной трафик. Типовой набор — `/health /metrics`.
- Управляемый инстанс arriero: менеджер опрашивает `/health` и `/v1/models`, обе строки шумят в логе инстанса (подробности ниже).
- Не используйте как средство «скрыть» обращения: подавляется только запись в лог, сами запросы обслуживаются как обычно и учитываются метриками.
- Не нужен, если access-лог и так выключен уровнем (`--log-level-http warning` и выше) — фильтровать будет нечего.

## Влияние на производительность и память

На VRAM, RAM и скорость генерации не влияет. Фильтр — один разбор строки и до N сравнений префиксов на запись access-лога; заметно это только при очень частом опросе, и даже там выигрыш от неписьма на диск больше расхода на фильтрацию. Основной измеримый эффект — уменьшение объема файла лога.

## Взаимодействие с другими аргументами

- `--log-level-http` / `--log-level`: определяют, включен ли access-лог вообще. При уровне `warning` и выше фильтр бесполезен, потому что записей нет.
- `--enable-http2`: отключает эффект аргумента (Granian вместо uvicorn).
- `--enable-metrics`: делает `/metrics` реально опрашиваемым и тем самым создает основной повод для этого аргумента.
- `--tokenizer-worker-num` > 1: uvicorn поднимается с несколькими воркерами; фильтр объявлен по import-пути класса, поэтому регистрируется в конфигурации логирования каждого воркера.
- `--fastapi-root-path`: если сервер живет за префиксом обратного прокси, в access-логе виден путь **после** снятия префикса — сравнивайте с ним, а не с внешним URL.

## Типовые проблемы и диагностика

- **Симптом:** аргумент задан, а строки проб идут. **Причина №1:** включен `--enable-http2`, работает Granian. Проверить: в логе есть `Starting embedded Granian HTTP/2 server on …`. **Причина №2:** префикс не совпадает с реальным путем (например, `/healthz` вместо `/health`). Проверить: посмотреть точный путь в самой строке access-лога.
- **Симптом:** пропали не только пробы, но и часть прикладных запросов. **Причина:** слишком короткий префикс, `startswith` не знает границ сегмента (`/v1` подавит вообще всё под `/v1/...`). **Лечение:** конкретизировать префикс.
- **Симптом:** после добавления аргумента лог не изменился, потому что access-лога и не было. **Причина:** `--log-level-http` выше `info`.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `uvicorn_access_log_exclude_prefixes=`.

## В arriero

Это самый полезный аргумент группы для управляемого инстанса.

- Менеджер опрашивает у SGLang `GET /health` и `GET /v1/models` (`apps/api/src/process/engine-probe.ts`) при каждом расчете сводки здоровья инстанса. На уровне `info` каждая проба оставляет строку access-лога.
- Фильтр рутинных проб arriero (`apps/api/src/process/log-filter.ts`) распознает формат llama.cpp (`done request: METHOD path addr status`) и строки uvicorn не вырезает. То есть, в отличие от llama.cpp, у SGLang шум проб попадает и в сырой, и в отфильтрованный лог, и занимает место в тех последних 1000 строках, которые читает разбор лога (`apps/api/src/process/log-summary.ts`) — вытесняя оттуда действительно полезные строки движка.

Рабочая настройка для инстанса под arriero: `--uvicorn-access-log-exclude-prefixes /health /v1/models /metrics`. Прикладной трафик (`/v1/chat/completions`, `/generate`) в логе останется.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --uvicorn-access-log-exclude-prefixes /health /v1/models /metrics
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics --log-level-http info --uvicorn-access-log-exclude-prefixes /metrics
```

## Источники

- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `apps/api/src/process/engine-probe.ts`, `apps/api/src/process/log-filter.ts`, `apps/api/src/process/log-summary.ts`
