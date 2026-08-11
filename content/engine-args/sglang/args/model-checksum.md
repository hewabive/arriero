---
schema: 1
engine: sglang
primaryName: "--model-checksum"
title: "--model-checksum"
summary: Проверка целостности файлов модели по SHA256 перед чтением весов. Принимает путь к JSON-манифесту или HF repo ID; переданный без значения — берет `--model-path` как repo ID.
group: model
related:
  - --model-path
  - --download-dir
  - --load-format
  - --revision
  - --delete-ckpt-after-loading
---

# --model-checksum

## Кратко

`--model-checksum` включает проверку файлов модели по SHA256 непосредственно перед чтением весов. Ожидаемые суммы берутся либо из локального JSON-манифеста, либо из метаданных HF-репозитория (LFS-хеши через `HfFileSystem`). Несовпадение — это `IntegrityError` и отказ старта, а не предупреждение. Проверка встроена только в два загрузчика: `DefaultModelLoader` и `RunaiModelStreamerLoader`.

## Оригинальная справка

```text
Model file integrity verification. If provided without value, uses model-path as HF repo ID. Otherwise, provide checksums JSON file path or HuggingFace repo ID.
```

## Паспорт аргумента

- Флаги: `--model-checksum`
- Группа: `model`
- Тип значения: строка (`nargs="?"`, `const=""`)
- Допустимые значения: путь к JSON-манифесту, HF repo ID, либо флаг без значения
- Значение по умолчанию: `null` — проверка выключена
- Эффективное значение: флаг без значения даёт пустую строку `""`; она не равна `None`, поэтому проверка включается, а источником сумм становится сам `--model-path` (`checksums_source = model_checksum or model_name_or_path`)
- Где объявлен: `ServerArgs.model_checksum`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `_prepare_weights` загрузчика — после разрешения/скачивания каталога, до чтения весов

## Что меняет в движке

В `DefaultModelLoader._prepare_weights` и `RunaiModelStreamerLoader._prepare_weights`:

```python
if server_args and get_model().model_checksum is not None:
    checksums_source = get_model().model_checksum or model_name_or_path
    verify(model_path=hf_folder, checksums_source=checksums_source)
```

`verify` (`sglang/python/sglang/srt/utils/model_file_verifier.py`) загружает ожидаемый манифест и считает фактический по файлам каталога в 4 потока:

- `_load_checksums`: если источник — существующий **файл**, читается JSON (`files` c `{sha256, size}`; старый формат `checksums` принимается с `DeprecationWarning`); иначе источник трактуется как HF repo ID и суммы берутся из `HfFileSystem.ls(..., detail=True)` — сперва `lfs.sha256`, затем `sha256`, а если ни того ни другого нет, файл скачивается целиком и хешируется.
- `_compare_manifests`: отсутствующие и несовпавшие файлы собираются в один `IntegrityError: Integrity check failed: …`.
- Успех печатает `[ModelFileVerifier] All N files verified successfully.`

Из проверки исключены служебные файлы: `.DS_Store`, `*.lock`, `.gitattributes`, `LICENSE*`, `README*`, `NOTICE`. Проверяются только те имена, что перечислены в ожидаемом манифесте, — лишние файлы в каталоге ошибкой не считаются.

Манифест генерируется тем же модулем как отдельной командой:

```bash
python -m sglang.srt.utils.model_file_verifier generate --model-path /models/Qwen3-30B-A3B --model-checksum /models/Qwen3-30B-A3B/checksums.json
```

## Значения и формат

- **Путь к JSON** — проверка полностью локальная и офлайн. Это единственный режим без сетевых обращений.
- **HF repo ID** — суммы тянутся из Hub; нужна сеть и доступ к репозиторию.
- **Без значения** — источником становится `--model-path`. Осмысленно только когда `--model-path` и есть repo ID: для локального каталога `_load_checksums` не найдет файла и уйдет в HF с путем в качестве repo ID, что закончится ошибкой обращения к Hub.
- Значение из одного пробела или другой «пустой» строки поведет себя как заданное значение, а не как `const` — пишите либо флаг без значения, либо осмысленный источник.
- Хеш — SHA256 полного файла; размеры сверяются только в тексте ошибки, а решение принимается по хешу.

## Когда использовать

- Модель приехала по ненадежному каналу (сетевая ФС, копия с другого хоста, ручной rsync) — самый частый реальный случай.
- Инцидент «модель отвечает мусором»: проверка отличает битые веса от проблем конфигурации за один запуск.
- Регулярно на проде, если чекпоинт лежит на общем хранилище, которое кто-то может изменить.
- Не включайте по умолчанию на каждом старте локального инстанса: полное хеширование сотен гигабайт заметно удлиняет запуск.
- Не рассчитывайте на проверку с `--load-format gguf`, `bitsandbytes`, `sharded_state` и прочими не-`Default` загрузчиками: вызова `verify` там нет.

## Влияние на производительность и память

- Время старта растет на чтение **всех** перечисленных файлов и их хеширование в 4 потока — практически это чтение всего чекпоинта с диска до загрузки весов.
- RAM: хеширование потоковое, заметного расхода нет; при HF-источнике без готовых LFS-хешей файл скачивается целиком, и вот это уже дорого.
- На VRAM и на работу после старта не влияет.

## Взаимодействие с другими аргументами

- `--model-path`: каталог, который проверяется (уже разрешенный и, при необходимости, скачанный).
- `--download-dir`: проверка идет над скачанным туда снапшотом.
- `--load-format`: определяет, вызовется ли проверка вообще (только `Default`-семейство и `runai_streamer`).
- `--revision`: влияет на то, какой снапшот скачан; сам манифест из HF берется по repo ID без учета revision.
- `--delete-ckpt-after-loading`: сначала проверка, потом загрузка, потом удаление — порядок гарантирован тем, что удаление происходит уже после старта HTTP-сервера.

## Типовые проблемы и диагностика

- `IntegrityError: Integrity check failed: model-00003-of-00015.safetensors: mismatch (expected=… size=…, actual=… size=…)` — файл поврежден или подменен.
- `IntegrityError: … missing (expected size=…)` — файла нет в каталоге; частая причина — неполное скачивание.
- `IntegrityError: No files found in HF repo …` — repo ID неверный или нет доступа.
- Флаг передан без значения на локальном каталоге, и старт падает на обращении к Hub — задайте путь к JSON-манифесту.
- Успешную проверку подтверждает строка `[ModelFileVerifier] All N files verified successfully.` (печатается через `print`, а не через логгер — ищите ее в stdout).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --model-checksum /models/Qwen3-30B-A3B/checksums.json
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-30B-A3B --download-dir /data/hf-weights --model-checksum Qwen/Qwen3-30B-A3B
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/model_file_verifier.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
