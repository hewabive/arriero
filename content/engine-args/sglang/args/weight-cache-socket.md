---
schema: 1
engine: sglang
primaryName: "--weight-cache-socket"
title: "--weight-cache-socket"
summary: Переопределяет клиентский Unix socket weight-cache. Без значения путь определяется UUID физического GPU и общим шаблоном окружения.
group: model
related:
  - --weight-cache-mode
  - --weight-cache-timeout
  - --tp-size
  - --pp-size
---

# --weight-cache-socket

## Кратко

Клиент weight-cache использует явно заданный путь либо вычисляет его по UUID физического GPU. Это позволяет разным TP/PP раскладкам обращаться к демону той же карты без привязки имени сокета к логическому rank.

## Оригинальная справка

```text
Unix socket path for weight cache daemon (client mode).If not set, derives the path from SGLANG_WEIGHT_CACHE_SOCKET_TEMPLATE using the caller's physical GPU UUID.
```

## Паспорт аргумента

- Флаг: `--weight-cache-socket`
- Группа: `model`
- Тип: строка, без choices
- Декларативный default: `null`
- Объявление: `ServerArgs.weight_cache_socket`
- Этап: `IpcModelLoader._fetch_from_cache`, перед подключением к демону.

## Что меняет в движке

Если `socket_path is None`, IPC loader получает `current_platform.get_device_uuid(device_config.gpu_id)` и вызывает `get_socket_path(device_uuid)`. Демон выводит socket и ready path по UUID своего GPU теми же helpers. Default шаблон сокета — `/tmp/sglang_weight_cache_{device_uuid}.sock`; его меняет `SGLANG_WEIGHT_CACHE_SOCKET_TEMPLATE`. Ready-файл независимо задаёт `SGLANG_WEIGHT_CACHE_READY_TEMPLATE`, default `/tmp/sglang_weight_cache_{device_uuid}.ready`.

Оба шаблона обязаны содержать `{device_uuid}`: отсутствие placeholder вызывает ValueError. Это защищает от подключения нескольких физических GPU к одному демону. Явный CLI-путь меняет только клиента и не форматируется как шаблон.

## Значения и формат

Путь к Unix socket; каталог должен существовать. CLI не подставляет `{device_uuid}` или rank в строку. Для нескольких GPU оставляйте аргумент незаданным и согласуйте шаблоны окружения демона и клиентов. Отсутствие значения — `None`; пустую строку не используйте как способ получить default.

## Когда использовать

Для подключения клиента к известному явному socket. Чтобы перенести все socket/ready файлы в другой каталог, задавайте одинаковые переменные окружения у демона и клиента с сохранением UUID placeholder.

## Влияние на производительность и память

Путь не меняет объём весов или KV-cache. Неверный путь может сделать демон недоступным: в client-режиме отсутствие socket допускает дисковую загрузку, поэтому фактическое время старта и расход памяти могут измениться.

## Взаимодействие с другими аргументами

`--weight-cache-mode off` не использует IPC cache. `--weight-cache-timeout` относится к ожиданию готовности демонов, а не к пути или socket connect timeout. TP/PP rank больше не определяет имя socket; нужен UUID фактического GPU.

## Типовые проблемы и диагностика

- `Daemon socket not found` — проверьте UUID GPU, шаблон и одинаковое окружение процессов.
- `must contain ... device_uuid` — шаблон не содержит обязательный placeholder.
- `Refusing to connect ... is not a socket owned by this user` — путь не является socket текущего пользователя; loader проверяет `lstat` и не следует симлинку.
- Существующий socket с отказом соединения даёт RuntimeError, а не тихий fallback.
- При ручном пути и режиме daemon убедитесь, что порождённый демон использует тот же путь через шаблон окружения.

## Примеры

```bash
SGLANG_WEIGHT_CACHE_SOCKET_TEMPLATE='/tmp/sglang_weight_cache_{device_uuid}.sock' python -m sglang.launch_server --model-path /models/Qwen3-8B --weight-cache-mode client
```

Для нескольких GPU этот шаблон безопаснее одного общего явного CLI-пути.

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/sglang/srt/weight_cache/protocol.py`
- `sglang/python/sglang/srt/weight_cache/ipc_loader.py`
- `sglang/python/sglang/srt/weight_cache/daemon.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
