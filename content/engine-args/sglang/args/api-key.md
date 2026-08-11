---
schema: 1
engine: sglang
primaryName: "--api-key"
title: "--api-key"
summary: Единственный статический Bearer-ключ, закрывающий почти все HTTP-endpoint'ы, кроме /health* и /metrics*. Держатель ключа может прочитать сам ключ и admin-ключ через /server_info, поэтому это фильтр, а не разграничение прав.
group: serving
related:
  - --admin-api-key
  - --host
  - --port
  - --ssl-certfile
  - --tokenizer-worker-num
  - --grpc-port
  - --enable-metrics
  - --served-model-name
---

# --api-key

## Кратко

`--api-key` подключает ASGI-middleware `_ApiKeyASGIMiddleware` (`sglang/python/sglang/srt/utils/auth.py`), которое требует заголовок `Authorization: Bearer <ключ>`. Ключ ровно один — списка, как у vLLM, здесь нет, поэтому ротация без окна пересечения означает разрыв обслуживания.

Три факта, которые нужно знать до включения:

1. Пути с префиксами `/health` и `/metrics` **всегда** пропускаются без ключа — это сделано намеренно, ради k8s-проб и Prometheus.
2. `/server_info` (и его устаревший алиас `/get_server_info`) отдает `dataclasses.asdict(server_args)` **без редакции**, то есть возвращает и `api_key`, и `admin_api_key`, и `ssl_keyfile_password`. Этот endpoint относится к обычному уровню доступа, поэтому его открывает тот же `--api-key`. Разделение прав между обычным и admin-ключом на этом заканчивается.
3. Middleware вообще не подключается при `--tokenizer-worker-num > 1`; более того, в этом режиме каждый worker-процесс падает на `assert server_args.api_key is None`.

## Оригинальная справка

```text
Set API key of the server. It is also used in the OpenAI API compatible server.
```

## Паспорт аргумента

- Флаги: `--api-key`
- Группа: `serving`
- Тип значения: str (один ключ, не список)
- Допустимые значения: не ограничены argparse. Практически — только ASCII: сравнение идет через `secrets.compare_digest` по строкам, а он на не-ASCII `str` бросает `TypeError`
- Значение по умолчанию: `None` — аутентификации нет
- Эффективное значение: совпадает с заданным; переменной окружения-дублера у этого аргумента нет. Косвенный эффект: при `--grpc-port` вместе с `--api-key` `__post_init__` бросает `ValueError`, а при `--tokenizer-worker-num > 1` ключ приводит к `AssertionError` в каждом HTTP-worker'е
- Где объявлен: `ServerArgs.api_key`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверки совместимости с gRPC) → HTTP-слой, `_setup_and_run_http_server` подключает middleware до старта uvicorn/Granian

## Что меняет в движке

На инференс не влияет вообще — это чистый HTTP-фильтр.

### Когда middleware вообще появляется

```python
if (
    server_args.api_key
    or server_args.admin_api_key
    or app_has_admin_force_endpoints(app)
):
    add_api_key_middleware(app, api_key=..., admin_api_key=...)
```

Этот блок находится внутри ветки `if server_args.tokenizer_worker_num == 1`. В multi-tokenizer-режиме аутентификации нет ни в каком виде.

### Решение по каждому запросу

Чистая функция `decide_request_auth` (`utils/auth.py`) применяет правила в таком порядке:

1. метод `OPTIONS` — пропуск (иначе ломается CORS-preflight);
2. путь начинается с `/health` или `/metrics` — пропуск. Сюда попадают `/health`, `/health_generate` и `/metrics`; заметьте, что `/ping` — это **не** health-путь, и он ключом закрыт;
3. уровень endpoint'а определяется декоратором `@auth_level` через сопоставление запроса с маршрутом FastAPI.

Уровней три, но в текущем дереве используются только два:

