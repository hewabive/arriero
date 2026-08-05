---
schema: 1
primaryName: "--ctx-size"
title: "--ctx-size"
summary: "Общий размер контекста, который выделяется для llama-context. В обычном KV-режиме он делится между слотами, а при `--kv-unified` становится размером общего KV-буфера."
category: "Общие параметры"
valueType: "number"
valueHint: "N"
presetSupport: "supported"
aliases:
  - "-c"
  - "--ctx-size"
allowedValues: []
env:
  - "LLAMA_ARG_CTX_SIZE"
related:
  - "--parallel"
  - "--kv-unified"
  - "--cache-type-k"
  - "--cache-type-v"
  - "--fit"
  - "--fit-ctx"
---

# --ctx-size

## Кратко

`--ctx-size` задает `common_params::n_ctx` и затем `llama_context_params::n_ctx`: сколько токенов контекста выделить при создании контекста модели.

Значение `0` означает "взять контекст из модели". В этом commit явный `--ctx-size 0` также выставляет `fit_params_min_ctx = UINT32_MAX`, то есть запрещает `--fit` уменьшать контекст ниже полного значения модели.

## Оригинальная справка llama.cpp

```text
size of the prompt context (default: 0, 0 = loaded from model)
```

## Паспорт аргумента

- Основное имя: `--ctx-size`
- Алиасы: `-c`, `--ctx-size`
- Значение: целое число токенов
- Значение по умолчанию для `llama-server`: `0`
- Переменная окружения: `LLAMA_ARG_CTX_SIZE`
- Поле llama.cpp: `common_params::n_ctx`
- Этап применения: парсинг CLI, затем создание `llama_context`

## Что меняет в llama-server

При запуске `llama-server` значение передается в `llama_init_from_model()` через `common_context_params_to_llama()`. Для causal-модели фактический `n_batch` сначала ограничивается исходным, еще не выровненным `n_ctx`. Затем в `llama-context.cpp` общий контекст выравнивается по 256 токенов и рассчитывается `n_ctx_seq`.

Если `--kv-unified` выключен, `n_ctx_seq` считается как `n_ctx / n_seq_max`, где `n_seq_max` берется из `--parallel`; затем slice также выравнивается по 256, а итоговый `n_ctx` заменяется на `n_ctx_seq * n_seq_max`. Текст warning говорит `rounding down`, но из-за второго `GGML_PAD` результат способен вырасти: запрос `--ctx-size 1000 --parallel 3` в b10276 дал `n_ctx_seq = 512` и итоговый `n_ctx = 1536`, тогда как causal `n_batch` остался ограничен исходными 1000.

Если `--kv-unified` включен, `n_ctx_seq = n_ctx`: слоты используют один общий KV-буфер, и отдельный статический лимит "общий контекст / число слотов" не применяется.

## Значения и формат

- `0`: загрузить размер контекста из метаданных модели и не давать `--fit` автоматически уменьшать его.
- Положительное число: запрошенный размер контекста в токенах.
- Отрицательное значение справкой не описано как специальное для этого аргумента; текущий сервер доходит с ним до ошибки создания контекста, а Arriero отклоняет такую оценку заранее.

## Когда использовать

Увеличивайте `--ctx-size`, когда реальные запросы упираются в ошибку вида `request (...) exceeds the available context size (...)`. Уменьшайте его при OOM, долгом старте или если нужно поднять больше слотов на той же VRAM/RAM.

Для многослотового сервера считайте не только общее значение, но и контекст на слот. Например, `--ctx-size 32768 --parallel 4` без `--kv-unified` дает примерно 8192 токена на слот до внутреннего выравнивания.

## Влияние на производительность и память

Главное влияние идет через KV-cache. Чем больше контекст, тем больше RAM/VRAM под K/V для всех слоев модели; размер также масштабируется типами `--cache-type-k`, `--cache-type-v`, числом слотов и режимом `--kv-offload`.

Большой контекст не ускоряет генерацию сам по себе. Он увеличивает допустимую длину prompt+completion, но может снизить максимальный throughput из-за памяти, фрагментации KV и более тяжелого prompt processing.

## Взаимодействие с другими аргументами

- `--parallel`: без `--kv-unified` делит контекст между слотами через `n_seq_max`.
- `--kv-unified`: делает KV-буфер общим для всех слотов; при `--parallel -1` сервер сам включает `--kv-unified` и ставит 4 слота.
- `--cache-type-k` и `--cache-type-v`: меняют байты на токен в KV-cache.
- `--batch-size` ограничивается контекстом для causal attention: llama.cpp берет `min(n_ctx, n_batch)`.
- `--fit` и `--fit-ctx`: могут подбирать параметры под память, но явный `--ctx-size 0` запрещает уменьшение контекста.
- `--context-shift` и `--keep`: определяют поведение при достижении лимита во время бесконечной генерации.

## INI-пресеты и router-режим

В INI можно писать `ctx-size = 32768` или ключ `LLAMA_ARG_CTX_SIZE`. Аргумент имеет env mapping, поэтому доступен в `common_preset`.

В router-режиме значение применяется к дочернему процессу конкретной модели. Сам router без модели контекст не создает.

## Типовые проблемы и диагностика

- В логах `llama-context` смотрите `n_ctx`, `n_ctx_seq`, `n_seq_max`, `n_batch`, `n_ubatch`, `kv_unified`.
- Предупреждение `n_ctx_seq (...) < n_ctx_train (...)` означает, что выделенный контекст меньше обучающего контекста модели.
- Предупреждение `n_ctx_seq (...) > n_ctx_train (...)` означает потенциальное переполнение обучающего контекста; нужны RoPE/YaRN параметры или меньший контекст.
- Ошибка `failed to allocate buffer for kv cache` обычно лечится уменьшением `--ctx-size`, `--parallel`, `--cache-type-*` или отключением/изменением offload.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 8192
```

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --parallel 4 --cache-type-k q8_0 --cache-type-v q8_0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
