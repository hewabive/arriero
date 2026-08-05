---
schema: 1
primaryName: "--xtc-probability"
title: "--xtc-probability"
summary: "Задает вероятность срабатывания XTC sampler-а на каждом шаге. `0.0` отключает XTC; для работы также нужен активный sampler `xtc` и порог `--xtc-threshold <= 0.5`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--xtc-probability"
allowedValues: []
env: []
related:
  - "--xtc-threshold"
  - "--samplers"
  - "--seed"
---

# --xtc-probability

## Кратко

`--xtc-probability` управляет шансом, что XTC sampler на текущем токене удалит часть самых вероятных кандидатов. Значение не является порогом вероятности токена; это вероятность запуска самого XTC-процесса.

## Оригинальная справка llama.cpp

```text
xtc probability (default: 0.00, 0.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--xtc-probability`
- Поле в `common_params`: `params.sampling.xtc_probability`
- HTTP-поле: `xtc_probability`
- Значение по умолчанию: `0.00`
- Отключение: `0.0` или меньше.

## Что меняет в llama-server

CLI-парсер записывает float и выставляет user sampling bit, поэтому metadata `general.sampling.xtc_probability` не перезапишет CLI-значение. XTC создается как `llama_sampler_init_xtc(probability, threshold, min_keep, seed)`.

В стандартной цепочке `xtc` идет после `min_p` и перед `temperature`. Он использует собственный RNG, инициализированный тем же `--seed`.

## Значения и формат

- `0.0` - XTC отключен.
- `0.1` - XTC срабатывает примерно на 10% шагов.
- `1.0` - XTC пытается сработать на каждом шаге.
- `< 0` - отключено по реализации.

Даже при срабатывании XTC может ничего не удалить, если условия по `--xtc-threshold`, числу кандидатов и `min_keep` не выполняются.

## Когда использовать

- Для творческой генерации, когда нужно иногда избегать самых очевидных продолжений.
- Не используйте как первый способ стабилизации модели; начните с `--temp`, `--top-p`, `--min-p`.
- На публичном API задавайте умеренные дефолты, потому что высокий XTC может заметно менять стиль ответов.

## Влияние на производительность и память

Память не меняется. При активном XTC выполняется random check, softmax и перестановка candidate array. Backend hooks для XTC в текущей реализации нет, поэтому активный XTC снижает пользу `--backend-sampling`.

## Взаимодействие с другими аргументами

- `--xtc-threshold > 0.5` отключает XTC независимо от probability.
- `--samplers` должен содержать `xtc`, а `--sampler-seq` - `x`.
- `--seed` влияет на RNG XTC и на финальный `dist`.
- `min_keep` из HTTP-запроса может помешать XTC удалить слишком много кандидатов.

## INI-пресеты и router-режим

Ключ INI:

```ini
[creative]
xtc-probability = 0.2
xtc-threshold = 0.1
```

В router presets параметр разрешен как sampling option. В HTTP используйте `"xtc_probability"`.

## Типовые проблемы и диагностика

- XTC не работает: `xtc_probability <= 0`, `xtc_threshold > 0.5` или в цепочке нет `xtc`.
- Ответы стали странно избегать очевидных слов: уменьшите `--xtc-probability` или отключите XTC.
- В trace-логе `?xtc` означает пустой sampler.

## Примеры

```bash
llama-server --model /models/model.gguf --xtc-probability 0.2 --xtc-threshold 0.1
```

```bash
llama-server --model /models/model.gguf --xtc-probability 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/tools/server/server-task.cpp`
