---
schema: 1
primaryName: "--spm-infill"
title: "--spm-infill"
summary: "Переключает порядок FIM prompt для `/infill` с Prefix/Suffix/Middle на Suffix/Prefix/Middle. Нужен отдельным infill-моделям, обученным на SPM pattern."
category: "Параметры llama-server"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--spm-infill"
allowedValues: []
env: []
related:
  - "--fim-qwen-1.5b-default"
  - "--fim-qwen-3b-default"
  - "--fim-qwen-7b-default"
---

# --spm-infill

## Кратко

`--spm-infill` ставит `common_params::spm_infill = true`. В endpoint `/infill` это меняет порядок частей FIM prompt: вместо prefix затем suffix server подает suffix затем prefix перед `FIM_MID`.

Флаг влияет только на infill formatting, а не на обычный chat/completion.

## Оригинальная справка llama.cpp

```text
use Suffix/Prefix/Middle pattern for infill (instead of Prefix/Suffix/Middle) as some models prefer this. (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--spm-infill`
- Тип: флаг без значения
- Поле `common_params`: `spm_infill`
- По умолчанию: disabled
- Этап применения: formatting `/infill` request
- Env: не задан

## Что меняет в llama-server

В `format_prompt_infill()` server tokenizes `input_prefix` и `input_suffix`, добавляет FIM tokens и затем выбирает:

- default: `embd_inp = tokens_prefix`, `embd_end = tokens_suffix`;
- с `--spm-infill`: `embd_inp = tokens_suffix`, `embd_end = tokens_prefix`.

После этого добавляется `FIM_MID`. Если tokenizer имеет repo-level FIM tokens, extra context добавляется перед FIM prefix по README pattern.

## Значения и формат

Флаг без значения:

```bash
llama-server --model /models/infill.gguf --spm-infill
```

Отрицательной формы в `arg.cpp` нет; чтобы выключить, уберите флаг.

## Когда использовать

Используйте только с моделями, для которых известно, что они ожидают Suffix/Prefix/Middle порядок. Если модель обучена на стандартном Prefix/Suffix/Middle, включение `--spm-infill` ухудшит infill.

## Влияние на производительность и память

На память и скорость почти не влияет: меняется порядок уже токенизированных частей prompt. Качество и вероятность корректного заполнения могут измениться существенно.

## Взаимодействие с другими аргументами

- FIM default presets могут требовать отдельного подбора этого флага.
- `--batch-size`, `--ctx-size`, `--predict`: влияют на то, сколько prefix/suffix/extra context попадет в infill prompt.
- `/infill` request fields `input_prefix`, `input_suffix`, `input_extra`, `prompt` определяют содержимое частей.

## INI-пресеты и router-режим

В INI используйте `spm-infill = true` в секции infill-модели. В router mode не включайте глобально для всех моделей: порядок FIM является model-specific.

## Типовые проблемы и диагностика

- Infill вставляет нерелевантный код: проверьте, соответствует ли `--spm-infill` training pattern модели.
- Endpoint `/infill` отвечает `Infill is not supported by this model`: проблема не в `--spm-infill`, а в отсутствии нужных FIM tokens/поддержки.
- Смотрите debug log `n_prefix_take`, `n_suffix_take`, `total` для проверки, сколько контекста попало в prompt.

## Примеры

```bash
llama-server --model /models/qwen-infill.gguf --spm-infill
```

## Источники

- `llama.cpp/common/arg.cpp`: `--spm-infill`.
- `llama.cpp/common/common.h`: `common_params::spm_infill`.
- `llama.cpp/tools/server/server-common.cpp`: `format_prompt_infill()`.
- `llama.cpp/tools/server/README.md`: `/infill` prompt pattern.
