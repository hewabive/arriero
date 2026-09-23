---
schema: 1
engine: sglang
primaryName: "--ple-offload-dir"
title: "--ple-offload-dir"
summary: Задаёт каталог для файловой PLE-таблицы Qwen4 при `--ple-offload-backend file`. Разреженный файл можно повторно использовать после перезапуска.
group: exec.offload
related:
  - --ple-offload-backend
  - --ple-offload-embedding
---

# --ple-offload-dir

## Кратко

Задаёт каталог для файловой PLE-таблицы Qwen4 при `--ple-offload-backend file`. Разреженный файл можно повторно использовать после перезапуска.

## Оригинальная справка

```text
Directory for the file-backed PLE table when --ple-offload-backend is 'file'. Defaults to $SGLANG_CACHE_DIR/ple/<model path>, one directory per checkpoint. The file is sparse and reused across restarts; put it on fast local storage (NVMe).
```

## Паспорт аргумента

- Флаги: `--ple-offload-dir`
- Группа: `exec.offload`
- Тип: `str`
- Значение в декларации по умолчанию: `null`
- Объявление: `ServerArgs.ple_offload_dir` в `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

Путь передаётся в загрузчик Qwen4-Exp и используется файловым PLE backend. Для каждого checkpoint создаётся своя таблица; при отсутствии флага каталог выводится из `SGLANG_CACHE_DIR/ple/<model path>`.

## Значения и формат

Локальный путь к каталогу на быстром диске. Значение `null` оставляет штатное расположение под cache dir.

## Когда использовать

Указывайте отдельный быстрый NVMe, если каталог кеша находится на медленном или малом разделе.

## Влияние на производительность и память

Таблица занимает файловое пространство по мере записи sparse-файла; задержка диска может влиять на генерацию. При pinned backend путь не используется.

## Взаимодействие с другими аргументами

Действует вместе с `--ple-offload-backend file` и включённым `--ple-offload-embedding`.

## Типовые проблемы и диагностика

Если таблица не создаётся или чтение медленное, проверьте права записи, свободное место и скорость выбранного каталога.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --ple-offload-embedding --ple-offload-backend file --ple-offload-dir /fast/ple
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/models/qwen4_exp.py`
