---
schema: 1
engine: sglang
primaryName: "--log-level-http"
title: "--log-level-http"
summary: Отдельный уровень логирования для uvicorn/Granian. Единственный способ выключить access-лог HTTP, не заглушая логи самого движка, и обходной путь для значений, которые понимает uvicorn, но не понимает модуль logging.
group: observability
related:
  - --log-level
  - --uvicorn-access-log-exclude-prefixes
  - --enable-http2
  - --tokenizer-worker-num
  - --enable-ssl-refresh
  - --port
---

# --log-level-http

## Кратко

Значение уходит одним параметром `log_level=` в `uvicorn.run` / `uvicorn.Config` / встроенный сервер Granian во всех пяти ветках запуска HTTP-слоя (`sglang/python/sglang/srt/entrypoints/http_server.py`). Выражение везде одно: `server_args.log_level_http or server_args.log_level`.

Практический смысл ровно один — развести громкость движка и громкость HTTP-сервера. Типовой рабочий набор: `--log-level info --log-level-http warning`, при котором остаются диагностические строки старта и планировщика, но исчезает поток access-лога.

## Оригинальная справка

```text
The logging level of HTTP server. If not set, reuse --log-level by default.
```

## Паспорт аргумента

- Флаги: `--log-level-http`
- Группа: `observability`
- Тип значения: str (опциональный)
- Допустимые значения: `choices` нет. Строка идет в uvicorn, который принимает только собственные имена уровней в нижнем регистре — посмотреть список на своей сборке: `python -c "from uvicorn.config import LOG_LEVELS; print(list(LOG_LEVELS))"`. В отличие от `--log-level`, это значение **не** попадает в `getattr(logging, ...)`, поэтому уровень `trace` здесь законен
- Значение по умолчанию: `None` — берется `--log-level`
- Эффективное значение: `log_level_http or log_level`, вычисляется в момент старта HTTP-сервера. Никакой `_handle_*` его не трогает
- Где объявлен: `ServerArgs.log_level_http`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: HTTP-слой, после инициализации tokenizer/scheduler/detokenizer и загрузки весов

## Что меняет в движке

На инференс не влияет вообще. Аргумент управляет уровнем логгеров `uvicorn`, `uvicorn.error` и `uvicorn.access`; формат этих строк задается отдельно, в `set_uvicorn_logging_configs` (`sglang/python/sglang/srt/utils/common.py`): `[%(asctime)s] %(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s`.

Ключевое следствие: access-лог пишется на уровне INFO. Значение `warning` и выше гасит его целиком — каждый запрос перестает оставлять строку. Значение `info` возвращает по строке на запрос, включая служебные пробы.

При `--enable-http2` то же значение передается в Granian (`_run_granian_server`, параметр `log_level`). Granian — отдельный сервер со своим набором имен уровней; там же перестает действовать фильтр `--uvicorn-access-log-exclude-prefixes`, потому что он ставится в `uvicorn.config.LOGGING_CONFIG`, который Granian не читает.

## Значения и формат

- Не задан — используется `--log-level` со всеми его ограничениями (см. `log-level.md`: значения `warn`/`fatal` законны для `logging`, но uvicorn их не знает).
- `warning` — access-лог выключен, ошибки uvicorn (например, отказ привязки порта) остаются.
- `info` — access-лог включен, по строке на каждый HTTP-запрос.
- `debug`/`trace` — внутренняя детализация uvicorn; для отладки проксирования, keep-alive и разрывов соединений.
- Регистр значим: uvicorn ищет строку в словаре как есть, `INFO` вызовет `KeyError`.

## Когда использовать

- Управляемый инстанс за прокси arriero, где access-лог не несет информации, но каждая проба менеджера пишет строку: `--log-level-http warning`.
- Отладка обрывов SSE, keep-alive и заголовков: временно `--log-level-http debug` при обычном `--log-level info`.
- Нужен уровень, которого нет в модуле `logging` (`trace`) — задавать его можно только здесь.
- Не трогайте, если хотите избавиться только от строк проб, а не от access-лога целиком: для этого есть `--uvicorn-access-log-exclude-prefixes`, который оставляет видимым прикладной трафик.

## Влияние на производительность и память

На VRAM, RAM и скорость генерации не влияет. Единственный измеримый эффект — объем записи в файл лога: одна строка на HTTP-запрос при `info` против нуля при `warning`. На нагрузке в сотни запросов в минуту разница исчисляется мегабайтами в час.

## Взаимодействие с другими аргументами

- `--log-level`: значение по умолчанию и источник несовместимости словарей уровней; `--log-level-http` — штатный способ эту несовместимость обойти.
- `--uvicorn-access-log-exclude-prefixes`: более тонкий инструмент — фильтрует access-лог по префиксу пути, а не по уровню; работает только пока уровень HTTP оставляет INFO включенным.
- `--enable-http2`: значение уходит в Granian, а не в uvicorn; фильтр по префиксам при этом не применяется.
- `--tokenizer-worker-num` > 1: uvicorn поднимается с несколькими воркерами, значение передается тем же параметром; дополнительно жестко регистрируется логгер `sglang.srt.entrypoints.http_server` с уровнем `INFO`.
- `--enable-ssl-refresh`: ветка через `uvicorn.Config`, значение передается так же.

## Типовые проблемы и диагностика

- **Симптом:** `KeyError` с именем уровня в момент старта HTTP-сервера, уже после загрузки весов. **Причина:** значение не является ключом `LOG_LEVELS` uvicorn (регистр, `warn`, `fatal`). **Лечение:** одно из `critical`, `error`, `warning`, `info`, `debug`, `trace` в нижнем регистре.
- **Симптом:** задан `--log-level-http warning`, а строки вида `GET /health HTTP/1.1 200 OK` продолжают идти. **Причина:** включен `--enable-http2`, работает Granian, а не uvicorn. **Лечение:** проверить, что в логе есть строка `Starting embedded Granian HTTP/2 server on …`, и настраивать громкость на стороне Granian.
- **Симптом:** access-лог выключен, и вместе с ним пропали сообщения об ошибках привязки порта. **Причина:** уровень поднят слишком высоко (`critical`). **Лечение:** `warning`.
- **Проверка принятого значения:** строка `server_args=` при старте содержит `log_level_http=`.

## В arriero

Менеджер опрашивает у SGLang-инстанса `GET /health` и `GET /v1/models` (`apps/api/src/process/engine-probe.ts`). Фильтр рутинных проб arriero (`apps/api/src/process/log-filter.ts`) распознает формат llama.cpp (`done request: METHOD path addr status`) и строки uvicorn не вырезает, поэтому пробы попадают и в сырой, и в отфильтрованный лог инстанса.

Полезное следствие: строки access-лога uvicorn несут имя уровня (`INFO:`), а строки самого движка — нет. Ответ `500` в access-логе выглядит как `INFO: … 500 Internal Server Error` и **не** содержит слов, на которые реагирует разбор лога arriero, то есть сам по себе в `degraded` инстанс не переводит.

Практическая рекомендация для управляемого инстанса: `--log-level-http warning`, если access-лог не нужен вовсе, либо `--log-level-http info` вместе с `--uvicorn-access-log-exclude-prefixes /health /v1/models /metrics`, если нужен только прикладной трафик.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-level info --log-level-http warning
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-level info --log-level-http info --uvicorn-access-log-exclude-prefixes /health /v1/models
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/utils/common.py`
- arriero: `apps/api/src/process/engine-probe.ts`, `apps/api/src/process/log-filter.ts`, `apps/api/src/process/log-parsers/sglang.ts`
