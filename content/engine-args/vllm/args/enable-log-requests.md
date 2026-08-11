---
schema: 1
engine: vllm
primaryName: "--enable-log-requests"
title: "--enable-log-requests"
summary: Включает построчное логирование запросов: на INFO — идентификатор, параметры сэмплирования и LoRA, на DEBUG — сами промпты. Второй уровень пишет пользовательский текст в лог процесса, что для сервера, доступного не только с localhost, является утечкой.
group: null
related:
  - --enable-log-outputs
  - --max-log-len
  - --disable-log-stats
  - --api-key
---

# --enable-log-requests

## Кратко

`--enable-log-requests` создает `RequestLogger`, который вызывается на каждом входящем запросе. Объем записанного зависит от уровня логирования: на INFO пишется `request_id`, объект `SamplingParams`/`PoolingParams` и `LoRARequest`; на DEBUG к этому добавляется сам промпт — текст и список token id.

Это единственный аргумент из соседних «логовых», у которого есть прямое следствие для безопасности: на DEBUG весь пользовательский ввод оседает в логе процесса.

## Оригинальная справка

```text
Enable logging request information, dependent on log level:
- INFO: Request ID, parameters and LoRA request.
- DEBUG: Prompt inputs (e.g: text, token IDs).
You can set the minimum log level via `VLLM_LOGGING_LEVEL`.
```

## Паспорт аргумента

- Флаги: `--enable-log-requests`, `--no-enable-log-requests`
- Группа argparse: без группы (объявлен напрямую в `AsyncEngineArgs.add_cli_args`)
- Тип значения: bool, `action=argparse.BooleanOptionalAction` — есть парная отключающая форма
- Допустимые значения: флаг присутствует, присутствует `--no-` форма, либо не задан
- Значение по умолчанию: `AsyncEngineArgs.enable_log_requests`, то есть `False` — логирование выключено
- Эффективное значение: не переопределяется; фактическая подробность определяется `VLLM_LOGGING_LEVEL`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: построение состояния приложения (`init_app_state` в `api_server.py`), то есть HTTP-слой

## Что меняет в движке

При включенном флаге создается `RequestLogger(max_log_len=args.max_log_len)` и передается всем сервисам endpoint'ов; при выключенном на их место идет `None`, и вызовы логирования не происходят вовсе. Тот же флаг уходит в `AsyncLLM` как `log_requests`.

`RequestLogger` (`vllm/entrypoints/serve/utils/request_logger.py`) пишет два уровня:

- всегда на INFO — `Received request <id>: params: <params>, lora_request: <lora>.`
- дополнительно на DEBUG — `Request <id> details: prompt: <repr>, prompt_token_ids: <list>, prompt_embeds shape: <shape>.`

Конструктор сам предупреждает о рассогласовании с уровнем логирования:

- если минимальный уровень выше INFO — `` `--enable-log-requests` is set but the minimum log level is higher than INFO. No request information will be logged. ``
- если выше DEBUG (обычный случай) — `` `--enable-log-requests` is set but the minimum log level is higher than DEBUG. Only limited information will be logged to minimize overhead. To view more details, set `VLLM_LOGGING_LEVEL=DEBUG`. ``

Обрезка длины делается через `--max-log-len`: и текст промпта, и список token id усекаются до этого числа элементов; при `None` (дефолт) обрезки нет.

Логирование ответов — отдельный флаг `--enable-log-outputs`, который **требует** этого аргумента: `validate_parsed_serve_args` падает с `Error: --enable-log-outputs requires --enable-log-requests`.

Флаг также читает gRPC-режим (`--grpc`): `serve_grpc` передает его в `AsyncLLM.from_vllm_config`.

## Значения и формат

