---
schema: 1
engine: sglang
primaryName: "--stream-response-default-include-usage"
title: "--stream-response-default-include-usage"
summary: Добавляет в каждый стриминговый ответ финальный usage-кадр, даже если клиент не просил `stream_options.include_usage`. Это видимое клиенту изменение формата SSE: перед `data: [DONE]` появляется чанк с пустым `choices` и полем `usage`.
group: serving
related:
  - --enable-cache-report
  - --incremental-streaming-output
  - --stream-interval
  - --enable-metrics
---

# --stream-response-default-include-usage

## Кратко

По OpenAI-протоколу счетчики токенов в стриминге приходят только по запросу — `"stream_options": {"include_usage": true}`. Флаг делает это поведением по умолчанию для всего сервера.

Это ровно то изменение, которое клиент **видит на проводе**: в потоке появляется дополнительный SSE-кадр. Клиенты, которые перебирают `choices[0]` без проверки на пустоту, на нем спотыкаются.

## Оригинальная справка

```text
Include usage in every streaming response (even when stream_options is not specified).
```

## Паспорт аргумента

- Флаги: `--stream-response-default-include-usage`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` не переопределяет
- Где объявлен: `ServerArgs.stream_response_default_include_usage`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: HTTP-слой, формирование стримингового ответа `/v1/chat/completions` и `/v1/completions`

## Что меняет в движке

Единственная точка решения — `should_include_usage` (`sglang/python/sglang/srt/entrypoints/openai/utils.py`):

```python
if stream_options:
    include_usage = stream_options.include_usage or stream_response_default_include_usage
    continuous_usage_stats = bool(stream_options.continuous_usage_stats)
else:
    include_usage, continuous_usage_stats = stream_response_default_include_usage, False
```

Два вывода:

1. Флаг — это **логическое ИЛИ** с запросом. Он может только добавить usage, но не убрать: клиент с `include_usage: true` получит usage независимо от флага.
2. Флаг **не включает** `continuous_usage_stats` (usage в каждом чанке). Тот остается строго клиентским и приходит только из `stream_options.continuous_usage_stats`.

При `include_usage == true` после последнего содержательного чанка `serving_chat.py` дописывает:

```python
usage_chunk = ChatCompletionStreamResponse(
    id=content["meta_info"]["id"],
    created=int(time.time()),
    choices=[],  # Empty choices array as per OpenAI spec
    model=request.model,
    usage=usage,
)
yield f"data: {usage_chunk.model_dump_json()}\n\n"
```

и только после этого — `data: [DONE]`. То есть кадр имеет пустой `choices` и заполненный `usage` со `prompt_tokens`, `completion_tokens`, `total_tokens`, `reasoning_tokens`, а при `--enable-cache-report` еще и `prompt_tokens_details.cached_tokens`. `/v1/completions` устроен так же (`CompletionStreamResponse` с `usage`).

Нестриминговые ответы этим флагом не затрагиваются: там `usage` есть всегда.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — usage приходит только по явному `stream_options.include_usage`.
- Промежуточных режимов нет; чтобы получить usage в каждом чанке, клиент обязан прислать `stream_options.continuous_usage_stats: true` — сервер этого не навязывает.

## Когда использовать

- Инстансом пользуются клиенты, которые не умеют слать `stream_options`, а вам нужна пофакту метрика токенов на стороне клиента или биллинг.
- Нужен единый формат ответа независимо от того, какой SDK на другом конце.
- **Не включайте**, если перед сервером стоит прокси, который сам добивает `stream_options.include_usage` и сам же удаляет лишний кадр — флаг станет бессмысленным (см. про arriero ниже).
- **Не включайте**, если среди клиентов есть самописные разборщики SSE без проверки `if not chunk.choices` — они упадут на пустом `choices`.

## Влияние на производительность и память

Один дополнительный SSE-кадр на запрос. На VRAM, KV-пул и скорость генерации не влияет вообще; счетчики уже подсчитаны по ходу стрима и просто сериализуются.

## Взаимодействие с другими аргументами

- `--enable-cache-report`: определяет, будет ли внутри usage-кадра `prompt_tokens_details.cached_tokens`. Без него поле опускается (`_details_if_cached` возвращает `None` при нуле и при выключенном отчете).
- `--incremental-streaming-output`: usage-кадр формируется фасадом отдельно и от режима дельт не зависит.
- `--enable-metrics`: серверные метрики Prometheus считаются независимо; этот флаг — про то, что видит клиент.

В arriero управляемый инстанс почти всегда стоит за собственным прокси, и там на OpenAI-пути `stream_options.include_usage` **уже принудительно проставляется** прокси, а синтетический usage-кадр вырезается обратно, если клиент его не просил (`proxy/usage-meter.ts`, `proxy/protocol-endpoint.ts`; описано в `docs/API_PROXY_FOUNDATION.md`, раздел Telemetry). Вырезается именно кадр с пустым содержимым и без `finish_reason` — то есть ровно тот, который добавляет этот флаг. Итог: для трафика через прокси arriero флаг ничего не меняет ни в телеметрии, ни в том, что увидит клиент. Смысл он имеет только для клиентов, ходящих в инстанс напрямую, мимо прокси.

## Типовые проблемы и диагностика

- **Клиент падает с ошибкой индекса на `choices[0]`** — он не готов к кадру с пустым `choices`. Это штатный формат OpenAI, чинить надо клиента (или снять флаг).
- **Флаг задан, а usage нет** — проверьте, что запрос действительно стриминговый и идет на `/v1/chat/completions` или `/v1/completions`; на `/v1/responses` и нативном `/generate` этот механизм не применяется.
- **Нужен usage в каждом чанке, а приходит только в конце** — флаг этого не умеет; клиент должен прислать `stream_options.continuous_usage_stats: true`.
- **`prompt_tokens_details` отсутствует** — не задан `--enable-cache-report` либо `cached_tokens == 0`.
- Проверка руками:

  ```bash
  curl -N -s http://127.0.0.1:30000/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":true,"max_tokens":8}' | tail -3
  ```

  Предпоследний кадр должен содержать `"choices":[]` и `"usage"`.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --stream-response-default-include-usage --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --stream-response-default-include-usage --enable-cache-report --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/openai/utils.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/sglang/srt/entrypoints/openai/usage_processor.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`