- **NORMAL** (декоратора нет): при заданном `--api-key` требуется он. Сюда относится вся генерация (`/generate`, `/v1/chat/completions`, `/v1/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`, ollama-маршруты), а также `/v1/models`, `/model_info`, **`/server_info`**, `/v1/loads`, `/open_session`, `/close_session`, `/parse_function_call`, `/separate_reasoning`, `/set_trace_level`, `/load_lora_adapter_from_tensors`, `/ping`, `/invocations`.
- **ADMIN_OPTIONAL** (`@auth_level(AuthLevel.ADMIN_OPTIONAL)`, около сорока маршрутов): если задан `--admin-api-key`, принимается **только** он, а `--api-key` отвергается; если задан только `--api-key` — принимается он; если не задан ни один — доступ открыт. Сюда входят `/flush_cache`, `/set_internal_state`, вся группа `/update_weights_*`, `/init_weights_update_group`, `/release_memory_occupation`, `/resume_memory_occupation`, `/slow_down`, `/pause_generation`, `/continue_generation`, `/abort_request`, `/load_lora_adapter`, `/unload_lora_adapter`, `/start_profile`, `/stop_profile`, `/freeze_gc`, `/configure_logging`, группа `/hicache/storage-backend*`, `/*_expert_distribution_record`, `/dumper/{method}`, корпусные `/add_external_corpus` и соседи, плюс два маршрута elastic-EP.
- **ADMIN_FORCE** — уровень описан в коде, но ни один маршрут в этом дереве им не помечен.

Проверка токена: заголовок делится по первому пробелу, схема сравнивается без учета регистра со строкой `bearer`, значение сверяется через `secrets.compare_digest`. Заголовок `x-api-key` (стиль Anthropic) **не принимается**. Отказ — `401` с телом `{"error": "Unauthorized"}`; для ADMIN_FORCE без настроенного admin-ключа был бы `403`.

### Кто еще использует ключ

Warmup-поток самого сервера добавляет `Authorization: Bearer <api_key>` в свои запросы к `/model_info` и `/generate` (`_execute_server_warmup`), поэтому включение ключа не ломает штатный прогрев.

## Значения и формат

- Один ключ: `--api-key secret`. Второго значения не предусмотрено — `nargs` не задан.
- Пустая строка `--api-key ""` даст ложное значение и **тихо отключит** аутентификацию: middleware подключится только если задан `--admin-api-key`, а `decide_request_auth` при пустом `api_key` разрешит все NORMAL-запросы.
- Не-ASCII символы в ключе приведут к `TypeError` внутри `secrets.compare_digest` на первом же запросе с заголовком. Используйте `openssl rand -hex 32` или аналог.
- Заголовок клиента должен быть ровно `Authorization: Bearer <ключ>`. Регистр схемы значения не имеет, лишние пробелы внутри значения — имеют.

## Когда использовать

- Как второй барьер за файрволом или за `--host 127.0.0.1`, не вместо них.
- Когда сервер все-таки слушает внешний интерфейс — тогда обязательно вместе с TLS, иначе ключ уходит по сети открытым текстом, а `/server_info` отдает его обратно любому, кто им уже владеет.
- Не включайте на управляемом инстансе arriero без реальной необходимости (подробности ниже) — выигрыш нулевой, а способов случайно сломать проксирование несколько.
- Не рассчитывайте на `--api-key` как на разграничение ролей. Для этого предназначен `--admin-api-key`, и он тоже читается через `/server_info` (см. `admin-api-key.md`).

## Влияние на производительность и память

Один разбор заголовка и одно сравнение строк на запрос плюс сопоставление запроса с таблицей маршрутов Starlette (`_get_auth_level_from_app_and_scope` перебирает маршруты линейно). На фоне инференса неизмеримо; на VRAM, RAM и время старта не влияет.

## Взаимодействие с другими аргументами

