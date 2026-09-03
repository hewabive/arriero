---
schema: 1
engine: vllm
primaryName: "--api-key"
title: "--api-key"
summary: Включает проверку заголовка Authorization Bearer, но только для путей с префиксами /v1, /v2, /inference и /cohere. Все остальные endpoint'ы, включая /tokenize и управляющие, остаются без аутентификации.
group: Frontend
related:
  - --host
  - --uds
  - --root-path
  - --middleware
  - --ssl-certfile
  - --enable-tokenizer-info-endpoint
  - --enable-lora
---

# --api-key

## Кратко

`--api-key` добавляет в приложение ASGI-middleware `AuthenticationMiddleware`, которое требует `Authorization: Bearer <key>` и сравнивает токен постоянным по времени способом. Это не полноценная авторизация, а фильтр по одному списку статических ключей.

Главное, что нужно знать до включения: middleware проверяет ключ **только** если путь запроса начинается с `/v1`, `/v2`, `/inference` или `/cohere` (`GUARDED_PREFIX` в `server_utils.py`). Все прочее — `/tokenize`, `/detokenize`, `/score`, `/rerank`, `/pooling`, `/classify`, `/pause`, `/abort_requests`, `/health`, `/metrics`, `/invocations` — доступно без ключа. Апстрим отдельно перечисляет это в `docs/usage/security.md` и прямо пишет: не полагайтесь на `--api-key` как на единственную защиту.

Самая опасная строка этого списка — `/invocations`: это не служебный endpoint, а полноценная точка инференса (SageMaker-совместимая), эквивалентная `/v1` по возможностям и открытая без ключа. Текущая справка уже предупреждает об ограничении и называет `/v1`, `/v2` и `/inference`; полный список в коде дополнительно включает `/cohere` (`GUARDED_PREFIX` в `server_utils.py`).

## Оригинальная справка

```text
If provided, the server will require one of these keys to be presented in
the header.

Warning: this only authenticates endpoints under the `/v1`, `/v2`, and
`/inference` path prefixes. Other endpoints on the same server, including
`/invocations` (which exposes the same inference capabilities as `/v1`),
remain unauthenticated. Do not rely on `--api-key` alone to secure vLLM;
see
https://docs.vllm.ai/en/latest/usage/security.html#api-key-authentication-limitations
for what it does and does not protect.
```

## Паспорт аргумента

