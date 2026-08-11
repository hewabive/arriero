---
schema: 1
engine: sglang
primaryName: "--revision"
title: "--revision"
summary: Ветка, тег или commit id модели на Hugging Face. Действует только когда `--model-path` — это repo id: для локального каталога значение игнорируется на всех путях загрузки.
group: model
related:
  - --model-path
  - --tokenizer-path
  - --download-dir
  - --trust-remote-code
  - --speculative-draft-model-revision
  - --weight-cache-mode
  - --model-checksum
---

# --revision

## Кратко

`--revision` — это HuggingFace-ревизия: имя ветки, тег или полный commit id репозитория модели. Она передается во все обращения к Hub — чтение `config.json`, скачивание весов, загрузка токенизатора и процессора, резолв динамических модулей при `--trust-remote-code`. Ключевая практическая деталь: если `--model-path` указывает на существующий локальный каталог, ревизия не применяется нигде — путь используется как есть, и молча запустится то, что лежит на диске.

## Оригинальная справка

```text
The specific model version to use. It can be a branch name, a tag name, or a commit id. If unspecified, will use the default version.
```

## Паспорт аргумента

- Флаги: `--revision`
- Группа: `model`
- Тип значения: строка (`Optional[str]`)
- Допустимые значения: не ограничены `choices`; на стороне Hub это имя ветки, тег или commit id
- Значение по умолчанию: `null` — ревизия по умолчанию репозитория (обычно `main`)
- Эффективное значение: не переопределяется. Косвенное следствие есть у драфт-модели: когда `--speculative-draft-model-path` не задан и драфт-веса лежат в самом целевом чекпойнте, спекулятивный hook подставляет `speculative_draft_model_path = model_path` и вместе с ним `speculative_draft_model_revision = revision`; в ModelScope-пути драфт скачивается по `speculative_draft_model_revision or "main"`
- Где объявлен: `ServerArgs.revision`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение `ModelConfig` (чтение конфига), скачивание весов в `DefaultModelLoader._prepare_weights`, инициализация токенизатора/процессора, `__post_init__` при `SGLANG_USE_MODELSCOPE`

## Что меняет в движке

Значение расходится по трем группам потребителей:

1. **Конфиг модели.** `ModelConfig.from_server_args` передает `revision=model_revision or server_args.revision` в `ModelConfig`, оттуда — в `get_config(...)` и `get_generation_config(...)` (`sglang/python/sglang/srt/utils/hf_transformers/`). При `--trust-remote-code` та же ревизия уходит как `code_revision` в резолв класса токенизатора из `auto_map`, то есть определяет, **какая версия кода** будет исполнена.
2. **Веса.** `DefaultModelLoader._prepare_weights` вызывает `download_weights_from_hf(model_name_or_path, download_dir, allow_patterns, revision, ...)`. Первая же строка этой функции — `if os.path.isdir(model_name_or_path): return model_name_or_path`, то есть локальный каталог возвращается без единого обращения к Hub. То же самое делает и `_find_local_hf_snapshot_dir_unlocked` для валидного кеша.
3. **Токенизатор и процессор.** `TpModelWorker` и `TokenizerManager` передают `revision=server_args.revision` в `get_tokenizer`/`get_processor`; PD-развертывание (encode-сервер и receiver) делает то же самое.

Отдельно ревизия участвует в отпечатке IPC-кеша весов: `CacheConfig.revision` заполняется как `model_config.revision or ""`, и несовпадение ревизии между демоном и клиентом даст отказ подключения, а не тихую подмену весов (`sglang/python/sglang/srt/weight_cache/ipc_loader.py`). Инженерно это важно: движок явно считает ревизию частью идентичности весов.

При `SGLANG_USE_MODELSCOPE` ревизия используется в `_handle_modelscope_paths` для `snapshot_download` модели и токенизатора.

При `--weight-cache-mode daemon` значение добавляется в командную строку каждого порожденного демона.

## Значения и формат

- Имя ветки (`main`, `refs/pr/3`), тег или commit id. Валидация целиком на стороне huggingface_hub: неизвестная ревизия даст ошибку сети/репозитория, а не понятное сообщение SGLang.
- Пустая строка не эквивалентна «не задано» на уровне argparse — она попадет в поле как есть; используйте отсутствие флага.
- **Локальный каталог — значение игнорируется.** Это самая частая ловушка: `--model-path /models/Qwen3-30B-A3B --revision abc123` не сделает ничего, кроме записи строки в `server_args`. Никакого предупреждения не будет.
- Для воспроизводимости на локальных каталогах есть отдельный механизм — `--model-checksum` (проверка файлов чекпойнта в `_prepare_weights`), а не ревизия.

## Когда использовать

- `--model-path` задан как repo id (`org/model`), и нужно зафиксировать конкретный коммит вместо плавающего `main` — единственный сценарий, где флаг реально работает.
- Нужно откатиться на предыдущую ревизию репозитория после того, как автор поломал чекпойнт, не меняя команду запуска в остальном.
- Не задавайте на локальном каталоге: значение будет ложно выглядеть как фиксация версии.
- Не используйте как способ управлять кешем: каталог кеша задается `--download-dir` (и переменными окружения HuggingFace), ревизия лишь выбирает снапшот внутри него.

## Влияние на производительность и память

На память и скорость инференса не влияет. На время старта влияет только косвенно: смена ревизии для repo id означает скачивание другого снапшота, то есть полный сетевой холодный старт вместо попадания в локальный кеш.

## Взаимодействие с другими аргументами

- `--model-path`: определяет, применится ли ревизия вообще (repo id — да, локальный каталог — нет).
- `--tokenizer-path`: токенизатор загружается с той же ревизией; отдельного `--tokenizer-revision` в CLI нет.
- `--download-dir`: куда складывается снапшот выбранной ревизии.
- `--speculative-draft-model-revision`: наследует значение `--revision` в том случае, когда путь драфт-модели автоматически приравнивается к `--model-path` (драфт бандлится в целевом чекпойнте).
- `--trust-remote-code`: ревизия определяет версию исполняемого кода чекпойнта. Плавающая ветка вместе с доверием коду означает, что содержимое исполняемого кода может измениться между двумя рестартами.
- `--weight-cache-mode`: ревизия входит в `CacheConfig`, и ее несовпадение — законная причина отказа IPC-подключения.
- `--model-checksum`: рабочая альтернатива для фиксации содержимого локального каталога.

## Типовые проблемы и диагностика

- «Задал ревизию, а запустилась старая модель» — почти всегда `--model-path` указывает на локальный каталог. Проверьте: если путь существует на диске, ревизия не применяется.
- `RepositoryNotFoundError` / `RevisionNotFoundError` из huggingface_hub на старте — опечатка в ревизии или отсутствие доступа к приватному репозиторию.
- `[IpcModelLoader] Weight cache not available or config mismatch, falling back to disk load` при `--weight-cache-mode client` — среди прочих причин может быть несовпадение ревизии между демоном и движком.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`); фактически использованный локальный каталог виден в строках загрузки весов.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-8B --revision refs/pr/1 --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-8B --revision 0e9e39f249a16976918f6564b8830bc894c89659 --download-dir /models/hf-cache --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/utils/hf_transformers/config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/tokenizer.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/weight_cache/ipc_loader.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
