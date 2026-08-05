---
schema: 1
primaryName: "--xtc-threshold"
title: "--xtc-threshold"
summary: "Порог XTC sampler-а: кандидаты с вероятностью не ниже threshold считаются слишком очевидными и могут быть удалены при срабатывании XTC. Значения выше `0.5` отключают XTC в реализации."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--xtc-threshold"
allowedValues: []
env: []
related:
  - "--xtc-probability"
  - "--min-p"
  - "--samplers"
---

# --xtc-threshold

## Кратко

`--xtc-threshold` задает минимальную вероятность токена, при которой XTC считает верхние кандидаты достаточно вероятными для удаления. Параметр работает только вместе с `--xtc-probability > 0` и sampler-ом `xtc`.

## Оригинальная справка llama.cpp

```text
xtc threshold (default: 0.10, 1.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--xtc-threshold`
- Поле в `common_params`: `params.sampling.xtc_threshold`
- HTTP-поле: `xtc_threshold`
- Значение по умолчанию: `0.10`
- Отключение в реализации: `> 0.5`. Help указывает `1.0 = disabled`, но код отключает все значения больше `0.5`.

## Что меняет в llama-server

CLI-парсер записывает float и выставляет user sampling bit, поэтому metadata `general.sampling.xtc_threshold` не перезапишет CLI-значение. При `threshold > 0.5` создается empty sampler `?xtc`.

Когда XTC срабатывает, он сортирует/softmax-ит кандидатов, находит верхний блок с `p >= threshold` и удаляет часть этих кандидатов, если остается достаточно токенов с учетом `min_keep`.

## Значения и формат

- `0.10` - дефолт.
- `0.05`-`0.20` - практический диапазон для экспериментов.
- `1.0` - отключение по help и по коду.
- `> 0.5` - отключение по коду.

Чем ниже threshold, тем больше верхних кандидатов может попасть в удаляемый блок при срабатывании XTC.

## Когда использовать

- Настраивайте только вместе с `--xtc-probability`.
- Уменьшайте осторожно: слишком низкий threshold может агрессивно отбрасывать хорошие токены.
- Для стабильных сервисных ответов обычно оставляйте XTC отключенным.

## Влияние на производительность и память

Память не меняется. Стоимость появляется только при активном XTC; backend support для XTC отсутствует в текущем sampler-е.

## Взаимодействие с другими аргументами

- `--xtc-probability` должен быть больше `0`.
- `--top-k`, `--top-p`, `--min-p` сужают кандидатов до XTC в стандартной цепочке.
- `--seed` делает RNG XTC воспроизводимым при фиксированном окружении.
- `--samplers` должен содержать `xtc`, `--sampler-seq` - `x`.

## INI-пресеты и router-режим

Ключ INI:

```ini
[creative]
xtc-threshold = 0.1
```

В HTTP используйте `"xtc_threshold"`. Router presets могут задавать этот параметр как sampling option.

## Типовые проблемы и диагностика

- `--xtc-threshold 1.0` не "делает XTC мягче", а отключает его.
- При `--xtc-threshold 0.6` XTC тоже отключен, хотя help упоминает только `1.0`.
- Trace `?xtc` указывает на отключенный XTC sampler.

## Примеры

```bash
llama-server --model /models/model.gguf --xtc-probability 0.15 --xtc-threshold 0.12
```

```bash
llama-server --model /models/model.gguf --xtc-probability 1.0 --xtc-threshold 1.0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/tools/server/server-task.cpp`
