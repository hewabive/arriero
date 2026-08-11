---
schema: 1
engine: vllm
primaryName: "--allowed-local-media-path"
title: "--allowed-local-media-path"
summary: Разрешает клиентам API читать `file:` URL с диска сервера в пределах одного каталога. Даёт любому, кто дотянулся до эндпоинта, чтение файлов под этим каталогом — включайте только в доверенном окружении.
group: ModelConfig
related:
  - --allowed-media-domains
  - --media-io-kwargs
  - --limit-mm-per-prompt
  - --trust-remote-code
---

# --allowed-local-media-path

## Кратко

По умолчанию мультимодальный вход принимает только `data:` и `http(s):` URL. `--allowed-local-media-path <dir>` дополнительно разрешает `file:` URL, но лишь для файлов, лежащих строго внутри указанного каталога.

Это привилегия, выдаваемая клиенту API, а не удобство администратора: любой, кто может отправить запрос на сервер, получает право прочитать (через декодер изображения/видео/аудио) произвольный файл под этим каталогом. На сервере, доступном не только с localhost, флаг нужно рассматривать как расширение поверхности атаки.

## Оригинальная справка

```text
Allowing API requests to read local images or videos from directories
specified by the server file system. This is a security risk. Should only
be enabled in trusted environments.
```

## Паспорт аргумента

- Флаги: `--allowed-local-media-path`
- Группа argparse: `ModelConfig`
- Тип значения: str (путь к каталогу)
- Допустимые значения: не ограничены парсером; проверка существования и «это каталог» выполняется позже
- Значение по умолчанию: `""` (пустая строка — загрузка локальных файлов запрещена)
- Эффективное значение: не переопределяется движком; путь приводится к абсолютному через `Path(...).resolve()` при создании `MediaConnector`
- Где объявлен: `vllm/config/model.py:ModelConfig.allowed_local_media_path`
- Этап применения: HTTP-слой, **первый запрос с медиа-контентом** (не старт сервера)

## Что меняет в движке

Значение живёт в `ModelConfig` и доходит до парсера контента через `MultiModalItemTracker.allowed_local_media_path` (`vllm/entrypoints/chat_utils.py`), который передаёт его в конструктор `MediaConnector`.

Ключевая деталь эксплуатации: коннектор создаётся лениво (`@cached_property _connector`) — «Connector setup may probe VLLM_MEDIA_CACHE. Defer it until a request actually contains media so text-only parsing never blocks on that I/O». Поэтому валидация пути происходит не при старте, а при первом запросе, где есть медиа. Опечатка в пути даёт исправно поднявшийся сервер, который потом отвечает ошибкой на конкретный запрос.

В конструкторе `MediaConnector` (`vllm/multimodal/media/connector.py`):

- непустой путь резолвится (`Path(...).resolve()`), после чего проверяются `exists()` и `is_dir()`; иначе `ValueError` с текстом «Invalid `--allowed-local-media-path`: The path ... does not exist» / «... must be a directory»;
- пустая строка даёт `self.allowed_local_media_path = None`.

Дальше `MediaConnector._load_file_url` для URL со схемой `file`:

1. при `None` бросает `RuntimeError("Cannot load local files without `--allowed-local-media-path`.")`;
2. собирает путь как `url2pathname(netloc + path)`;
3. проверяет `allowed_local_media_path not in filepath.resolve().parents` — то есть разрешённый каталог должен быть **предком уже разрезолвленного** пути. Симлинк внутри каталога, указывающий наружу, отбрасывается: `.resolve()` раскрывает его до реальной цели, и она не проходит проверку. `..` в URL по той же причине не выводит за границу.

На `data:` URL и на `http(s):` URL флаг не влияет вообще — там работают другие ветки `load_from_url`.

## Значения и формат

- Одна строка — путь к каталогу. Относительный путь резолвится относительно рабочего каталога процесса сервера, поэтому задавайте абсолютный.
- Пустая строка (значение по умолчанию) = функциональность выключена.
- Каталог должен существовать на момент первого медиа-запроса и быть именно каталогом, не файлом и не симлинком на файл.
- В запросе путь передаётся как URL: `{"type": "image_url", "image_url": {"url": "file:///srv/vllm-media/cat.jpg"}}`. Голый путь без схемы `file:` не принимается — `load_from_url` заканчивается «The URL must be either a HTTP, data or file URL.».
- Разрешён строго подкаталог: файл, лежащий ровно в разрешённом каталоге, проходит (каталог входит в `parents`), а сам каталог как значение URL — нет.

