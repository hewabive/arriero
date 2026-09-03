---
schema: 1
engine: vllm
primaryName: "--enable-log-outputs"
title: "--enable-log-outputs"
summary: Пишет сгенерированный текст и finish reason на INFO, а идентификаторы токенов — на DEBUG. Требует --enable-log-requests и является самым прямым способом положить содержимое ответов на диск.
group: Frontend
related:
  - --enable-log-requests
  - --enable-log-deltas
  - --max-log-len
  - --log-error-stack
---

# --enable-log-outputs

## Кратко

Флаг включает вызовы `RequestLogger.log_outputs(...)` в обслуживающих классах. Текст генерации и причина завершения пишутся на **INFO**, а идентификаторы сгенерированных токенов — отдельной строкой на **DEBUG**.

Аргумент нельзя задать в одиночку: `validate_parsed_serve_args` завершает старт с `TypeError: Error: --enable-log-outputs requires --enable-log-requests`.

Это самая заметная точка утечки содержимого в этой группе аргументов: текст ответов виден уже на INFO; промпты и token IDs требуют DEBUG.

## Оригинальная справка

```text
If set to True, log model outputs (generations). Requires
`--enable-log-requests`. Output text and finish reasons are logged at INFO,
while output token IDs are logged at DEBUG.
```

## Паспорт аргумента

- Флаги: `--enable-log-outputs`, `--no-enable-log-outputs`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но требует `--enable-log-requests` (иначе старт прерывается) — именно этот аргумент создает `RequestLogger`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.enable_log_outputs`
- Этап применения: HTTP-слой, обслуживающие классы Chat Completions, Responses и Token-in/Token-out

## Что меняет в движке

Значение прокидывается в конструкторы обслуживающих классов (`enable_log_outputs=args.enable_log_outputs`) и включает три независимые точки логирования в чате:

1. **Непотоковый ответ** — одна строка с полным текстом после завершения генерации.
2. **Потоковые дельты** — строка на каждую дельту, дополнительно управляется `--enable-log-deltas`. В строку попадает не только контент, но и содержимое рассуждений (`[reasoning: ...]`) и аргументы вызовов инструментов (`[tool_calls: ...]`).
3. **Итог потокового ответа** — собранный полный текст с `finish_reason: streaming_complete`; печатается независимо от `--enable-log-deltas`.

Каждая точка даёт строку INFO вида `Generated response <request_id>[ (streaming delta)| (streaming complete)]: output: <repr>, finish_reason: ...`. Если DEBUG включён, `RequestLogger` отдельно пишет `Generated response ... details: output_token_ids: [...]`. `--max-log-len` обрезает и текст, и список идентификаторов.

Отдельно стоит различать этот флаг и переменную окружения `VLLM_DEBUG_LOG_API_SERVER_RESPONSE`: она включает middleware `log_response`, которое пишет тело HTTP-ответа целиком, и при старте сама предупреждает `CAUTION: Enabling log response in the API Server. This can include sensitive information and should be avoided in production.`

## Значения и формат

- Не задан — `false`, генерации в лог не попадают.
- `--enable-log-outputs` — включить, обязательно вместе с `--enable-log-requests`.
- `--no-enable-log-outputs` — явно выключить (например, чтобы перебить значение из YAML в `--config`).
- Ограничить объем можно только `--max-log-len`; он же обрезает текст дельт.

## Когда использовать

- Локальная отладка форматов ответа, парсеров инструментов и рассуждений — когда нужно видеть ровно то, что вернула модель.
- Не включайте на сервере с реальными данными: содержимое диалогов окажется в файле лога и во всех местах, куда этот файл попадает.
- В arriero есть более аккуратная альтернатива: сохранение артефактов запроса включается узлом конвейера прокси, файлы кладутся отдельно и подчиняются 30-дневному сроку хранения трасс (`docs/API_PROXY_FOUNDATION.md`, arriero). Лог инстанса такого срока хранения не имеет.

## Влияние на производительность и память

Заметно только в потоковом режиме с `--enable-log-deltas`: строка лога на каждую дельту означает запись на каждый токен, что при высокой конкурентности превращается в постоянный поток ввода-вывода и раздувает файл лога. На VRAM и на скорость самой генерации не влияет.

## Взаимодействие с другими аргументами

- `--enable-log-requests`: обязательное условие; без него старт прерывается.
- `--enable-log-deltas`: отключает построчный вывод дельт, оставляя итоговую строку.
- `--max-log-len`: единственный способ ограничить длину записываемого текста.
- `--log-error-stack`: другая категория подробностей в логе, включается независимо.

## Типовые проблемы и диагностика

- **Симптом:** `TypeError: Error: --enable-log-outputs requires --enable-log-requests` при старте. **Причина:** флаг задан в одиночку. **Лечение:** добавить `--enable-log-requests`.
- **Симптом:** файл лога растет на сотни мегабайт за час. **Причина:** потоковые дельты. **Лечение:** `--no-enable-log-deltas` и `--max-log-len`.
- **Симптом (arriero):** инстанс здоров, но интерфейс показывает состояние `degraded` и «ошибки в логе». **Причина:** разбор лога vLLM в arriero считает ошибкой любую строку со словами `ERROR`, `FATAL`, `Exception` или `Traceback`, а при включенном логировании ответов такие слова легко приходят из самого текста генерации (типичный случай — модель пишет код или разбирает трассировку). **Лечение:** выключить `--enable-log-outputs` на управляемом инстансе.
- **Симптом:** ответы в логе есть, промптов нет. **Причина:** так и задумано, `log_inputs` пишет содержимое промпта на DEBUG. **Лечение:** `VLLM_LOGGING_LEVEL=DEBUG`, если промпты действительно нужны.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --enable-log-requests --enable-log-outputs --max-log-len 200
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --enable-log-requests --enable-log-outputs --no-enable-log-deltas
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/entrypoints/openai/responses/serving.py`
- `vllm/vllm/entrypoints/serve/utils/request_logger.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
