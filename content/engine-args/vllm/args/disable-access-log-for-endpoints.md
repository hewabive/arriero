---
schema: 1
engine: vllm
primaryName: "--disable-access-log-for-endpoints"
title: "--disable-access-log-for-endpoints"
summary: Список путей, строки доступа для которых не попадут в access-лог uvicorn. Точный способ убрать шум от постоянного опроса здоровья, не выключая лог целиком.
group: Frontend
related:
  - --disable-uvicorn-access-log
  - --uvicorn-log-level
  - --log-config-file
---

# --disable-access-log-for-endpoints

## Кратко

Аргумент принимает строку с путями через запятую и включает фильтр `UvicornAccessLogFilter`: записи access-лога, у которых путь запроса **точно** совпадает с одним из перечисленных, отбрасываются. Остальные строки пишутся как обычно.

Это правильный инструмент для управляемого инстанса: опрос здоровья идет постоянно, а важные строки доступа сохраняются.

## Оригинальная справка

```text
Comma-separated list of endpoint paths to exclude from uvicorn access
logs. This is useful to reduce log noise from high-frequency endpoints
like health checks. Example: "/health,/metrics,/ping".
When set, access logs for requests to these paths will be suppressed
while keeping logs for other endpoints.
```

## Паспорт аргумента

- Флаги: `--disable-access-log-for-endpoints`
- Группа argparse: `Frontend`
- Тип значения: str — одна строка с путями через запятую (не список: `nargs` у аргумента снят явно)
- Допустимые значения: пути с ведущим слэшем; пробелы вокруг элементов обрезаются, пустые элементы отбрасываются
- Значение по умолчанию: `None` — фильтра нет
- Эффективное значение: **игнорируется**, если задан `--log-config-file` (или переменная `VLLM_LOGGING_CONFIG_PATH`): в `get_uvicorn_log_config()` файл проверяется первым и, если он загрузился, фильтр не строится
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.disable_access_log_for_endpoints`
- Этап применения: HTTP-слой, `build_and_serve()` → `get_uvicorn_log_config()` → `uvicorn.Config(log_config=...)`

## Что меняет в движке

`get_uvicorn_log_config(args)` разбирает строку по запятой и вызывает `create_uvicorn_log_config(excluded_paths=[...], log_level=args.uvicorn_log_level)`. Результат — полная конфигурация логирования uvicorn, в которой к обработчику `access` привязан фильтр.

Сам фильтр устроен просто: он смотрит только записи логгера `uvicorn.access`, берет третий аргумент записи (путь запроса), отбрасывает строку запроса через `urlparse(...).path` и сравнивает с множеством исключенных путей **на точное равенство**.

Отсюда следуют границы применимости:

- совпадение точное, без префиксов и шаблонов: `/v1` не отфильтрует `/v1/models`;
- завершающий слэш имеет значение: `/health/` не равно `/health`;
- строка запроса (`?...`) отбрасывается перед сравнением, так что `/v1/models?x=1` фильтруется вместе с `/v1/models`;
- фильтруется только access-лог, никакие другие сообщения не затрагиваются.

## Значения и формат

- Одна строка в кавычках: `--disable-access-log-for-endpoints "/health,/v1/models"`.
- Пути перечисляются полностью, как они приходят в запросе.
- Для управляемого инстанса arriero практический набор — `/health` и `/v1/models`: именно их опрашивает менеджер.
- Значение не проверяется на существование маршрутов: опечатка просто ничего не отфильтрует.

## Когда использовать

- На любом инстансе под наблюдением (arriero, Kubernetes-пробы, внешний мониторинг), где опрос здоровья идет чаще, чем реальные запросы.
- Особенно в arriero: фоновый цикл прокси обновляет состояние примерно раз в секунду и на каждый круг опрашивает `/health` и `/v1/models` (`docs/API_PROXY_FOUNDATION.md`, arriero), а встроенный фильтр служебных строк менеджера понимает формат `llama-server` и строки uvicorn не убирает.
- Не используйте вместе с `--log-config-file`: файл выигрывает и фильтр не подключится.

## Влияние на производительность и память

Одно сравнение по множеству на запись access-лога. Реальный эффект — размер файла в `runtime/logs/` и читаемость лога.

## Взаимодействие с другими аргументами

- `--log-config-file`: имеет приоритет, при загруженном файле фильтр не создается.
- `--uvicorn-log-level`: значение попадает в сгенерированную конфигурацию как уровень всех логгеров uvicorn.
- `--disable-uvicorn-access-log`: полностью отключает access-лог; вместе с фильтром смысла не имеет.

## Типовые проблемы и диагностика

- **Симптом:** строки опроса продолжают идти. **Причины:** путь указан неточно (лишний слэш, другой регистр, префикс), либо активен `--log-config-file`. **Проверка:** сравнить путь из строки access-лога со значением аргумента символ в символ.
- **Симптом:** пропали не только опросы, но и обычные запросы. **Причина:** в списке оказался рабочий путь. **Лечение:** сузить список.
- **Симптом:** нужно отфильтровать группу путей по префиксу. **Причина:** фильтр сравнивает только на равенство. **Лечение:** перечислить пути явно либо задать собственную конфигурацию через `--log-config-file`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --disable-access-log-for-endpoints "/health,/v1/models"
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --disable-access-log-for-endpoints "/health,/ping,/metrics" --uvicorn-log-level info
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `vllm/vllm/logging_utils/access_log_filter.py`
- `vllm/tests/test_access_log_filter.py`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
