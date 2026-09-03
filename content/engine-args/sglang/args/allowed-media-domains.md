---
schema: 1
engine: sglang
primaryName: "--allowed-media-domains"
title: "--allowed-media-domains"
summary: Ограничивает исходящие загрузки изображений, видео и аудио точным списком HTTP(S)-хостов. Политика применяется и к каждому redirect; пустой список, напротив, разрешает любой домен.
group: mm
related:
  - --media-url-max-file-size-mb
  - --limit-mm-data-per-request
---

# --allowed-media-domains

## Кратко

Это защитная граница для URL, присланных клиентом в мультимодальном запросе. SGLang проверяет hostname перед первым соединением и после каждого redirect, поэтому разрешенный CDN не может незаметно перенаправить загрузчик на другой домен. Без аргумента allowlist пуст, а пустой allowlist означает «разрешить любой HTTP(S)-хост».

## Оригинальная справка

```text
Restrict client-supplied HTTP(S) image, video, and audio URLs to these exact hostnames. Redirect destinations are checked against the same allowlist. When unset, remote media from any domain is allowed.
```

## Паспорт аргумента

- Флаги: `--allowed-media-domains`
- Группа: `mm`
- Тип значения: список строк; argparse принимает одно или больше значений после флага
- Значение по умолчанию: пустой список (`dataclasses.field(default_factory=list)`)
- Где объявлен: `ServerArgs.allowed_media_domains`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI → `_handle_media_url_security` → загрузка каждого удаленного media-объекта

## Что меняет в движке

`configure_media_url_security` нормализует список и публикует его как process-wide policy. DNS-имена приводятся к lowercase IDNA и очищаются от завершающей точки; IPv4/IPv6 приводятся к канонической форме. Схема, path, query, userinfo и port в элементе списка запрещены — нужен только hostname.

`download_remote_media` допускает лишь `http` и `https`, вручную обрабатывает не более пяти redirect и до каждого запроса вызывает ту же проверку. Сопоставление точное: `media.example.com` не разрешает `sub.media.example.com` и не является wildcard. Сам аргумент не блокирует private/link-local IP и не выполняет DNS pinning; задавайте только доверенные домены.

## Значения и формат

- Передайте хосты через пробел: `--allowed-media-domains cdn.example.com media.example.org`.
- Не указывайте `https://`, `/path`, `:443` или `user@host` — старт завершится `ValueError`.
- Пустой список не запрещает remote media, а снимает доменное ограничение.

## Когда использовать

Задавайте allowlist у сервера, доступного недоверенным клиентам: иначе пользователь может заставить процесс загружать данные с произвольного HTTP(S)-адреса. В закрытом стенде аргумент полезен для воспроизводимости и запрета случайных внешних зависимостей.

## Влияние на производительность и память

Сравнение hostname пренебрежимо дешево и не меняет VRAM/RAM-пулы. Косвенно ограничение снижает риск зависших или чрезмерных внешних загрузок; размер тела отдельно ограничивает `--media-url-max-file-size-mb`.

## Взаимодействие с другими аргументами

- `--media-url-max-file-size-mb` ограничивает байты, но не источник; эти две защиты дополняют друг друга.
- `--limit-mm-data-per-request` ограничивает число объектов в одном запросе, а не их домены.

## Типовые проблемы и диагностика

- `Invalid allowed media domain ...: provide a hostname only` — из значения не удалены схема или URL-компоненты.
- `Media URL domain is not allowed` — исходный URL либо redirect ушел на hostname вне списка.
- Поддомен не проходит при разрешенном родительском домене — это ожидаемое точное сравнение.
- Нормализованный список виден как `allowed_media_domains=[...]` в стартовом дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen-VL --allowed-media-domains cdn.example.com media.example.org --media-url-max-file-size-mb 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
