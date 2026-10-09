---
schema: 1
engine: sglang
primaryName: "--grpc-response-timeout-secs"
title: "--grpc-response-timeout-secs"
summary: Сколько секунд нативный gRPC-сервер ждет очередной чанк ответа от движка, включая первый; по истечении запрос прерывается с DEADLINE_EXCEEDED. На HTTP API не влияет; поднимать при длинной очереди или долгих нестриминговых генерациях через gRPC.
group: serving
related:
  - --grpc-port
  - --smg-grpc-mode
  - --max-running-requests
  - --chunked-prefill-size
---

# --grpc-response-timeout-secs

## Кратко

Таймаут Rust-слоя нативного gRPC-сервера (`--grpc-port`): сколько ждать следующего чанка ответа от Python-части движка. Отсчет идет заново для каждого чанка, но первый чанк ждет и очередь, и prefill, а у нестримингового запроса чанк вообще один — тогда таймаут ограничивает весь запрос целиком. Раньше значение было зашито в 300 секунд; теперь оно вынесено в аргумент с тем же значением по умолчанию. К HTTP-серверу и к legacy SMG-режиму аргумент отношения не имеет.

## Оригинальная справка

```text
Timeout in seconds waiting for each native gRPC response chunk, including the first. Must be positive. Defaults to 300.
```

## Паспорт аргумента

- Флаги: `--grpc-response-timeout-secs`
- Группа: `serving`
- Тип значения: int, секунды
- Допустимые значения: целое `> 0`
- Значение по умолчанию: `300`
- Эффективное значение: совпадает с заданным; `handle_deprecated_args` (`arg_groups/serving_hook.py`) только проверяет `> 0` и не переписывает значение
- Где объявлен: `python/sglang/srt/arg_groups/fields/serving.py:Serving.grpc_response_timeout_secs`
- Статус: обычный
- Этап применения: проверка в `__post_init__` → `_start_native_grpc_server_for_runtime` в `lifespan` HTTP-сервера (передается в `start_server` Rust-расширения) → ожидание каждого чанка ответа в обработчиках RPC

## Что меняет в движке

`_start_native_grpc_server_for_runtime` (`entrypoints/http_server.py`) передает значение как `response_timeout_secs` в `start_server` расширения `sglang-grpc` (`rust/sglang-grpc/src/lib.rs`). Rust-сервер превращает его в `Duration` и применяет в `recv_chunk_with_timeout` (`rust/sglang-grpc/src/server.rs`) — обертке `tokio::time::timeout` над чтением канала, по которому Python-мост (`entrypoints/grpc_bridge.py`) отдает чанки.

Где таймаут действует:

- **Стриминговые RPC** (`Generate`, `TextGenerate`, `ChatComplete`, `Complete`): ожидание каждого следующего чанка. Первый чанк приходит после очереди и prefill, последующие — с каждым шагом декодирования. При истечении клиент получает `DEADLINE_EXCEEDED` с текстом `Stream chunk timed out`.
- **Нестриминговый запрос через те же RPC** (`stream: false`): Python-мост дожидается полного результата и отдает его одним чанком, так что таймаут ограничивает всю генерацию.
- **Унарные RPC** (`Embed`, `TextEmbed`, `Classify`, OpenAI-совместимые embed/classify, служебные `GetLoad`, `FlushCache`, `UpdateWeightsFromDisk` и другие): ожидание единственного ответа; при истечении — `DEADLINE_EXCEEDED` с текстом `Request timed out after Ns`.

При срабатывании таймаута на запросе генерации Rust-слой сам отправляет abort этого `rid` в движок, так что запрос не продолжает занимать слот в фоне.

Проверка значения (`handle_deprecated_args`) выполняется всегда, даже без `--grpc-port`: `0` или отрицательное число дают `ValueError: --grpc-response-timeout-secs must be positive` при любом запуске.

## Значения и формат

- Целое число секунд, `> 0`. Дробные значения argparse не примет.
- `300` — значение по умолчанию; совпадает с прежней зашитой константой `DEFAULT_RESPONSE_TIMEOUT_SECS` Rust-слоя.
- Значения «без таймаута» нет; для практически бесконечного ожидания задайте большое число.
- Действует только на нативный gRPC-сервер; в `--smg-grpc-mode` и на HTTP API не читается.

## Когда использовать

- Нестриминговые запросы через gRPC с длинной генерацией (тысячи токенов на медленной модели или при большом батче): 300 секунд на весь ответ может не хватить.
- Под пиковой нагрузкой очередь перед prefill бывает длиннее пяти минут — тогда даже стриминговые запросы обрываются на первом чанке. Сначала проверьте, что очередь вообще должна быть такой длинной: обычно правильнее ограничить конкуренцию у клиента.
- Уменьшайте, если клиенту лучше быстро получить ошибку и уйти на другой бэкенд, чем ждать зависший запрос.
- Без `--grpc-port` (или `SGLANG_GRPC_PORT`) трогать незачем.

## Влияние на производительность и память

На VRAM, KV-пул и скорость генерации не влияет. Большое значение означает, что зависший на стороне движка запрос дольше держит gRPC-поток и канал Rust-слоя; маленькое — что запрос прерывается и освобождает слот раньше, но клиент получает ошибку вместо ответа.

## Взаимодействие с другими аргументами

- `--grpc-port`: включает нативный gRPC-сервер; без него значение только проверяется на старте.
- `--smg-grpc-mode`: legacy SMG-сервер — другой код, этот таймаут к нему не применяется.
- `--max-running-requests`, `--chunked-prefill-size`: определяют, сколько запрос простоит в очереди и как долго идет prefill, то есть сколько времени уходит на первый чанк.

## Типовые проблемы и диагностика

- `ValueError: --grpc-response-timeout-secs must be positive` на старте — передан `0` или отрицательное значение.
- gRPC-клиент получает `DEADLINE_EXCEEDED: Stream chunk timed out` — между чанками или до первого чанка прошло больше заданного времени. Сравните со временем очереди и prefill в логе движка; при длинной очереди решает ограничение нагрузки, а не рост таймаута.
- `DEADLINE_EXCEEDED: Request timed out after 300s` на нестриминговом или унарном запросе — запрос целиком дольше таймаута; увеличьте значение или переходите на стриминг.
- Это не дедлайн клиента: собственный deadline gRPC-клиента работает независимо и может сработать раньше.
- Принятое значение — в дампе `server_args=` при старте; запуск сервера подтверждает строка `Native gRPC server started on <host>:<port>`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --grpc-port 40000 --grpc-response-timeout-secs 1800
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --grpc-port 40000 --grpc-response-timeout-secs 60
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- `sglang/python/sglang/srt/arg_groups/serving_hook.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/grpc_bridge.py`
- `sglang/rust/sglang-grpc/src/lib.rs`
- `sglang/rust/sglang-grpc/src/server.rs`
- `sglang/test/registered/unit/server_args/test_server_args.py`
