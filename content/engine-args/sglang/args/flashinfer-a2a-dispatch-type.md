---
schema: 1
engine: sglang
primaryName: "--flashinfer-a2a-dispatch-type"
title: "--flashinfer-a2a-dispatch-type"
summary: Задаёт формат активаций для FlashInfer all-to-all диспетчера MoE. Автовыбор зависит от квантизации экспертов.
group: exec.moe
related:
  - --moe-a2a-backend
  - --moe-runner-backend
  - --quantization
---

# --flashinfer-a2a-dispatch-type

## Кратко

Задаёт формат активаций для FlashInfer all-to-all диспетчера MoE. Автовыбор зависит от квантизации экспертов.

## Оригинальная справка

```text
Select FlashInfer A2A dispatcher activation dtype.
```

## Паспорт аргумента

- Флаги: `--flashinfer-a2a-dispatch-type`
- Группа: `exec.moe`
- Тип: `enum`
- Значение в декларации по умолчанию: `null`
- Объявление: `ServerArgs.flashinfer_a2a_dispatch_type` в `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

`handle_flashinfer_a2a_dispatch_type` превращает пустое/`auto` значение в `mxfp8` для MXFP8, `nvfp4` для FP4-MoE и `bf16` в остальных случаях. Диспетчер FlashInfer читает уже разрешённый формат.

## Значения и формат

`auto`, `bf16`, `nvfp4`, `mxfp8`; отсутствие флага эквивалентно автоматическому подбору при FlashInfer A2A.

## Когда использовать

Фиксируйте формат только при диагностике совместимости и после проверки квантизации модели.

## Влияние на производительность и память

Формат передаваемых активаций меняет объём коммуникации и стоимость преобразования; VRAM модели сам флаг не резервирует.

## Взаимодействие с другими аргументами

`mxfp8` требует `--quantization mxfp8` и `--moe-runner-backend flashinfer_trtllm_routed`; `nvfp4` требует FP4 MoE. Переменная `SGLANG_MOE_NVFP4_DISPATCH` конфликтует с этим флагом.

## Типовые проблемы и диагностика

Несовместимое сочетание останавливает запуск с `ValueError`, где названо требование к quantization/backend. Проверьте разрешённое значение в `server_args`.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --moe-a2a-backend flashinfer --flashinfer-a2a-dispatch-type auto
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/moe_hook.py`
- `sglang/python/sglang/srt/layers/moe/token_dispatcher/flashinfer.py`
