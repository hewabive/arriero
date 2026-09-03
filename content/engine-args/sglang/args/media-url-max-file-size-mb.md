---
schema: 1
engine: sglang
primaryName: "--media-url-max-file-size-mb"
title: "--media-url-max-file-size-mb"
summary: Ограничивает размер одного удалённого изображения, видео или аудиофайла, загружаемого по клиентскому HTTP(S)-URL. Лимит проверяется и по `Content-Length`, и во время streaming download; `0` полностью отключает эту защиту.
group: mm
related:
  - --allowed-media-domains
  - --enable-multimodal
  - --limit-mm-data-per-request
  - --mm-io-worker-num
---

# --media-url-max-file-size-mb

## Кратко

Флаг ставит верхнюю границу в МиБ для **каждого** удалённого media object, который клиент передаёт серверу как HTTP(S)-URL. Это защита RAM и полосы загрузки, а не ограничение размера всего запроса: несколько файлов могут каждый уложиться в лимит.

Проверка выполняется потоково, поэтому сервер прекращает чтение, даже если источник не прислал `Content-Length` или указал его неверно. Для публичного endpoint значение `0` опасно: оно снимает единственный байтовый предел на одну удалённую загрузку.

## Оригинальная справка

```text
Maximum size in MiB for one client-supplied remote media download. The limit is enforced while streaming; set to 0 to disable it.
```

## Паспорт аргумента

- Флаги: `--media-url-max-file-size-mb`
- Группа: `mm`
- Тип значения: целое число
- Значение по умолчанию: `64` МиБ
- Допустимые значения: неотрицательные целые; отрицательное значение отвергается в `configure_media_url_security`
- Где объявлен: `ServerArgs.media_url_max_file_size_mb`
- Этап применения: нормализация в `__post_init__` → process-wide policy в каждом multimedia worker → streaming HTTP(S)-download до decode/preprocess

## Что меняет в движке

`ServerArgs._handle_media_url_security` передаёт значение в `configure_media_url_security`, где МиБ переводятся в байты. `download_remote_media` затем делает запрос с `stream=True`, запрещает автоматические redirects и проверяет каждый новый destination отдельно.

После успешного HTTP-ответа код сначала сравнивает числовой `Content-Length` с лимитом. Независимо от заголовка тело читается чанками по 64 КиБ; следующий чанк, пересекающий границу, вызывает `ValueError` до добавления в буфер. Та же process-wide policy устанавливается в процессоре, поэтому правило применяется к общим image/video/audio loaders и model-specific загрузчикам, использующим этот helper.

## Значения и формат

- `64` — предел 67 108 864 байта на один object.
- `0` — специальное значение «не ограничивать размер»; timeout и domain allowlist продолжают действовать.
- Отрицательное число завершает старт с `media_url_max_file_size_mb must be non-negative`.
- Локальные пути, уже переданные bytes/base64 и precomputed embeddings этим HTTP-download лимитом не ограничиваются.

## Когда использовать

- Оставляйте конечный лимит на сервере, доступном недоверенным клиентам.
- Поднимайте его только если рабочие видео/аудио действительно превышают 64 МиБ и host-memory budget выдерживает одновременные загрузки.
- Снижайте для image-only API с небольшими изображениями: отказ произойдёт до дорогостоящего decode/preprocess.
- Не ставьте `0` как способ исправить единичный oversized request; лучше согласовать размер с клиентом и `--limit-mm-data-per-request`.

## Влияние на производительность и память

Само сравнение почти бесплатно. Значение задаёт верхнюю границу временного `bytearray` одной загрузки; при нескольких `--mm-io-worker-num` пиковое потребление RAM и входящей полосы может приближаться к `лимит × число одновременных файлов`. На VRAM и KV-cache флаг напрямую не влияет.

## Взаимодействие с другими аргументами

- `--allowed-media-domains` ограничивает **откуда** загружать; текущий флаг — **сколько байт** принять. Redirect destinations проходят ту же allowlist-проверку.
- `--limit-mm-data-per-request` ограничивает число media items, а не размер каждого.
- `--mm-io-worker-num` увеличивает возможное число параллельных загрузок и суммарный кратковременный RAM/network draw.

## Типовые проблемы и диагностика

- `Remote media exceeds the ... byte download limit` до чтения тела — сервер отверг `Content-Length`; во время загрузки — реально прочитанные bytes пересекли предел.
- Ошибка возникает после redirect — лимит применяется к конечному ответу, а не только к исходному URL.
- Значение не влияет на base64 payload — это не remote HTTP(S)-download; ограничивайте request body на HTTP proxy/server layer.
- Итоговое значение видно в стартовом `server_args=`; отдельной строки об успешной установке policy нет.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --media-url-max-file-size-mb 32 --allowed-media-domains media.example.com
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --media-url-max-file-size-mb 256 --limit-mm-data-per-request '{"video": 1}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/test/registered/unit/multimodal/test_media_url_security.py`
