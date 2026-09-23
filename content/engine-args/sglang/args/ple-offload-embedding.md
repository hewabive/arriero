---
schema: 1
engine: sglang
primaryName: "--ple-offload-embedding"
title: "--ple-offload-embedding"
summary: Выгружает n-gram embedding Qwen4 PLE в host memory. Для BF16 Qwen4-Exp на CUDA включается автоматически, если флаг не задан.
group: exec.offload
related:
  - --ple-offload-backend
  - --cpu-offload-gb
  - --offload-group-size
---

# --ple-offload-embedding

## Кратко

Выгружает n-gram embedding Qwen4 PLE в host memory. Для BF16 Qwen4-Exp на CUDA включается автоматически, если флаг не задан.

## Оригинальная справка

```text
Offload Qwen4 PLE n-gram embedding weights to CPU pinned memory. Enabled by default for BF16 Qwen4-Exp on CUDA; use --no-ple-offload-embedding to disable.
```

## Паспорт аргумента

- Флаги: `--ple-offload-embedding`, `--no-ple-offload-embedding`
- Группа: `exec.offload`
- Тип: `bool`
- Значение в декларации по умолчанию: `null`
- Объявление: `ServerArgs.ple_offload_embedding` в `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

Модельный override выставляет значение по архитектуре, платформе и dtype; загрузчик передаёт его в Qwen4-Exp. При включении PLE-таблица живёт вне обычного GPU-резидентного пути.

## Значения и формат

Пара `--ple-offload-embedding` / `--no-ple-offload-embedding`; отсутствие обоих оставляет модельный автовыбор.

## Когда использовать

Сохраняйте автовыбор для BF16 Qwen4-Exp. Выключайте явно только после проверки, что GPU-памяти достаточно для PLE-таблицы.

## Влияние на производительность и память

Снижает VRAM ценой использования host memory и возможной задержки доступа; фактический эффект зависит от backend и железа.

## Взаимодействие с другими аргументами

Несовместим с `--cpu-offload-gb` и `--offload-group-size`. Файловый `--ple-offload-backend file` требует включённого PLE offload.

## Типовые проблемы и диагностика

При несовместимом generic offload запуск завершается `ValueError`. Сверьте итоговое значение в `server_args` после модельного override.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --ple-offload-embedding
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/model_overrides/qwen4_exp.py`
- `sglang/python/sglang/srt/arg_groups/memory_hook.py`
- `sglang/python/sglang/srt/models/qwen4_exp.py`
