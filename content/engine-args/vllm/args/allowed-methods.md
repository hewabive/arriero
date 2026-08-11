---
schema: 1
engine: vllm
primaryName: "--allowed-methods"
title: "--allowed-methods"
summary: Список HTTP-методов, которые CORS-middleware разрешает браузеру в кросс-доменном запросе. Принимает JSON-массив, по умолчанию разрешены все методы.
group: Frontend
related:
  - --allowed-origins
  - --allowed-headers
  - --allow-credentials
---

# --allowed-methods

## Кратко

Значение уходит в `allow_methods` у `CORSMiddleware`. Оно влияет только на ответ preflight-запроса `OPTIONS` и на заголовок `Access-Control-Allow-Methods`; какие методы реально принимает маршрут, определяет FastAPI-роутер, а не этот список.

По умолчанию `["*"]`. Сужение списка ничего не запрещает не-браузерным клиентам.

## Оригинальная справка

```text
Allowed methods.
```

## Паспорт аргумента

- Флаги: `--allowed-methods`
- Группа argparse: `Frontend`
- Тип значения: список строк, задаваемый строкой JSON (`type=json.loads`, `nargs` удален)
- Допустимые значения: имена HTTP-методов в верхнем регистре либо `["*"]`
- Значение по умолчанию: `field(default_factory=lambda: ['*'])`, то есть `["*"]`
- Эффективное значение: не переопределяется движком; сопоставление выполняет `CORSMiddleware` из starlette
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.allowed_methods`
- Этап применения: HTTP-слой, `build_app()`

## Что меняет в движке

`FrontendArgs._customize_cli_kwargs` ставит `type=json.loads` и убирает `nargs`; `build_app()` передает результат в `CORSMiddleware(allow_methods=...)`. Собственной проверки методов у vLLM нет.

Практический эффект один: браузер, делая кросс-доменный запрос с «непростым» методом, сначала шлет `OPTIONS`, а middleware отвечает списком разрешенных методов. Аутентификация этот запрос пропускает без ключа — `AuthenticationMiddleware` явно исключает метод `OPTIONS`, иначе preflight ломался бы.

## Значения и формат

- Правильно: `--allowed-methods '["GET","POST","OPTIONS"]'` или `'["*"]'`.
- Неправильно: `--allowed-methods 'GET,POST'` — не JSON, argparse ответит `invalid loads value`.
- Методы записываются в верхнем регистре, как в HTTP.
- Практический минимум для OpenAI-совместимого API: `GET` (списки моделей) и `POST` (генерация). `OPTIONS` обрабатывает сам CORS-слой.

## Когда использовать

- Когда нужно сузить кросс-доменную поверхность для браузерного клиента и вы точно знаете набор методов.
- В остальных случаях трогать не нужно: за пределами браузера список ничего не меняет, а ошибка в нем ломает рабочее веб-приложение.

## Влияние на производительность и память

Не влияет.

## Взаимодействие с другими аргументами

- `--allowed-origins`: без совпадения источника список методов не рассматривается.
- `--allowed-headers`: вторая половина preflight; неправильный заголовок отклонит запрос даже при разрешенном методе.
- `--allow-credentials`: определяет, поедут ли cookie и заголовок авторизации в кросс-доменном запросе.

## Типовые проблемы и диагностика

- **Симптом:** `error: argument --allowed-methods: invalid loads value: 'GET,POST'`. **Причина:** значение не JSON. **Лечение:** `'["GET","POST"]'`.
- **Симптом:** браузер сообщает `Method POST is not allowed by Access-Control-Allow-Methods`. **Причина:** метод не входит в список. **Проверка:** `curl -i -X OPTIONS -H "Origin: https://app.example" -H "Access-Control-Request-Method: POST" http://127.0.0.1:8000/v1/chat/completions`.
- **Симптом:** метод разрешен, но сервер отвечает `405`. **Причина:** маршрут действительно не поддерживает этот метод — CORS-список к маршрутизации отношения не имеет.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --allowed-methods '["GET","POST"]'
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --allowed-origins '["https://app.example"]' --allowed-methods '["GET","POST"]' --allowed-headers '["authorization","content-type"]'
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
