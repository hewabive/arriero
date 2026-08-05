---
schema: 1
primaryName: "--seed"
title: "--seed"
summary: "Задает seed RNG для sampler-ов `dist`, `xtc` и `adaptive_p`. Значение `-1` соответствует `LLAMA_DEFAULT_SEED` и дает случайный seed при инициализации sampler-а."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "SEED"
aliases:
  - "-s"
  - "--seed"
allowedValues: []
env: []
related:
  - "--temp"
  - "--samplers"
  - "--xtc-probability"
  - "--adaptive-target"
---

# --seed

## Кратко

`--seed` фиксирует RNG seed sampler-ов. Это необходимо для воспроизводимых сравнений, но не гарантирует бит-в-бит одинаковый результат при изменении backend-а, batch layout, sampler-цепочки, числа параллельных completions или версии llama.cpp.

## Оригинальная справка llama.cpp

```text
RNG seed (default: -1, use random seed for -1)
```

## Паспорт аргумента

- Основное имя: `--seed`
- Алиас: `-s`
- Поле в `common_params`: `params.sampling.seed`
- HTTP-поле: `seed`
- Значение по умолчанию: `-1` (`LLAMA_DEFAULT_SEED`, в JSON отображается как `4294967295` из-за `uint32_t`).

## Что меняет в llama-server

CLI-парсер читает значение через `std::stoul` и записывает в `uint32_t params.sampling.seed`. Строка `-1` после преобразования соответствует `4294967295`, то есть `LLAMA_DEFAULT_SEED`. При таком значении `get_rng_seed()` берет случайный seed из `std::random_device` или системных часов.

Seed используется финальным `dist`, XTC и `adaptive_p`. При `n`/`n_cmpl` больше 1 child tasks получают разные seed: если исходный seed не `LLAMA_DEFAULT_SEED`, server прибавляет номер child completion.

## Значения и формат

- `-1` - случайный seed на инициализацию sampler-а.
- `0`, `1`, `42` - фиксированные seed.
- Диапазон фактически `uint32_t`; слишком большие значения зависят от преобразования `std::stoul` и последующего приведения.

## Когда использовать

- Для regression-тестов и сравнения sampler-настроек.
- Для воспроизводимых демо: фиксируйте также prompt, модель, `--samplers`, все числовые sampler-параметры, `--parallel`, backend и версию llama.cpp.
- Не используйте фиксированный seed как механизм безопасности или rate limiting.

## Влияние на производительность и память

Не влияет на RAM/VRAM/KV-cache. Влияет только на состояние RNG sampler-ов.

## Взаимодействие с другими аргументами

- При `--temp 0` и жестком greedy-режиме seed почти не влияет, потому что случайного выбора нет.
- `--xtc-probability` использует RNG для решения, сработает ли XTC на шаге.
- `adaptive_p` использует RNG для выбора из трансформированного распределения.
- `--backend-sampling` может менять путь исполнения sampling; проверяйте воспроизводимость отдельно.

## INI-пресеты и router-режим

Ключ INI:

```ini
[deterministic]
seed = 42
```

HTTP-запрос может задать `"seed": 42` для отдельной генерации. В router-режиме seed из preset становится дефолтом child process.

## Типовые проблемы и диагностика

- В `/props` или `/slots` seed виден как `4294967295`: это представление `-1` в `uint32_t`.
- Одинаковый seed, но разные ответы: проверьте `n_cmpl`, prompt cache, backend sampling, sampler order, модель и request-level overrides.
- Несколько completions с одним seed различаются намеренно: child tasks получают offset seed.

## Примеры

```bash
llama-server --model /models/model.gguf --seed 42 --temp 0.7 --top-p 0.9
```

```bash
llama-server --model /models/model.gguf --seed -1
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/tools/server/server-task.h`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/README.md`
