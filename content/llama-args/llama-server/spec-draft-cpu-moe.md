---
schema: 1
primaryName: "--spec-draft-cpu-moe"
title: "--spec-draft-cpu-moe"
summary: "Оставляет все MoE expert tensor draft-модели на CPU. Это shorthand поверх tensor buffer override для экономии VRAM на MoE draft-моделях."
category: "Параметры speculative decoding"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--spec-draft-cpu-moe"
  - "-cmoed"
  - "--cpu-moe-draft"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_CPU_MOE"
related:
  - "--cpu-moe"
  - "--spec-draft-n-cpu-moe"
  - "--spec-draft-override-tensor"
  - "--spec-draft-ngl"
---

# --spec-draft-cpu-moe

## Кратко

`--spec-draft-cpu-moe` оставляет все Mixture of Experts weights draft-модели на CPU. Обработчик добавляет в `common_params.speculative.draft.tensor_buft_overrides` override `LLM_FFN_EXPS_REGEX -> ggml_backend_cpu_buffer_type()`.

Флаг не принимает отдельного значения. Для основной target-модели есть отдельный `--cpu-moe`.

## Оригинальная справка llama.cpp

```text
keep all Mixture of Experts (MoE) weights in the CPU for the draft model
```

## Паспорт аргумента

- Основное имя: `--spec-draft-cpu-moe`
- Алиасы: `--spec-draft-cpu-moe`, `-cmoed`, `--cpu-moe-draft`
- Тип: флаг
- Структура llama.cpp: `common_params.speculative.draft.tensor_buft_overrides`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_CPU_MOE`
- Этап применения: парсинг CLI/env, затем загрузка draft-модели

## Что меняет в llama-server

Флаг добавляет правило для tensor, имена которых соответствуют `\\.ffn_(up|down|gate|gate_up)_(ch|)exps`. Это expert weights MoE-блоков. При загрузке draft-модели сервер передает эти overrides в `params_dft.tensor_buft_overrides`.

Если draft-модель не MoE, правило может просто не совпасть ни с одним tensor и практического эффекта не даст.

## Значения и формат

CLI-форма - только присутствие флага:

```text
--spec-draft-cpu-moe
```

Через env включается truthy-значением `LLAMA_ARG_SPEC_DRAFT_CPU_MOE=1`. Отрицательной CLI-формы для этого флага нет.

## Когда использовать

Используйте для MoE draft-моделей, если expert weights занимают слишком много VRAM или вытесняют target-модель. Это грубый, но простой способ снизить VRAM без ручных regex override.

Не включайте автоматически для всех моделей: CPU experts могут сделать draft существенно медленнее.

## Влияние на производительность и память

VRAM draft-модели уменьшается за счет хранения experts в RAM. Цена - CPU bandwidth и возможные transfer overhead. На MoE draft-модели с редкой активацией experts это может быть приемлемо; на маленькой dense draft-модели флаг бесполезен.

## Взаимодействие с другими аргументами

`--spec-draft-n-cpu-moe` делает похожее, но только для первых N слоев. `--spec-draft-override-tensor` позволяет задать собственные patterns. `--spec-draft-ngl all` и `--spec-draft-cpu-moe` могут использоваться вместе: общий offload отправляет слои на GPU, а MoE experts остаются на CPU.

## INI-пресеты и router-режим

В INI используйте `cpu-moe-draft = true` или `spec-draft-cpu-moe = true`. Для отключения в другом preset просто не задавайте флаг; парного `no-...` варианта в `arg.cpp` нет.

## Типовые проблемы и диагностика

- VRAM не изменилась: draft-модель не MoE или tensor names не совпали с regex текущего llama.cpp.
- Draft стал медленным: experts ушли на CPU; попробуйте `--spec-draft-n-cpu-moe` с меньшим N.
- Нужен такой же режим для target: используйте отдельный `--cpu-moe`.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/moe-draft.gguf --spec-type draft-simple --spec-draft-ngl all --spec-draft-cpu-moe
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
