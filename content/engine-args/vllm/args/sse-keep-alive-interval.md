---
schema: 1
engine: vllm
primaryName: "--sse-keep-alive-interval"
title: "--sse-keep-alive-interval"
summary: Отправляет SSE-комментарий при простое streaming ответа через заданный интервал секунд.
group: Frontend
related: 
  - --disable-uvicorn-access-log
---

# --sse-keep-alive-interval

## Кратко

Отправляет SSE-комментарий при простое streaming ответа через заданный интервал секунд.

## Оригинальная справка

```text
Send an SSE keep-alive comment line every this many seconds when a
`/v1/chat/completions` or `/v1/completions` streaming response is idle
(queued, prefill, or between tokens), to prevent reverse proxies/tunnels
with read timeouts from closing the connection. Defaults to 0, which
disables keep-alive comments entirely.
```

## Паспорт аргумента

- Флаги: `--sse-keep-alive-interval`
- Группа argparse: `Frontend`
- Тип значения: `int`
- Значение по умолчанию в декларации: `0`
- Где объявлен: `vllm/entrypoints/launchers/cli_args.py:BaseFrontendArgs.sse_keep_alive_interval`

## Что меняет в движке

Работает для /v1/chat/completions и /v1/completions во время ожидания, prefill и пауз между токенами.

## Значения и формат

Допустимые значения и ограничения проверяются при разборе CLI и построении конфига.

## Когда использовать

Задайте положительный интервал меньше read timeout прокси; 0 отключает сообщения.

## Влияние на производительность и память

GPU-память и вычисления модели не меняются; появляются небольшие сетевые сообщения.

## Взаимодействие с другими аргументами

Связанные флаги: `--disable-uvicorn-access-log`.

## Типовые проблемы и диагностика

Если прокси разрывает stream по таймауту, сравните интервал с его read timeout; отрицательное значение отклоняется.

## Примеры

```bash
vllm serve /models/model --sse-keep-alive-interval 15
```

## Источники

- `vllm/vllm/entrypoints/launchers/cli_args.py`
