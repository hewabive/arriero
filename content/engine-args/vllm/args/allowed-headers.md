---
schema: 1
engine: vllm
primaryName: "--allowed-headers"
title: "--allowed-headers"
summary: Список заголовков запроса, которые CORS-middleware разрешает браузеру отправлять кросс-доменно. Принимает JSON-массив, по умолчанию разрешены все.
group: Frontend
related:
  - --allowed-origins
  - --allowed-methods
  - --allow-credentials
  - --enable-request-id-headers
---

# --allowed-headers

## Кратко

Значение уходит в `allow_headers` у `CORSMiddleware` и участвует только в ответе на preflight: браузер спрашивает `Access-Control-Request-Headers`, middleware отвечает `Access-Control-Allow-Headers`. Сервер сам по себе никаких заголовков из-за этого списка не отвергает.

По умолчанию `["*"]`. Если список сужают, чаще всего забывают `authorization` и `content-type` — и браузерный клиент перестает работать при живом сервере.

## Оригинальная справка

```text
Allowed headers.
```

## Паспорт аргумента

- Флаги: `--allowed-headers`
- Группа argparse: `Frontend`
- Тип значения: список строк, задаваемый строкой JSON (`type=json.loads`, `nargs` удален)
- Допустимые значения: имена заголовков либо `["*"]`
- Значение по умолчанию: `field(default_factory=lambda: ['*'])`, то есть `["*"]`
- Эффективное значение: не переопределяется движком; сопоставление и набор всегда разрешенных «безопасных» заголовков реализует `CORSMiddleware` из starlette
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.allowed_headers`
- Этап применения: HTTP-слой, `build_app()`

## Что меняет в движке

`FrontendArgs._customize_cli_kwargs` ставит `type=json.loads` и удаляет `nargs`, `build_app()` передает список в `CORSMiddleware(allow_headers=...)`. Дальше все решает starlette: он держит собственный список безопасных заголовков, которые разрешены всегда, а остальные сверяет с переданным перечнем и отвечает на preflight отказом, если браузер запросил что-то вне списка.

Заголовки, которые реально нужны OpenAI-совместимому клиенту в браузере: `content-type` (JSON-тело) и `authorization` (если включен `--api-key`). Если клиент проставляет `x-request-id` для сквозной корреляции, его тоже надо разрешить.

## Значения и формат

- Правильно: `--allowed-headers '["authorization","content-type"]'` или `'["*"]'`.
- Неправильно: `--allowed-headers 'authorization,content-type'` — не JSON, argparse ответит `invalid loads value`.
- Регистр значения не важен, HTTP-заголовки регистронезависимы.
- Проверить фактический ответ: `curl -i -X OPTIONS -H "Origin: https://app.example" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization" http://127.0.0.1:8000/v1/chat/completions`.

## Когда использовать

- Когда браузерное приложение с известного домена посылает фиксированный набор заголовков и вы хотите сузить кросс-доменную поверхность.
- Не трогайте, если клиентов в браузере нет: серверные клиенты и прокси arriero на этот список не смотрят.

## Влияние на производительность и память

Не влияет.

## Взаимодействие с другими аргументами

- `--allowed-origins`, `--allowed-methods`: три параметра работают только вместе, отказ по любому из них останавливает кросс-доменный запрос.
- `--allow-credentials`: разрешает передавать cookie и заголовок авторизации; сам по себе `authorization` еще должен быть в списке заголовков.
- `--enable-request-id-headers`: если клиент задает собственный `X-Request-Id`, добавьте `x-request-id` в список.

## Типовые проблемы и диагностика

- **Симптом:** `error: argument --allowed-headers: invalid loads value: ...`. **Причина:** значение не JSON. **Лечение:** записать массивом.
- **Симптом:** браузер сообщает `Request header field authorization is not allowed by Access-Control-Allow-Headers`. **Причина:** заголовок не попал в список. **Лечение:** добавить `authorization`.
- **Симптом:** список сужен, а `curl` работает как раньше. **Причина:** ограничение действует только в браузере. **Лечение:** ограничивать доступ сетевыми средствами.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --allowed-headers '["authorization","content-type"]'
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --allowed-origins '["https://app.example"]' --allowed-headers '["authorization","content-type","x-request-id"]' --enable-request-id-headers
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