- `--admin-api-key`: при одновременной установке admin-ключ **вытесняет** обычный на всех ADMIN_OPTIONAL-маршрутах — запрос с `--api-key` туда получит 401.
- `--tokenizer-worker-num`: значение больше 1 несовместимо. Каждый worker-процесс выполняет `assert server_args.api_key is None, "API key is not supported in multi-tokenizer mode"` и падает на старте.
- `--grpc-port`: `__post_init__` бросает `ValueError: --grpc-port is incompatible with --api-key/--admin-api-key` — нативный gRPC-слушатель обходит HTTP-middleware.
- `--enable-metrics`: `/metrics` остается открытым независимо от ключа, это осознанное исключение в `decide_request_auth`.
- `--host`, `--port`: реальная граница доступа; ключ ее не заменяет.
- `--ssl-certfile` / `--ssl-keyfile`: без TLS ключ передается открытым текстом.
- `--enable-http2`: middleware подключается к тому же ASGI-приложению, поэтому работает и с Granian.

## Типовые проблемы и диагностика

- **Симптом:** `401 {"error": "Unauthorized"}`. **Причины:** нет заголовка; схема не `Bearer`; ключ не совпал; клиент шлет `x-api-key`; либо запрос идет на ADMIN_OPTIONAL-маршрут, а на сервере задан еще и `--admin-api-key`. **Проверка:** `curl -i -H "Authorization: Bearer <key>" http://127.0.0.1:30000/v1/models`.
- **Симптом:** сервер вообще не стартует, в логе `AssertionError: API key is not supported in multi-tokenizer mode`. **Причина:** `--api-key` вместе с `--tokenizer-worker-num > 1`. **Лечение:** убрать одно из двух.
- **Симптом:** `ValueError: --grpc-port is incompatible with --api-key/--admin-api-key` при разборе аргументов. **Лечение:** снять `--grpc-port` либо отказаться от ключей.
- **Симптом:** ключ задан, а `/health` и `/metrics` отвечают без него. **Причина:** это заданное поведение, а не дефект. **Лечение:** закрывать эти пути обратным прокси, если они не должны быть видны.
- **Симптом:** ключ задан, а `500` вместо `401`. **Причина:** не-ASCII ключ и `TypeError` в `secrets.compare_digest`. **Лечение:** пересоздать ключ из ASCII.
- **Гигиена:** ключ виден в трех местах — `/proc/<pid>/cmdline`, строка `server_args=` в логе старта (`entrypoints/engine.py`) и ответ `/server_info`. В arriero это означает файл `config/instances/<name>.json` (возможно, под управлением config-git) и `runtime/logs/<instance>.raw.log`.

## В arriero

Опасность здесь другая, чем у vLLM, и это стоит проверить отдельно, а не переносить по аналогии.

- **Health-проба не ломается.** Менеджер выводит готовность инстанса из `/health` (`apps/api/src/process/health-summary.ts`), а `/health` у SGLang освобожден от проверки ключа. Инстанс дойдет до состояния `ready`, и цель прокси станет доступной. Проба `/v1/models` при этом будет возвращать 401, что видно на карточке инстанса, но на готовность не влияет — в отличие от vLLM, где нет такого исключения для health-пути.
- **Ломается прикладной трафик.** Сгенерированная запись каталога эндпоинтов для управляемого инстанса не несет ключа (`apiKeyEnvVar: null`, `docs/API_PROXY_FOUNDATION.md`), а форвардер (`apps/api/src/proxy/forwarder.ts`) пересылает заголовки клиента на upstream как есть. Поэтому проксированный запрос дойдет с тем `Authorization`, который прислал клиент: работать это будет ровно в одном случае — если ключ источника прокси буквально совпадает с `--api-key` SGLang. Иначе каждый запрос через прокси получит 401 от движка при формально «здоровой» цели.
- **Практический вывод:** для инстанса, живущего за прокси менеджера, `--api-key` избыточен. Границу доступа задает `--host 127.0.0.1`, а аутентификацию клиентов — источники запросов прокси (`config/proxy/sources.json`, `docs/API_PROXY_FOUNDATION.md` § Request sources), где ключи хранятся в `.secrets.json`, а не в аргументах командной строки.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --api-key 3f2a9c7e1b4d8065
```

```bash
curl -sS -i -H "Authorization: Bearer 3f2a9c7e1b4d8065" http://127.0.0.1:30000/v1/models
```

## Источники

- `sglang/python/sglang/srt/utils/auth.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `docs/KTRANSFORMERS_OPERATIONS.md`
