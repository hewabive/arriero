---
schema: 1
engine: sglang
primaryName: "--http2-max-concurrent-streams"
title: "--http2-max-concurrent-streams"
summary: Задает advertised limit одновременных HTTP/2 streams на одно соединение Granian. Работает только с `--enable-http2` и не ограничивает общую конкурентность inference-запросов сервера.
group: serving
related:
  - --enable-http2
  - --tokenizer-worker-num
  - --max-running-requests
  - --enable-ssl-refresh
---

# --http2-max-concurrent-streams

## Кратко

HTTP/2 мультиплексирует несколько запросов внутри одного TCP-соединения. Аргумент задает значение `SETTINGS_MAX_CONCURRENT_STREAMS`, которое Granian сообщает клиенту. Это лимит на соединение и на протокольном уровне; очередь scheduler'а и число одновременно исполняемых sequences контролируются другими аргументами.

## Оригинальная справка

```text
Maximum number of concurrent streams advertised on each HTTP/2 connection (1 to 2^32 - 1). Only applies with --enable-http2.
```

## Паспорт аргумента

- Флаги: `--http2-max-concurrent-streams`
- Группа: `serving`
- Тип значения: int
- Значение по умолчанию: `200`
- Допустимый диапазон: от `1` до `4294967295` включительно
- Где объявлен: `ServerArgs.http2_max_concurrent_streams`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: SSL/HTTP validation → создание `granian.http.HTTP2Settings` → прием HTTP/2 streams

## Что меняет в движке

При `--enable-http2` SGLang проверяет диапазон и наличие пакета `granian`, затем передает значение в `HTTP2Settings(max_concurrent_streams=...)`. Одинаковая настройка используется embedded Granian при одном tokenizer worker и multi-worker запуске. Без `--enable-http2` сервер работает через Uvicorn, значение не читается.

## Значения и формат

Целое число в протокольном диапазоне `1..2^32-1`. Ноль не отключает streams и отвергается. Клиент может открыть несколько соединений, поэтому это не глобальный rate/concurrency limit.

## Когда использовать

Уменьшайте значение, чтобы один HTTP/2-клиент не держал слишком много активных streams и не создавал чрезмерное давление на frontend. Увеличивайте только если клиент действительно упирается в advertised limit и scheduler/память выдерживают дополнительную конкурентность.

## Влияние на производительность и память

Больший лимит позволяет лучше мультиплексировать запросы через одно соединение, но увеличивает потенциальное число одновременно живых ASGI request contexts и буферов. Сам по себе он не увеличивает `--max-running-requests`, KV cache или throughput GPU.

## Взаимодействие с другими аргументами

- `--enable-http2` активирует настройку и переключает frontend с Uvicorn на Granian.
- `--max-running-requests` ограничивает engine concurrency независимо от числа HTTP streams.
- `--tokenizer-worker-num` меняет способ запуска Granian, но значение применяется к каждому HTTP/2 соединению каждого worker'а.
- `--enable-ssl-refresh` несовместим с HTTP/2/Granian.

## Типовые проблемы и диагностика

- `--http2-max-concurrent-streams must be between 1 and 4294967295` — значение вне диапазона при включенном HTTP/2.
- Клиент создает дополнительные соединения вместо streams — возможно, достигнут лимит на соединение или клиент не согласовал HTTP/2.
- Строка `Starting embedded Granian HTTP/2 server ...` подтверждает активный HTTP/2 frontend; без нее аргумент не действует.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-http2 --http2-max-concurrent-streams 100
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`

