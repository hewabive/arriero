---
schema: 1
engine: vllm
primaryName: "--allow-credentials"
title: "--allow-credentials"
summary: Разрешает браузеру слать в кросс-доменных запросах cookie и заголовок авторизации. Вместе с открытым списком источников превращает любой сайт в клиента вашего сервера.
group: Frontend
related:
  - --allowed-origins
  - --allowed-methods
  - --allowed-headers
  - --api-key
---

# --allow-credentials

## Кратко

Флаг передается в `CORSMiddleware(allow_credentials=...)` и отвечает за заголовок `Access-Control-Allow-Credentials: true`. Без него браузер не приложит к кросс-доменному запросу cookie и `Authorization`, даже если разрешены источник, метод и заголовки.

Опасна не сама опция, а сочетание: разрешенные учетные данные при `--allowed-origins '["*"]'` (значение по умолчанию) означают, что любая открытая в браузере страница может ходить в ваш сервер от имени пользователя.

## Оригинальная справка

```text
Allow credentials.
```

## Паспорт аргумента

- Флаги: `--allow-credentials`, `--no-allow-credentials`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется движком; итоговое поведение заголовков реализует `CORSMiddleware` из starlette
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.allow_credentials`
- Этап применения: HTTP-слой, `build_app()`

## Что меняет в движке

Одна строка: значение уходит в `app.add_middleware(CORSMiddleware, ..., allow_credentials=args.allow_credentials, ...)`. Логики vLLM здесь нет.

Существенная деталь принадлежит контракту браузера: заголовок `Access-Control-Allow-Origin: *` **несовместим** с режимом `credentials: include`. Реализация CORS в starlette это учитывает и при включенных учетных данных подставляет в ответ конкретный `Origin` запроса вместо звездочки. То есть комбинация «все источники + учетные данные» не ломается, а начинает работать для любого сайта — именно поэтому она и опасна.

Проверить поведение конкретной сборки просто:

```bash
curl -i -H "Origin: https://evil.example" http://127.0.0.1:8000/v1/models
```

Если в ответе одновременно `Access-Control-Allow-Origin: https://evil.example` и `Access-Control-Allow-Credentials: true`, конфигурация именно такая.

## Значения и формат

- Не задан — `false`, учетные данные в кросс-доменных запросах браузер не отправляет.
- `--allow-credentials` — включить.
- `--no-allow-credentials` — явно выключить; полезно, чтобы перебить значение, пришедшее из YAML в `--config` (значения файла подставляются до явных флагов, поэтому явный флаг выигрывает).

## Когда использовать

- Только если браузерное приложение действительно должно слать cookie или `Authorization` и список источников сужен до конкретных доменов.
- Никогда — вместе с `--allowed-origins '["*"]'`.
- Для управляемых инстансов arriero флаг не нужен: трафик идет от прокси менеджера, а не из браузера (`docs/API_PROXY_FOUNDATION.md`, arriero).

## Влияние на производительность и память

Не влияет: один заголовок в ответе.

## Взаимодействие с другими аргументами

- `--allowed-origins`: критичная пара. Учетные данные включают только вместе с явным списком доменов.
- `--allowed-headers`: чтобы браузер мог послать `Authorization`, заголовок должен быть еще и в списке разрешенных.
- `--api-key`: ключ проверяется на защищенных префиксах независимо от CORS; ответ `401` формируется снаружи CORS-middleware и заголовков `Access-Control-Allow-*` не несет.

## Типовые проблемы и диагностика

- **Симптом:** браузер сообщает `Credentials flag is true, but Access-Control-Allow-Credentials is not "true"`. **Причина:** флаг не включен, а клиент шлет `credentials: include`. **Лечение:** либо включить флаг вместе с явным списком источников, либо убрать учетные данные на клиенте.
- **Симптом:** проверка `curl` с произвольным `Origin` возвращает этот же источник и `Access-Control-Allow-Credentials: true`. **Причина:** включены учетные данные при открытом списке источников. **Лечение:** сузить `--allowed-origins`.
- **Симптом:** ожидали, что флаг что-то запрещает не-браузерным клиентам. **Причина:** CORS исполняется браузером; `curl` и серверные клиенты его игнорируют.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --allowed-origins '["https://app.example"]' --allow-credentials
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --no-allow-credentials
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/docs/usage/security.md`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