- Голый флаг включает, `--no-enable-log-requests` явно выключает. Наличие обеих форм важно при использовании `--config`: ключ `enable-log-requests: false` в YAML развернется в `--no-enable-log-requests`, потому что такая опция зарегистрирована.
- «Не задан» здесь означает именно `False`, а не «решит движок».
- Подробность управляется не аргументом, а переменной окружения `VLLM_LOGGING_LEVEL` (по умолчанию `INFO`).

## Когда использовать

- Разбор конкретного инцидента: нужно увидеть, с какими параметрами сэмплирования пришел запрос и какой LoRA-адаптер был выбран. Уровня INFO для этого достаточно, и промпты в лог не попадут.
- Отладка обработки промптов и шаблонов чата — только с `VLLM_LOGGING_LEVEL=DEBUG` и только на закрытом стенде.
- **Не включайте DEBUG-уровень на сервере, доступном не только с localhost.** Промпты — это пользовательские данные; лог процесса читается всеми, у кого есть доступ к файлам, и переживает перезапуск. Если разбор все же нужен, ограничьте объем через `--max-log-len`.
- Не используйте как замену метрикам: агрегаты живут в `--disable-log-stats`-подсистеме и в `/metrics`, а не здесь.

## Влияние на производительность и память

- **VRAM.** Не влияет.
- **CPU.** На INFO стоимость мала — одна строка на запрос. На DEBUG заметно дороже: формируется `repr` промпта и печатается полный список token id, что на длинных контекстах дает килобайты на запрос.
- **Диск.** Основная цена. Без `--max-log-len` объем лога растет пропорционально суммарной длине промптов; на потоке длинных контекстов это гигабайты в сутки.
- **Latency.** Логирование синхронное в обработчике запроса; на INFO влияние в пределах шума, на DEBUG на длинных промптах становится измеримым.

## Взаимодействие с другими аргументами

- `--enable-log-outputs`: логирование сгенерированных ответов; требует этого флага, иначе разбор аргументов падает. Отдельно отметьте, что ответы пишутся на INFO, то есть попадают в лог **без** перехода на DEBUG.
- `--max-log-len`: единственная ручка ограничения объема — обрезает и промпты, и ответы до N символов/элементов. Дефолт `None` означает «без ограничения».
- `--disable-log-stats`: независимая подсистема (агрегированная статистика), не заменяет и не отменяет этот флаг.
- `--api-key`: если лог с промптами все же нужен, доступ к серверу разумно закрыть ключом; сам по себе этот аргумент содержимое лога не защищает.

## Типовые проблемы и диагностика

- **Симптом:** флаг включен, но промптов в логе нет. **Причина:** уровень логирования выше DEBUG. **Проверка:** предупреждение `` `--enable-log-requests` is set but the minimum log level is higher than DEBUG. `` **Лечение:** `VLLM_LOGGING_LEVEL=DEBUG`, взвесив риск утечки.
- **Симптом:** флаг включен, но в логе нет ничего вообще. **Причина:** уровень выше INFO. **Проверка:** предупреждение `No request information will be logged.`
- **Симптом:** `Error: --enable-log-outputs requires --enable-log-requests`. **Лечение:** добавить этот флаг.
- **Симптом:** лог растет неконтролируемо. **Причина:** `--max-log-len` не задан. **Лечение:** задать разумное значение (например, 200) — оно применяется и к промптам, и к ответам.
- **Симптом:** ключ `enable-log-requests: false` в YAML не отключил логирование. **Причина:** такого не происходит — парная `--no-` форма зарегистрирована, и ключ разворачивается корректно. Если эффекта нет, проверьте, не задан ли флаг явно в командной строке: явный аргумент перебивает файл.
- **Подтверждение принятого значения:** строки `Received request <id>: params: ..., lora_request: ...` в логе на каждый запрос.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-log-requests --max-log-len 200
```

```bash
vllm serve /models/Qwen3-4B --enable-log-requests --enable-log-outputs --max-log-len 200
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/serve/utils/request_logger.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/grpc_server.py`
- `vllm/vllm/v1/engine/async_llm.py`
- `vllm/vllm/envs.py`
