---
schema: 1
engine: sglang
primaryName: "--download-dir"
title: "--download-dir"
summary: Каталог кеша, куда скачиваются веса с Hugging Face (и ModelScope). На локальный `--model-path` не влияет вообще, и `config.json` с токенайзером туда не попадают — они идут в стандартный HF-кеш.
group: model
related:
  - --model-path
  - --revision
  - --load-format
  - --model-checksum
  - --tokenizer-path
  - --delete-ckpt-after-loading
---

# --download-dir

## Кратко

`--download-dir` — это `cache_dir` для загрузки весов с HF Hub: он передается в `download_weights_from_hf` и в ModelScope-снапшоты. Ограничение, которое стоит знать заранее: конфигурация модели и токенайзер читаются через `AutoConfig.from_pretrained`/`AutoTokenizer` **без** этого параметра, то есть оседают в обычном HF-кеше (`HF_HOME`/`~/.cache/huggingface`). Поэтому `--download-dir` не изолирует загрузку целиком — он переносит только самую большую её часть.

## Оригинальная справка

```text
Model download directory for huggingface.
```

## Паспорт аргумента

- Флаги: `--download-dir`
- Группа: `model`
- Тип значения: строка — путь к каталогу
- Допустимые значения: не ограничены; каталог создается библиотекой HF при необходимости
- Значение по умолчанию: `null` — используются дефолты `huggingface_hub`
- Эффективное значение: не переопределяется движком
- Где объявлен: `ServerArgs.download_dir`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (только для ModelScope) и загрузка весов в каждом воркере

## Что меняет в движке

Значение копируется в `LoadConfig.download_dir` и используется в трех местах:

1. `DefaultModelLoader._prepare_weights` → `download_weights_from_hf(model_name_or_path, cache_dir=self.load_config.download_dir, …)`. Если `--model-path` — существующий локальный каталог, функция возвращает его сразу и `--download-dir` не участвует вообще.
2. `RunaiModelStreamerLoader._prepare_weights` — то же самое для safetensors-паттерна.
3. `_handle_modelscope_paths` в `__post_init__` (только при `SGLANG_USE_MODELSCOPE=1`): сначала ищет модель в `os.path.join(download_dir, path)`, затем передает `cache_dir=download_dir` в `snapshot_download`.

Кроме того, `np_cache_weights_iterator` при `--load-format npcache` кладет свой numpy-кеш относительно того же каталога.

## Значения и формат

- Абсолютный путь предпочтителен: относительный будет разрешаться от рабочего каталога процесса, а он у супервизора не тот, что у вас в терминале.
- Каталог должен быть записываемым процессом сервера и иметь место под всю модель — при `--tp-size N` скачивание происходит один раз, но параллельные воркеры используют общий файловый лок (`get_lock(model_name_or_path, cache_dir)`).
- Пустая строка формально пройдет argparse, но приведет к записи в текущий каталог — не делайте так.
- Структура внутри — стандартная структура кеша `huggingface_hub` (`models--org--name/snapshots/<sha>/…`), а не «просто файлы модели».

## Когда использовать

- Когда модели должны лежать на отдельном большом диске, а домашний раздел маленький.
- Когда несколько инстансов должны переиспользовать один кеш весов.
- Когда нужно контролировать место: удалять старые снапшоты вручную.
- Не нужен, если `--model-path` — локальный каталог: аргумент в этом случае полностью инертен.
- Если задача — вынести **весь** HF-кеш (конфиги, токенайзеры, датасеты), правильный инструмент — переменная окружения `HF_HOME`, а не этот флаг.

## Влияние на производительность и память

- На VRAM не влияет.
- На время старта влияет решающим образом при первом запуске с HF repo ID: скачивание идет внутри процесса запуска, без отдельного таймаута.
- Диск: каталог должен вмещать полный чекпоинт; при `npcache` — плюс numpy-кеш сопоставимого размера.
- Скорость чтения весов после скачивания определяется тем, на каком носителе лежит этот каталог, — это единственный устойчивый эффект аргумента на последующие запуски.

## Взаимодействие с другими аргументами

- `--model-path`: если это локальный каталог, аргумент не используется. Смысл появляется только для HF repo ID (или ModelScope-идентификатора).
- `--revision`: определяет, какой снапшот скачивается в этот каталог.
- `--load-format`: `npcache` кладет туда же свой кеш; `runai_streamer` использует его для safetensors; `gguf`/`dummy` не используют.
- `--model-checksum`: верификация запускается уже над разрешенным каталогом (скачанным сюда).
- `--delete-ckpt-after-loading`: удаляет `--model-path`, а не этот каталог; для скачанной модели `model_path` остается repo ID, и удаление кеша так не произойдет.
- `--tokenizer-path`: токенайзер скачивается стандартным путем HF, мимо `--download-dir`.

## Типовые проблемы и диагностика

- Место кончилось на системном разделе, хотя `--download-dir` задан — сюда попали конфиги/токенайзер (они идут в HF-кеш) либо путь оказался относительным.
- `PermissionError` при скачивании — каталог недоступен на запись пользователю, под которым запущен сервер.
- Модель качается заново при каждом старте — каталог не переживает перезапуск (tmpfs, контейнер без volume) либо меняется `--revision`.
- Строка `Using model weights format ['*.safetensors']` в логе означает, что скачивание началось; фактический путь после разрешения виден в дампе `server_args=` (для ModelScope он уже локальный).

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-30B-A3B --download-dir /data/hf-weights --served-model-name qwen3-30b
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-30B-A3B --download-dir /data/hf-weights --revision main --model-checksum Qwen/Qwen3-30B-A3B
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/utils/hf_transformers/config.py`
