---
schema: 1
engine: sglang
primaryName: "--http2-initial-connection-window-size"
title: "--http2-initial-connection-window-size"
summary: "Задаёт начальное окно приёма HTTP/2 на соединение в байтах. Применяется при включённом HTTP/2."
group: serving
related:
  - --enable-http2
  - --http2-max-concurrent-streams
---

# --http2-initial-connection-window-size

## Кратко

Задаёт начальное окно приёма HTTP/2 на соединение в байтах. Применяется при включённом HTTP/2.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Initial connection-level HTTP/2 receive window in bytes (1024 to 2^31 - 1). Only applies with --enable-http2.
```

## Паспорт аргумента

- Флаг: `--http2-initial-connection-window-size`
- Группа: `serving`
- Тип: `int`
- Декларативный default: `1024 * 1024`
- Объявление: `ServerArgs.http2_initial_connection_window_size` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI, инициализация и исполнение подсистемы, описанной ниже.

## Что меняет в движке

Serving validation проверяет диапазон, затем HTTP-сервер передаёт значение в HTTP2Settings Granian как `initial_connection_window_size`. Это flow control входящих данных всего соединения.

## Значения и формат

Целое число от 1024 до 2147483647 включительно. Выражение default `1024 * 1024` равно 1048576 байт (1 МиБ).

## Когда использовать

При измеренных задержках передачи больших запросов или многих stream по одному HTTP/2 соединению.

## Влияние на производительность и память

Большее окно позволяет принять больше данных без ожидания обновления окна, но может увеличить объём данных в обработке. На веса и KV-cache не влияет.

## Взаимодействие с другими аргументами

Требует `--enable-http2`; `--http2-max-concurrent-streams` отдельно ограничивает число stream.

## Типовые проблемы и диагностика

При выходе за диапазон старт с HTTP/2 завершается ошибкой. Если эффекта нет, проверьте, согласовал ли клиент HTTP/2.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-http2 --http2-initial-connection-window-size 4194304
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/serving_hook.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
