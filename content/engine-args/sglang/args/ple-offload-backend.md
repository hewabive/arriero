---
schema: 1
engine: sglang
primaryName: "--ple-offload-backend"
title: "--ple-offload-backend"
summary: Выбирает host-хранилище для выгруженной PLE n-gram таблицы Qwen4. Файловый режим рассчитан на устройства с общей памятью CPU и GPU.
group: exec.offload
related:
  - --ple-offload-embedding
  - --ple-offload-dir
---

# --ple-offload-backend

## Кратко

Выбирает host-хранилище для выгруженной PLE n-gram таблицы Qwen4. Файловый режим рассчитан на устройства с общей памятью CPU и GPU.

## Оригинальная справка

```text
Host storage for the offloaded Qwen4 PLE n-gram table. 'pinned' (default) uses CPU pinned memory. 'file' maps a sparse file under --ple-offload-dir and lets the gather kernel read it directly; use it on unified-memory devices (e.g. GB10 / DGX Spark) where pinned host memory comes out of the same pool as the model weights. Requires a device that reports cudaDevAttrPageableMemoryAccessUsesHostPageTables.
```

## Паспорт аргумента

- Флаги: `--ple-offload-backend`
- Группа: `exec.offload`
- Тип: `str`
- Значение в декларации по умолчанию: `pinned`
- Объявление: `ServerArgs.ple_offload_backend` в `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

При загрузке Qwen4-Exp выбор передаётся в PLE embedding. `pinned` держит таблицу в закреплённой памяти CPU; `file` отображает разреженный файл и даёт gather kernel читать его напрямую.

## Значения и формат

`pinned` по умолчанию; `file` требует устройства с `cudaDevAttrPageableMemoryAccessUsesHostPageTables` и каталог из `--ple-offload-dir`.

## Когда использовать

Рассматривайте `file` на GB10/DGX Spark, когда pinned host memory конкурирует с весами за общий пул; располагайте файл на быстром локальном NVMe.

## Влияние на производительность и память

`file` переносит давление с host RAM на файловое хранилище, но может увеличить задержку чтения. Разреженный файл сохраняется между запусками.

## Взаимодействие с другими аргументами

`file` требует включённого `--ple-offload-embedding`; `--cpu-offload-gb` и `--offload-group-size` с PLE offload несовместимы.

## Типовые проблемы и диагностика

При отключённом PLE флаг `file` вызывает `ValueError` на старте. При проблемах доступа проверьте файловую систему, свободное место и поддержку host page tables устройством.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --ple-offload-embedding --ple-offload-backend file --ple-offload-dir /fast/ple
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/memory_hook.py`
- `sglang/python/sglang/srt/models/qwen4_exp.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
