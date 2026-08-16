---
schema: 1
engine: sglang
primaryName: "--allowed-media-domains"
title: "--allowed-media-domains"
summary: Белый список хостов, с которых сервер согласен скачивать медиа по URL из запросов. Пустой список (по умолчанию) означает «любой домен»; проверка распространяется и на каждый редирект. Основная защита от SSRF для сервера, доступного не только с localhost.
group: mm
related:
  - --media-url-max-file-size-mb
  - --trust-mm-content-hashes
  - --mm-io-worker-num
  - --limit-mm-data-per-request
  - --enable-multimodal
---

# --allowed-media-domains

## Кратко

Мультимодальный запрос может принести картинку, видео или аудио не байтами, а HTTP(S)-ссылкой — и тогда скачивать ее будет сам сервер, из своей сети, со своими доступами. `--allowed-media-domains` ограничивает такие загрузки списком точных имен хостов: все, что не в списке, отвергается до установления соединения. Редиректы разворачиваются вручную, и каждый промежуточный адрес проверяется по тому же списку — спрятать запрещенный хост за разрешенным редиректором не получится. Незаданный флаг оставляет историческое поведение «качаем откуда угодно», поэтому для сервера, в который ходят чужие клиенты, список стоит задавать всегда.

## Оригинальная справка

```text
Restrict client-supplied HTTP(S) image, video, and audio URLs to these exact hostnames. Redirect destinations are checked against the same allowlist. When unset, remote media from any domain is allowed.
```

## Паспорт аргумента

- Флаги: `--allowed-media-domains`
- Группа: `mm`
- Тип значения: список строк, `nargs="+"` — имена хостов через пробел после флага
- Значение по умолчанию: пустой список (`dataclasses.field(default_factory=list)`) — ограничения нет
- Эффективное значение: `_handle_media_url_security` в `__post_init__` прогоняет список через `configure_media_url_security` и записывает обратно нормализованные имена (IDNA, нижний регистр, без точки на конце, отсортированные, без дублей)
- Где объявлен: `ServerArgs.allowed_media_domains`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (нормализация и валидация) → повторная публикация политики в каждом tokenizer-процессе (конструктор `BaseMultimodalProcessor`) и на encoder-сервере EPD → каждая загрузка медиа по URL

## Что меняет в движке

Политика живет как процессные глобалы в `sglang/python/sglang/srt/utils/common.py`: `configure_media_url_security` кладет нормализованный `frozenset` хостов и байтовый лимит, а `download_remote_media` — единственная точка скачивания клиентских URL — применяет их. Загрузка медиа выполняется в отдельных процессах tokenizer-воркеров, поэтому та же конфигурация повторно публикуется в конструкторе `BaseMultimodalProcessor` и в encoder-сервере disaggregation-развертывания; проверки одни и те же для image, video, audio, кеша и модель-специфичных загрузчиков.

Нормализация каждого элемента списка (`_normalize_media_domain`):

- пробелы по краям и завершающая точка снимаются;
- строка со схемой (`://`) или символами `/?#@` отвергается на старте: `Invalid allowed media domain '…': provide a hostname only`;
- IP-адрес (включая IPv6 в скобках и без) приводится к каноническому виду через `ipaddress.ip_address`;
- порт указать нельзя: `Invalid allowed media domain '…': ports are not supported`;
- доменное имя проходит IDNA-кодирование и опускается в нижний регистр — кириллический домен можно писать как есть.

Проверка на запросе (`_assert_media_url_allowed`): схема обязана быть `http` или `https`, hostname нормализуется тем же способом и ищется в списке точным совпадением. Никаких wildcard'ов и поддоменов: `example.com` в списке не разрешает `cdn.example.com`. Перед проверкой URL приводится к тому же представлению, которое библиотека `requests` реально отправит (`Request(...).prepare().url`) — это закрывает расхождения парсеров вокруг backslash'ей и userinfo. Редиректы `download_remote_media` разворачивает сам (`allow_redirects=False`, максимум 5 переходов), проверяя каждый следующий адрес до соединения.

На медиа, пришедшие не по URL — base64, `data:`-URI, локальный путь — флаг не влияет.

## Значения и формат

- Одно или несколько имен хостов через пробел: `--allowed-media-domains cdn.example.com images.example.com`.
- Только имя хоста: без схемы, пути, порта и wildcard'ов. IP-адреса допустимы.
- Пустой список задать флагом нельзя (`nargs="+"` требует хотя бы одно значение); отсутствие флага и есть «разрешено все».
- Совпадение точное, регистронезависимое (после IDNA-нормализации обеих сторон).

## Когда использовать

- Всегда, когда сервер принимает запросы не только от вас: URL в запросе — это исходящий HTTP-запрос из сети сервера, то есть готовый SSRF-примитив (доступ к внутренним адресам, метаданным облака, соседним сервисам).
- Когда медиа приходят из известного хранилища (свой S3/CDN): перечислите его хосты и забудьте.
- Не как замена сетевой изоляции: список ограничивает имя хоста, но DNS-имя разрешается уже после проверки — для жесткой изоляции нужен еще и egress-фильтр.
- Бессмысленен, если клиенты шлют медиа только base64 — тогда лучше вообще не открывать URL-путь содержимым запросов.

## Влияние на производительность и память

На VRAM, RAM и скорость инференса не влияет: проверка — это операция над строкой перед скачиванием. Отказ происходит до установления соединения, так что запрещенные URL не тратят ни сетевых, ни IO-потоков (`--mm-io-worker-num`).

## Взаимодействие с другими аргументами

- `--media-url-max-file-size-mb`: вторая половина той же политики — лимит объема одной загрузки; настраиваются одним вызовом `configure_media_url_security`.
- `--trust-mm-content-hashes`: при горячем попадании в кеш препроцессинга по доверенному хешу медиа не скачивается вообще, то есть проверка домена в этом случае не выполняется — злоумышленник с валидным хешем все равно не заставит сервер ходить наружу.
- `--limit-mm-data-per-request` / `--mm-io-worker-num`: ограничивают количество и параллелизм загрузок; домены — их источник.
- `--enable-multimodal`: без мультимодального тракта скачиваний нет и проверять нечего.

## Типовые проблемы и диагностика

- `ValueError: Invalid allowed media domain 'https://cdn.example.com': provide a hostname only` — в список попала схема или путь; оставьте только имя хоста.
- `ValueError: Invalid allowed media domain 'cdn.example.com:443': ports are not supported`.
- Запрос с картинкой падает с `Media URL domain is not allowed. Allowed domains: […]; input domain: …` — домен не в списке либо редирект увел на чужой хост; сообщение показывает обе стороны сравнения.
- `ValueError: Invalid media URL: …` — схема не `http`/`https` или в URL нет hostname.
- `example.com` разрешен, а `www.example.com` отвергается — это не ошибка: совпадение точное, перечислите оба имени.
- Принятый список виден в дампе `server_args=` при старте (поле `allowed_media_domains`, уже нормализованное).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --allowed-media-domains cdn.example.com images.example.com --media-url-max-file-size-mb 32
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --allowed-media-domains 10.0.0.15
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- upstream PR: sgl-project/sglang#34892 (feat: add safeguards for remote media URLs)