- Флаги: `--api-key`
- Группа argparse: `Frontend`
- Тип значения: список строк (`nargs="+"`, элементы через пробел)
- Допустимые значения: любые непустые строки; `""` и литерал `None` превращаются в `None` конвертером `optional_type`
- Значение по умолчанию: `None` — аутентификации нет
- Эффективное значение: `tokens = [key for key in (args.api_key or [envs.VLLM_API_KEY]) if key]` — CLI перебивает переменную окружения `VLLM_API_KEY`, пустые значения отбрасываются; если после фильтрации список пуст, middleware **не подключается вовсе**
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.api_key`
- Этап применения: HTTP-слой, `build_app()` — подключение middleware при сборке FastAPI-приложения

## Что меняет в движке

`AuthenticationMiddleware` — чистое ASGI-middleware, не FastAPI-зависимость:

1. В конструкторе ключи сразу превращаются в `sha256(token).digest()`; исходные строки в состоянии middleware не хранятся.
2. На каждый запрос берется заголовок `Authorization`, разбивается на схему и параметр; схема должна быть `bearer` без учета регистра. Заголовок `x-api-key` **не принимается** — клиенты Anthropic-стиля, которые шлют именно его, получат 401 на `/v1/messages`.
3. Параметр хешируется тем же `sha256`, сравнение идет через `secrets.compare_digest` по дайджестам фиксированной длины, результат накапливается через `|=` без раннего выхода. То есть сравнение постоянное по времени и не течет ни длиной ключа, ни позицией отличия.
4. Проверка пропускается в двух случаях: метод `OPTIONS` (иначе сломался бы CORS-preflight) и путь вне `GUARDED_PREFIX`.
5. Перед сверкой пути из `scope["path"]` снимается `root_path`, поэтому `--root-path /llm` не создает обхода: `/llm/v1/chat/completions` остается защищенным (это же проверяет upstream-тест `tests/entrypoints/openai/chat_completion/test_root_path.py`).

Отказ — ровно `401` с телом `{"error": "Unauthorized"}`. Никакого учета попыток, лимитов и логирования отказов нет.

Порядок middleware важен: `AuthenticationMiddleware` подключается **после** CORS, а в Starlette позже добавленное middleware оказывается снаружи. Поэтому ответ `401` формируется до CORS-слоя и не получает заголовков `Access-Control-Allow-*` — в браузере такой отказ выглядит как CORS-ошибка, а не как 401.

## Значения и формат

- Один ключ: `--api-key secret`.
- Несколько ключей: `--api-key secret-a secret-b` (`nargs="+"`), любой из них подходит. Ротация делается так: добавить новый, дождаться перехода клиентов, убрать старый.
- `--api-key ""` и `--api-key None` дают `None` после `optional_type` и **тихо отключают** аутентификацию — ошибки не будет.
- Альтернатива без CLI — переменная окружения `VLLM_API_KEY`; она используется только если `--api-key` не задан.
- Ключ в командной строке виден в `/proc/<pid>/cmdline` всем пользователям хоста и печатается в лог на старте: `setup_server()` вызывает `log_non_default_args(args)`, а `get_non_default_args` ничего не редактирует, так что в логе появляется строка вида `non-default args: {'api_key': ['secret'], ...}`. Переменная окружения в эту строку не попадает.

## Когда использовать

- Как второй барьер за файрволом или обратным прокси, а не вместо них.
- Когда несколько потребителей должны различаться ключами — тогда ставьте разные ключи и ротируйте их по одному.
- Не включайте на управляемом инстансе arriero без необходимости: менеджер обращается к инстансу без заголовка авторизации (сгенерированная запись каталога эндпоинтов для управляемого инстанса не имеет ключа — `docs/API_PROXY_FOUNDATION.md`, arriero), поэтому опрос `/v1/models` начнет получать 401 и цель прокси не станет `ready`. Опрос `/health` при этом продолжит работать: этот путь не защищен.
- Если ключ на управляемом инстансе все-таки нужен, помните, что arriero пересылает входящие заголовки клиента на upstream как есть: сработает только вариант, когда ключ источника прокси буквально совпадает с ключом vLLM. Устойчивее закрывать доступ на уровне `--host 127.0.0.1`.

## Влияние на производительность и память

Один `sha256` от заголовка на запрос — на фоне инференса неизмеримо. На VRAM и время старта не влияет.

## Взаимодействие с другими аргументами

- `--host`, `--uds`: реальная граница доступа. Ключ не заменяет ограничение интерфейса.
- `--root-path`: префикс снимается до проверки, обхода не дает.
- `--middleware`: пользовательские middleware добавляются последними и оказываются **снаружи** аутентификации, то есть видят запрос до проверки ключа; там же можно закрыть незащищенные пути.
- `--ssl-certfile`, `--ssl-keyfile`: без TLS ключ передается по сети открытым текстом.
- `--enable-tokenizer-info-endpoint`: открывает `/tokenizer_info` — путь вне защищенных префиксов, то есть chat template и настройки токенизатора будут доступны без ключа.
- `--enable-lora`: вместе с `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True` включает `/v1/load_lora_adapter` — этот путь под защитой ключа, но менять поведение модели он позволяет, так что доступ к нему стоит ограничивать и сетевым способом.

## Типовые проблемы и диагностика

- **Симптом:** клиент получает `401 {"error": "Unauthorized"}`. **Причины:** нет заголовка, схема не `Bearer`, ключ отличается, либо клиент шлет `x-api-key`. **Проверка:** `curl -H "Authorization: Bearer <key>" http://127.0.0.1:8000/v1/models`.
- **Симптом:** ключ задан, а `/tokenize` и `/score` отвечают без него. **Причина:** это ожидаемое поведение, пути вне `GUARDED_PREFIX`. **Лечение:** обратный прокси с явным списком разрешенных путей.
- **Симптом:** аутентификации нет, хотя аргумент передан. **Причина:** значение свелось к пустому списку (`""`, `None`) или было перебито конфигом. **Проверка:** в стартовой строке `non-default args:` должно быть непустое `api_key`.
- **Симптом:** в браузере запрос падает с CORS-ошибкой вместо 401. **Причина:** ответ 401 формируется снаружи CORS-middleware и не несет `Access-Control-Allow-Origin`. **Лечение:** смотреть реальный код ответа в devtools или через `curl`.
- **Симптом (arriero):** после включения ключа модель инстанса пропала из панели и запросы через прокси отвечают 503. **Причина:** опрос `/v1/models` без заголовка получает 401, состояние цели выводится из его содержимого. **Лечение:** снять ключ на управляемом инстансе либо согласовать ключ источника прокси с ключом vLLM.
- **Гигиена:** ключ виден в `/proc/<pid>/cmdline` и в логе старта; в arriero аргументы инстанса лежат в `config/instances/<name>.json`, который может быть под управлением config-git.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --api-key primary-key secondary-key
```

```bash
curl -sS -H "Authorization: Bearer primary-key" http://127.0.0.1:8000/v1/models
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `vllm/vllm/entrypoints/serve/utils/api_utils.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/tests/entrypoints/openai/chat_completion/test_root_path.py`
- `vllm/docs/usage/security.md`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
