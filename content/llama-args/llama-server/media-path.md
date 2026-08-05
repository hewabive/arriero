---
schema: 1
primaryName: "--media-path"
title: "--media-path"
summary: "Каталог, из которого multimodal endpoints могут читать локальные `file://` media URLs. Без него `file://` запрещены."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "PATH"
presetSupport: "router-managed"
aliases:
  - "--media-path"
allowedValues: []
env: []
related:
  - "--mmproj"
  - "--mmproj-url"
  - "--api-key"
---

# --media-path

## Кратко

`--media-path` записывает каталог в `common_params::media_path`, проверяет, что это существующий каталог, и добавляет завершающий разделитель. Затем путь попадает в chat parsing options и разрешает `file://` URLs для локальных media-файлов.

## Оригинальная справка llama.cpp

```text
directory for loading local media files; files can be accessed via file:// URLs using relative paths (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--media-path`
- Значение: путь к каталогу
- Переменная окружения: не задана в `arg.cpp`
- Поле в `common_params`: `media_path`
- Значение по умолчанию: пустая строка, `file://` disabled
- Этап применения: chat/media parsing

## Что меняет в llama-server

В `handle_media()` URL с `file://` запрещен, если `media_path` пустой: `file:// URLs are not allowed unless --media-path is specified`. Когда путь задан, сервер удаляет префикс `file://`, проверяет filename/path через `fs_validate_filename(..., true)`, логирует `loading image from local file ...` и читает файл из `media_path + file_path`.

Directory traversal запрещен. Тесты покрывают отказ для `file://../mtmd/test-1.jpeg`.

## Значения и формат

Путь должен быть существующим каталогом. В запросе используйте относительный путь внутри этого каталога, например `file://images/cat.jpg`. Абсолютные `file://` пути не должны использоваться как способ обхода base directory.

## Когда использовать

Используйте для локальных multimodal сценариев, где клиент передает ссылки на файлы, уже доступные серверу. Для внешних клиентов безопаснее передавать base64 или контролируемые remote URLs, потому что `--media-path` открывает серверу чтение части файловой системы.

## Влияние на производительность и память

Чтение local media добавляет disk I/O и память под загруженный файл. Для remote `http` media код имеет лимит 10 MB и timeout 10 секунд; для local path явного лимита размера в этой функции нет.

## Взаимодействие с другими аргументами

- Для фактической обработки изображений/аудио нужна multimodal модель и `--mmproj` или совместимый HF источник.
- `--api-key` важен, если endpoint доступен по сети: без него пользователи смогут просить сервер читать разрешенные local media.
- `--props`/`GET /props` показывает `media_marker` и modalities, полезные для проверки multimodal capability.

## INI-пресеты и router-режим

В INI: `media-path = /srv/llama-media`. В router-режиме путь должен существовать в окружении дочернего модельного процесса, который реально обрабатывает chat request.

## Типовые проблемы и диагностика

- `not a directory`: каталог не существует на старте.
- `file:// URLs are not allowed`: сервер запущен без `--media-path`.
- `file path is not allowed`: путь содержит traversal или недопустимую форму.
- `file does not exist or cannot be opened`: файл отсутствует относительно media base или нет прав.

## Примеры

```bash
llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf --media-path /srv/llama-media
curl http://127.0.0.1:8080/v1/chat/completions -d '{"messages":[{"role":"user","content":[{"type":"text","text":"Describe this"},{"type":"image_url","image_url":{"url":"file://images/cat.jpg"}}]}]}'
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-common.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/tests/unit/test_security.py`
- `llama.cpp/tools/server/README.md`
