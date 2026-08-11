---
schema: 1
engine: vllm
primaryName: "--log-error-stack"
title: "--log-error-stack"
summary: Печатает трассировку стека для ответов с ошибкой. Помогает разобрать причину 500, но насыщает лог внутренними деталями сервера.
group: Frontend
related:
  - --enable-log-requests
  - --max-log-len
  - --uvicorn-log-level
  - --log-config-file
---

# --log-error-stack

## Кратко

Флаг включает вывод трассировки в обработчиках исключений HTTP-слоя. Клиенту при этом ничего дополнительного не возвращается: тело ответа формируется теми же функциями и проходит через `sanitize_message`, флаг влияет только на лог.

Значение по умолчанию не константа: поле объявлено как `log_error_stack: bool = envs.VLLM_SERVER_DEV_MODE`, то есть при `VLLM_SERVER_DEV_MODE=1` трассировки включены и без флага.

## Оригинальная справка

```text
If set to True, log the stack trace of error responses
```

## Паспорт аргумента

- Флаги: `--log-error-stack`, `--no-log-error-stack`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: выражение `envs.VLLM_SERVER_DEV_MODE` — то есть `false`, пока не выставлена переменная окружения `VLLM_SERVER_DEV_MODE=1`
- Эффективное значение: читается из `req.app.state.args.log_error_stack` на каждом обработчике исключений
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.log_error_stack`
- Этап применения: HTTP-слой, обработчики исключений FastAPI

## Что меняет в движке

Проверка `if req.app.state.args.log_error_stack:` стоит в четырех обработчиках `vllm/entrypoints/serve/utils/server_utils.py`:

- `engine_error_handler` — `logger.exception("Engine Exception caught. Request id: %s", ...)`;
- `http_exception_handler` — `logger.exception("HTTPException caught. Request id: %s", ...)`;
- `validation_exception_handler` — `logger.exception("RequestValidationError caught. Request id: %s", ...)`;
- `exception_handler` — здесь `logger.error(...)`, то есть строка без трассировки, только с идентификатором запроса.

`GenerationError` обрабатывается отдельно и трассировку не печатает намеренно: это ожидаемая ошибка, которую не нужно превращать в шум.

Обратите внимание на состав вывода: `logger.exception` печатает полную трассировку с путями файлов и внутренними именами. В сообщение клиенту эти детали не попадают — `validation_exception_handler` специально строит текст из `exc.errors()`, потому что `str(exc)` раскрывает путь к файлу обработчика.

## Значения и формат

- Не задан — значение переменной `VLLM_SERVER_DEV_MODE` (обычно `false`).
- `--log-error-stack` — включить.
- `--no-log-error-stack` — явно выключить; полезно, если инстанс запускается с `VLLM_SERVER_DEV_MODE=1` и трассировки не нужны.

## Когда использовать

- На время расследования: воспроизвести отказ, снять трассировку, выключить обратно.
- Не оставляйте включенным постоянно на инстансе, чей лог доступен шире, чем администратору: трассировки раскрывают устройство сервера и версии библиотек.
- В arriero учитывайте, что лог инстанса лежит в `runtime/logs/` и виден в интерфейсе, а подсчет ошибок по логу переводит инстанс в состояние `degraded` — включенные трассировки делают этот индикатор шумным.

## Влияние на производительность и память

Стоимость возникает только на ошибочных ответах: форматирование трассировки и запись. При потоке ошибок (например, шторм 400 от неверных запросов) лог растет быстро.

## Взаимодействие с другими аргументами

- `--enable-log-requests`: вместе дают полную картину «что пришло и на чем упало».
- `--max-log-len`: ограничивает длину промптов и ответов в логах, но не длину трассировки.
- `--uvicorn-log-level`, `--log-config-file`: трассировки пишутся логгером vLLM, а не uvicorn; уровень логирования uvicorn их не скрывает.

## Типовые проблемы и диагностика

- **Симптом:** в логе `Exception caught. Request id: ...` без трассировки. **Причина:** это ветка `exception_handler`, где используется `logger.error`. **Лечение:** искать причину по идентификатору запроса и сопутствующим строкам.
- **Симптом:** трассировки появляются, хотя флаг не задавали. **Причина:** `VLLM_SERVER_DEV_MODE=1`. **Лечение:** снять переменную (она же включает опасные dev-эндпоинты) или задать `--no-log-error-stack`.
- **Симптом:** лог заполнен трассировками `RequestValidationError`. **Причина:** клиент шлет некорректные тела запросов. **Лечение:** починить клиент, флаг выключить.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --log-error-stack --enable-log-requests
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --no-log-error-stack
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `vllm/vllm/entrypoints/serve/utils/error_response.py`
- `vllm/vllm/envs.py`
- `vllm/docs/usage/security.md`
