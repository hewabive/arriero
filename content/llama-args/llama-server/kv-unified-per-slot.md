---
schema: 1
primaryName: "--kv-unified-per-slot"
title: "--kv-unified-per-slot"
summary: "Ограничивает доступный одному server slot контекст и, если `--ctx-size` не задан, автоматически подбирает общий unified KV pool как `parallel × N`. Удобно для явного per-request лимита без ручного расчёта общей ёмкости."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--kv-unified-per-slot"
allowedValues: []
env:
  - "LLAMA_ARG_KV_UNIFIED_PER_SLOT"
related:
  - "--ctx-size"
  - "--parallel"
  - "--kv-unified"
  - "--fit"
---

# --kv-unified-per-slot

## Кратко

`--kv-unified-per-slot N` задаёт верхний предел контекста одного parallel slot. При незаданном `--ctx-size` server одновременно рассчитывает общий KV pool как `n_parallel × N`; при явно заданном pool флаг только ограничивает slot и не увеличивает память.

По умолчанию значение не установлено (`0` во внутреннем поле), и поведение остаётся прежним.

## Оригинальная справка llama.cpp

```text
context limit per parallel slot (default: unset, behavior unchanged).
when set without -c/--ctx-size, the shared KV pool is sized to n_parallel*N
```

## Паспорт аргумента

- Основное имя: `--kv-unified-per-slot`
- Формат: целое число токенов `N`
- Переменная окружения: `LLAMA_ARG_KV_UNIFIED_PER_SLOT`
- Поле: `common_params::kv_unified_per_slot`
- Значение по умолчанию: `0`, лимит не задан
- Этап применения: расчёт общего context size до создания контекста и назначение ёмкости server slots

## Что меняет в llama-server

Если `N > 0`, `--ctx-size` остался в исходном auto-состоянии и пользователь не передал явное `--ctx-size 0`, server до загрузки модели выставляет `n_ctx = n_parallel × N`. В логе появляется расчёт `--kv-unified-per-slot: sizing KV pool ...`.

После создания контекста ёмкость slot вычисляется как минимум из ёмкости одной sequence в общем KV pool, `N` и training context модели. Поэтому флаг ограничивает каждый запрос, но не позволяет выйти за физическую ёмкость pool или context, на котором обучалась модель.

## Значения и формат

- `0` или отрицательное значение не активирует специальный расчёт и cap, поскольку runtime проверяет только `N > 0`; используйте отсутствие флага как более ясную форму.
- Положительное `N` задаёт максимум токенов на slot.
- При auto pool итоговый общий `n_ctx` равен `--parallel × N`.

Парсер не вводит отдельной проверки переполнения произведения; выбирайте значения в пределах разумного context size модели и доступной памяти.

## Когда использовать

Флаг полезен, когда оператор мыслит лимитом одного запроса, а не суммарным `--ctx-size`: например, четыре slot по 8192 токена. Он также предотвращает ситуацию, когда один запрос занимает непропорционально большую часть unified KV cache.

Если общий KV pool уже рассчитан и закреплён вручную, задавайте `--ctx-size` вместе с этим флагом: тогда `--kv-unified-per-slot` работает только как cap.

## Влияние на производительность и память

При auto-сайзинге увеличение `N` или `--parallel` линейно увеличивает целевой общий context size и, следовательно, KV-cache VRAM/RAM. Сам cap вычислений не добавляет, но меньший предел может раньше остановить или отклонить длинный запрос.

При явном `--ctx-size` флаг не расширяет pool и потому сам по себе не увеличивает память. Если `N` больше физической per-sequence ёмкости, server сообщает, что cap не оказывает эффекта.

## Взаимодействие с другими аргументами

- `--parallel` участвует в формуле auto pool: `n_ctx = n_parallel × N`.
- Явный `--ctx-size` имеет приоритет для размера pool; `--ctx-size 0` также означает сознательный выбор полного model context и блокирует auto-сайзинг этим флагом.
- `--kv-unified` определяет shared/unified организацию KV cache; новый аргумент задаёт per-slot предел поверх доступной sequence capacity.
- `--fit` может уменьшать context ради памяти; фактический slot всё равно ограничен минимумом из получившегося pool, `N` и training context.

## INI-пресеты и router-режим

```ini
[four-slots]
parallel = 4
kv-unified-per-slot = 8192
```

В model preset выбирайте `N` не выше поддерживаемого моделью контекста. При router mode суммарная память определяется каждым одновременно загруженным child model и его pool.

## Типовые проблемы и диагностика

- `capping per-slot context ...`: cap меньше доступной per-sequence ёмкости и применяется.
- `exceeds the per-slot pool capacity ... cap has no effect`: общий `--ctx-size` слишком мал для указанного `N`; увеличьте pool либо уберите cap.
- Slot меньше `N`: сработал training-context cap модели или pool был уменьшен настройками памяти/fit.
- OOM после увеличения `N`: при auto pool вырос общий KV cache; уменьшите `N`, `--parallel` или тип/размер cache.

## Примеры

```bash
llama-server --model /models/model.gguf --parallel 4 --kv-unified-per-slot 8192
llama-server --model /models/model.gguf --ctx-size 32768 --parallel 8 --kv-unified-per-slot 4096
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- https://github.com/ggml-org/llama.cpp/pull/24124