## Когда использовать

- Локальный оффлайн-стенд, где изображения уже лежат на диске рядом с сервером и гонять их через base64 дорого (бенчмарки vLLM так и делают — `docs/benchmarking/cli.md` использует `--allowed-local-media-path` для ShareGPT4V/ShareGPT4Video).
- Пайплайн, где генератор запросов и vLLM живут на одной машине и обмениваются большими видео.
- **Не включайте** на инстансе, который обслуживает недоверенных клиентов. И не указывайте каталог выше, чем нужно: `/` или домашний каталог пользователя превращают эндпоинт в средство чтения файлов. Заводите отдельный каталог только под медиа.
- В arriero инстанс vLLM обычно спрятан за прокси, и единственный барьер перед ним — авторизация request source (`config/proxy/sources.json`, `docs/API_PROXY_FOUNDATION.md`). При `allowAnonymous: true` барьера нет; сначала закройте источник, потом включайте флаг.

## Влияние на производительность и память

На VRAM и KV-cache не влияет: значение только разрешает ветку загрузки файла. Косвенно — локальное чтение убирает сетевую задержку и не занимает медиа-кэш (`VLLM_MEDIA_CACHE` кэширует только HTTP-загрузки), поэтому prefill стартует быстрее. Декодирование прочитанного файла тратит хостовую RAM ровно так же, как декодирование скачанного: ограничения задаются `VLLM_MAX_IMAGE_PIXELS`, `VLLM_MAX_AUDIO_DECODE_BYTES` и подобными переменными окружения, а не этим флагом.

## Взаимодействие с другими аргументами

- `--allowed-media-domains`: ортогонален. Он ограничивает HTTP-источники, этот флаг — файловые. Настроив один, вы не закрываете другой канал.
- `--media-io-kwargs`: параметры декодирования (например, `num_frames` для видео) применяются к локальному файлу так же, как к скачанному.
- `--limit-mm-per-prompt`: ограничивает количество медиа-элементов в запросе; вместе с локальными путями это единственный дешёвый способ ограничить, сколько файлов клиент прочитает за один вызов.
- `--trust-remote-code`: другой класс риска (исполнение кода из репозитория модели), но такое же правило — включается только в доверенном окружении и обычно фигурирует в том же чек-листе.

## Типовые проблемы и диагностика

- **Симптом:** `RuntimeError: Cannot load local files without --allowed-local-media-path.` **Причина:** клиент прислал `file:` URL, а флаг не задан. **Лечение:** задать флаг или перевести клиента на `data:`/HTTP.
- **Симптом:** `ValueError: Invalid --allowed-local-media-path: The path /srv/media does not exist.` — и это видно только на первом запросе с картинкой, а не при старте. **Причина:** ленивое создание `MediaConnector`. **Лечение:** проверить путь на хосте; после исправления перезапустить сервер (коннектор кэширован).
- **Симптом:** `ValueError: The file path /etc/passwd must be a subpath of --allowed-local-media-path /srv/vllm-media.` **Причина:** штатная защита от выхода за каталог, в том числе через `..` и симлинки. **Действие:** это не баг, а срабатывание проверки.
- **Симптом:** файл лежит в каталоге, но не читается. **Причина:** права доступа процесса vLLM — проверка каталога проходит, `media_io.load_file` падает на `PermissionError`. **Проверка:** от какого пользователя запущен процесс инстанса.
- **Подтверждение принятого значения:** прямой строки в логе нет. Проверяйте поведением: запрос с `file:` URL внутри каталога должен обрабатываться, а с путём вне каталога — давать сообщение с подстановкой вашего каталога.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --allowed-local-media-path /srv/vllm-media --limit-mm-per-prompt '{"image": 2}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --allowed-local-media-path /srv/vllm-media --allowed-media-domains upload.wikimedia.org
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/multimodal/media/connector.py`
- `vllm/vllm/entrypoints/chat_utils.py`
- `vllm/docs/features/multimodal_inputs.md`
- `vllm/docs/usage/security.md`
- `vllm/docs/benchmarking/cli.md`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
