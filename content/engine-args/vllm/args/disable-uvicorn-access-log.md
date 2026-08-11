---
schema: 1
engine: vllm
primaryName: "--disable-uvicorn-access-log"
title: "--disable-uvicorn-access-log"
summary: Полностью выключает access-лог uvicorn. Убирает шум от health-опроса, но вместе с ним и единственную запись о том, кто и по какому пути обращался к серверу.
group: Frontend
related:
  - --disable-access-log-for-endpoints
  - --uvicorn-log-level
  - --log-config-file
  - --enable-log-requests
---

# --disable-uvicorn-access-log

## Кратко

Флаг превращается в `access_log=not args.disable_uvicorn_access_log` при вызове `serve_http()`, то есть отключает у uvicorn запись строк вида `127.0.0.1:53422 - "POST /v1/chat/completions HTTP/1.1" 200 OK`.

Это грубый инструмент: пропадают **все** строки доступа, включая ошибки клиентов (4xx) и отказы аутентификации. Если цель — только убрать периодический опрос здоровья, точнее подходит `--disable-access-log-for-endpoints`.

## Оригинальная справка

```text
Disable uvicorn access log.
```

## Паспорт аргумента

- Флаги: `--disable-uvicorn-access-log`, `--no-disable-uvicorn-access-log`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: `false` — access-лог включен
- Эффективное значение: не переопределяется, но может быть перекрыто конфигурацией логирования из `--log-config-file`, которая целиком задает набор логгеров и обработчиков
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.disable_uvicorn_access_log`
- Этап применения: HTTP-слой, `serve_http()` → `uvicorn.Config(access_log=...)`

## Что меняет в движке

Только поведение логгера `uvicorn.access`. Собственные логи vLLM (загрузка модели, размер KV-cache, статистика планировщика, `Received request ...` при `--enable-log-requests`) не затрагиваются — они пишутся другими логгерами.

## Значения и формат

- Не задан — `false`, access-лог пишется.
- `--disable-uvicorn-access-log` — выключить.
- `--no-disable-uvicorn-access-log` — явно включить, в том числе чтобы перебить значение из YAML в `--config`.

## Когда использовать

- Когда управляемый инстанс генерирует поток строк доступа от постоянного опроса здоровья и лог перестает быть читаемым.
- Не используйте, если по логу инстанса нужно расследовать обращения: после отключения не останется ни путей, ни кодов ответа, ни адресов клиентов.
- Компромисс для arriero: оставить access-лог включенным и отфильтровать только пути опроса через `--disable-access-log-for-endpoints "/health,/v1/models"`. Менеджер опрашивает оба этих пути в фоновом цикле примерно раз в секунду (`docs/API_PROXY_FOUNDATION.md`, arriero), а собственный фильтр служебных строк arriero рассчитан на формат `llama-server` и строки uvicorn не убирает.

## Влияние на производительность и память

Экономия на записи одной строки на запрос — на фоне генерации токенов пренебрежимо мала. Реальная выгода — размер файла лога в `runtime/logs/` и читаемость просмотра логов в интерфейсе.

## Взаимодействие с другими аргументами

- `--disable-access-log-for-endpoints`: точечная альтернатива; при полностью отключенном access-логе фильтр путей теряет смысл.
- `--uvicorn-log-level`: управляет уровнем логгеров uvicorn; выключенный access-лог не вернется даже на `debug`.
- `--log-config-file`: пользовательская конфигурация логирования задает обработчики целиком и может перекрыть эффект флага.
- `--enable-log-requests`: логи запросов движка живут отдельно и остаются.

## Типовые проблемы и диагностика

- **Симптом:** после включения флага не видно, приходят ли запросы вообще. **Причина:** access-лог и был единственным подтверждением. **Лечение:** вернуть access-лог и отфильтровать только пути опроса, либо смотреть счетчики на `/metrics`.
- **Симптом:** строки доступа остались, хотя флаг задан. **Причина:** активна конфигурация из `--log-config-file` или `VLLM_LOGGING_CONFIG_PATH`. **Проверка:** убрать конфигурацию и повторить.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --disable-uvicorn-access-log
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --disable-access-log-for-endpoints "/health,/v1/models"
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
