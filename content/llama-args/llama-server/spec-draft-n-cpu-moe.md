---
schema: 1
primaryName: "--spec-draft-n-cpu-moe"
title: "--spec-draft-n-cpu-moe"
summary: "Оставляет MoE expert tensor первых N слоев draft-модели на CPU. Полезно для частичной экономии VRAM без полного CPU-размещения всех experts."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-draft-n-cpu-moe"
  - "--spec-draft-ncmoe"
  - "-ncmoed"
  - "--n-cpu-moe-draft"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_N_CPU_MOE"
related:
  - "--n-cpu-moe"
  - "--spec-draft-cpu-moe"
  - "--spec-draft-override-tensor"
  - "--spec-draft-ngl"
---

# --spec-draft-n-cpu-moe

## Кратко

`--spec-draft-n-cpu-moe N` оставляет expert weights первых `N` MoE-слоев draft-модели на CPU. Обработчик добавляет по одному tensor buffer override для `blk.0...`, `blk.1...` и так далее до `blk.N-1...`.

Это числовой аргумент, не флаг. Отрицательные значения запрещены.

## Оригинальная справка llama.cpp

```text
keep the Mixture of Experts (MoE) weights of the first N layers in the CPU for the draft model
```

## Паспорт аргумента

- Основное имя: `--spec-draft-n-cpu-moe`
- Алиасы: `--spec-draft-n-cpu-moe`, `--spec-draft-ncmoe`, `-ncmoed`, `--n-cpu-moe-draft`
- Значение: целое `N >= 0`
- Структура llama.cpp: `common_params.speculative.draft.tensor_buft_overrides`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_N_CPU_MOE`
- Ошибка для отрицательного значения: `invalid value`

## Что меняет в llama-server

Для каждого `i` от `0` до `N - 1` код создает pattern `blk\\.i\\.ffn_(up|down|gate|gate_up)_(ch|)exps` и направляет совпавшие tensor в CPU buffer. При загрузке draft-модели эти overrides передаются в `params_dft.tensor_buft_overrides`.

Если `N = 0`, цикл не добавляет правил и аргумент фактически ничего не меняет.

## Значения и формат

Значение парсится через `std::stoi()`. Дробные строки и нечисловые значения приведут к ошибке парсинга аргумента. Слишком большое N не валидируется по числу слоев: лишние patterns просто не совпадут с tensor.

## Когда использовать

Используйте, если полный `--spec-draft-cpu-moe` слишком сильно замедляет draft, но VRAM все равно нужно сэкономить. Увеличивайте N постепенно и сравнивайте VRAM/latency.

## Влияние на производительность и память

Чем больше N, тем меньше VRAM занимают MoE experts draft-модели и тем больше CPU/RAM нагрузки. Небольшое N может быть компромиссом, если первые слои дают достаточную экономию или если backend размещает блоки неравномерно.

## Взаимодействие с другими аргументами

`--spec-draft-cpu-moe` покрывает все MoE experts и обычно делает этот аргумент избыточным. `--spec-draft-override-tensor` можно использовать для более точного набора слоев. Target-модель управляется отдельным `--n-cpu-moe`.

## INI-пресеты и router-режим

В INI используйте `n-cpu-moe-draft = 8` или `spec-draft-n-cpu-moe = 8`. Значение `0` можно использовать как явное "не добавлять partial MoE CPU override", но проще не задавать ключ.

## Типовые проблемы и диагностика

- `invalid value`: N отрицательное.
- VRAM не меняется: draft-модель не MoE, N попал в несуществующие слои или tensor names отличаются.
- Draft latency выросла: уменьшите N или верните experts на GPU.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/moe-draft.gguf --spec-type draft-simple --spec-draft-ngl all --spec-draft-n-cpu-moe 8
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
