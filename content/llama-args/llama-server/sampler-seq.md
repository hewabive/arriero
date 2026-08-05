---
schema: 1
primaryName: "--sampler-seq"
title: "--sampler-seq"
summary: "Короткая запись sampler-цепочки символами (`edskypmxt` по умолчанию). В текущем коде не выставляет user sampling bit, поэтому sequence из GGUF metadata может переопределить это значение при загрузке модели."
category: "Параметры сэмплинга"
valueType: "string"
estimation: "normal"
valueHint: "SEQUENCE"
aliases:
  - "--sampler-seq"
  - "--sampling-seq"
allowedValues: []
env: []
related:
  - "--samplers"
  - "--top-k"
  - "--top-p"
  - "--temp"
---

# --sampler-seq

## Кратко

`--sampler-seq` задает ту же sampler-цепочку, что `--samplers`, но компактной строкой символов. Дефолт `edskypmxt` соответствует `penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature`.

## Оригинальная справка llama.cpp

```text
simplified sequence for samplers that will be used (default: edskypmxt)
```

## Паспорт аргумента

- Основное имя: `--sampler-seq`
- Алиас: `--sampling-seq`
- Поле в `common_params`: `params.sampling.samplers`
- HTTP-строка в поле `samplers`: тот же формат символов.
- Дефолт: `edskypmxt`

## Символы

- `e` - `penalties`
- `d` - `dry`
- `s` - `top_n_sigma`
- `k` - `top_k`
- `y` - `typ_p`
- `p` - `top_p`
- `m` - `min_p`
- `x` - `xtc`
- `t` - `temperature`
- `i` - `infill`
- `a` - `adaptive_p`

Неизвестные символы не прерывают запуск, но логируются warning-ом `unable to match sampler by char` и пропускаются.

## Что меняет в llama-server

CLI-парсер преобразует строку через `common_sampler_types_from_chars(value)` и записывает результат в `params.sampling.samplers`. В отличие от `--samplers`, обработчик `--sampler-seq` в проверенном commit не выставляет `COMMON_PARAMS_SAMPLING_CONFIG_SAMPLERS`. Поэтому при загрузке модели `common_init_sampler_from_model()` может заменить sequence значением `general.sampling.sequence` из metadata GGUF.

Если важно гарантированно зафиксировать порядок, используйте `--samplers`.

## Когда использовать

- Для коротких локальных запусков, где нет риска metadata override.
- В HTTP-запросах, когда удобнее передать `"samplers": "kpmt"` вместо массива.
- Для быстрого удаления sampler-а из цепочки: например `kpmt` оставляет `top_k;top_p;min_p;temperature`.

## Влияние на производительность и память

Влияние определяется выбранными sampler-ами. Сама короткая форма не меняет память и не отличается по runtime от эквивалентного `--samplers`.

## Взаимодействие с другими аргументами

- Числовые параметры работают только если соответствующая буква есть в sequence.
- `a` включает `adaptive_p`, который будет добавлен в конец вместо финального `dist`.
- `--mirostat` игнорирует обычную sequence.
- `--backend-sampling` зависит от поддержки всех активных sampler-ов.

## INI-пресеты и router-режим

Ключ INI:

```ini
[short-chain]
sampler-seq = kpmt
```

Для router presets, где нужна защита от metadata sequence, предпочтительнее `samplers = ...`.

## Типовые проблемы и диагностика

- Sequence неожиданно другая после загрузки модели: проверьте metadata `general.sampling.sequence` и используйте `--samplers`.
- Опечатка в символе: ищите warning `unable to match sampler by char`.
- Нет эффекта от `--temp` или `--top-p`: проверьте наличие `t` или `p` в sequence.

## Примеры

```bash
llama-server --model /models/model.gguf --sampler-seq kpmt
```

```bash
llama-server --model /models/model.gguf --sampler-seq kpmta --adaptive-target 0.2
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/README.md`
