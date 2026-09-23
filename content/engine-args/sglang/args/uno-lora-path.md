---
schema: 1
engine: sglang
primaryName: "--uno-lora-path"
title: "--uno-lora-path"
summary: Задаёт путь к draft LoRA checkpoint для алгоритма UNO. Путь обязателен при выборе UNO и загружается при инициализации draft worker.
group: spec
related:
  - --speculative-algorithm
  - --speculative-draft-model-path
---

# --uno-lora-path

## Кратко

Задаёт путь к draft LoRA checkpoint для алгоритма UNO. Путь обязателен при выборе UNO и загружается при инициализации draft worker.

## Оригинальная справка

```text
Path to the UNO draft LoRA checkpoint.
```

## Паспорт аргумента

- Флаги: `--uno-lora-path`
- Группа: `spec`
- Тип: `str`
- Значение в декларации по умолчанию: `null`
- Объявление: `ServerArgs.uno_lora_path` в `sglang/python/sglang/srt/arg_groups/fields/spec.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

UNO использует ту же базовую модель и закрепляет внутренний LoRA-адаптер `__uno_draft__` в пуле вместе с базовым слотом. Этот адаптер не предлагается клиентам как выбираемый serving LoRA.

## Значения и формат

Путь к локальному или поддерживаемому загрузчиком LoRA checkpoint; по умолчанию отсутствует.

## Когда использовать

Задавайте только вместе с `--speculative-algorithm UNO` и соответствующим обученным draft LoRA.

## Влияние на производительность и память

Дополнительный адаптер и draft CUDA graphs расходуют VRAM и время запуска; цель — ускорение decode при достаточном acceptance rate.

## Взаимодействие с другими аргументами

UNO работает только на CUDA, не принимает `--speculative-draft-model-path`, `--enable-deterministic-inference` и `--enable-strict-thinking`.

## Типовые проблемы и диагностика

Без пути UNO останавливает старт с `UNO requires --uno-lora-path`; несовместимые флаги также дают явный `ValueError`.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --speculative-algorithm UNO --uno-lora-path <adapter-path>
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/spec.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/uno_lora.py`
