---
schema: 1
primaryName: "--parallel"
title: "--parallel"
summary: "Количество серверных слотов. `-1` включает auto: сервер использует 4 слота и принудительно включает `--kv-unified`."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-np"
  - "--parallel"
allowedValues: []
env:
  - "LLAMA_ARG_N_PARALLEL"
related:
  - "--ctx-size"
  - "--kv-unified"
  - "--cont-batching"
  - "--cache-idle-slots"
  - "--threads-http"
---

# --parallel

## Кратко

`--parallel` задает `common_params::n_parallel`: сколько серверных слотов создать для одновременных completion/embedding/rerank задач.

Для `llama-server` значение по умолчанию в парсере меняется на `-1`. После парсинга `server.cpp` обрабатывает auto-режим: `n_parallel = 4` и `kv_unified = true`, с логом `n_parallel is set to auto, using n_parallel = 4 and kv_unified = true`.

## Оригинальная справка llama.cpp

```text
number of server slots (default: -1, -1 = auto)
```

## Паспорт аргумента

- Основное имя: `--parallel`
- Алиасы: `-np`, `--parallel`
- Значение: целое число слотов
- Значение по умолчанию: `-1`
- Запрещено в server-режиме: `0`
- Переменная окружения: `LLAMA_ARG_N_PARALLEL`
- Поля llama.cpp: `common_params::n_parallel`, `llama_context_params::n_seq_max`

## Что меняет в llama-server

Сервер создает `n_parallel` объектов `server_slot` и передает это значение в `n_seq_max`. Каждый слот получает id, собственное состояние prompt/generation и участвует в scheduler loop.

Без `--kv-unified` общий `--ctx-size` делится на `n_seq_max`, поэтому увеличение `--parallel` уменьшает контекст на слот. С `--kv-unified` слоты используют общий KV-буфер.

`--parallel` также влияет на auto-значение HTTP threads: при `--threads-http < 1` `server-http.cpp` считает `n_threads_http = std::max(params.n_parallel + 4, (int32_t)(std::thread::hardware_concurrency() - 1))`; явный `--threads-http` формулу отменяет. Поверх фиксированных потоков пул допускает до `n_threads_http + 1024` динамических.

## Значения и формат

- `-1`: auto, фактически 4 слота и `--kv-unified`. Условие в коде — `n_parallel < 0`, то есть auto срабатывает на любом отрицательном значении. Этот post-parse шаг безусловно включает unified KV даже при одновременно заданном `--no-kv-unified`; Arriero повторяет именно этот порядок.
- `1`: один слот, наиболее предсказуемая latency и KV-память.
- `N > 1`: несколько слотов.
- `0`: парсер server-режима выбрасывает `error: invalid value for n_parallel`.
- `1..256`: допустимый диапазон текущего `llama_context`; значение выше 256 завершается ошибкой `n_seq_max must be <= 256` при загрузке. Arriero отклоняет обе невыполнимые формы до оценки.

## Когда использовать

Увеличивайте `--parallel`, если сервер должен одновременно обслуживать несколько клиентов или `n_cmpl` больше 1. Уменьшайте, если нужен максимальный контекст на запрос, меньше KV-памяти или проще диагностика.

Для публичного API не ставьте большое значение без лимитов очереди и мониторинга: каждый слот может удерживать большой prompt в KV.

## Влияние на производительность и память

Больше слотов повышает concurrency, но увеличивает `n_seq_max`, нагрузку scheduler loop и требования к KV-cache. При раздельном KV контекст на слот примерно `ctx / slots` — точное значение получается с паддингом до кратного 256 и округлением `n_ctx` вниз при неделимости на `n_seq_max`; при unified KV память общая, но конкурирующие длинные запросы могут вытеснять idle slots или требовать prompt cache.

Arriero одинаково трактует отсутствие аргумента, `--parallel -1` и любое отрицательное значение: четыре слота с unified KV. Это важно для SWA и recurrent state, где ошибочное представление `-1` как обычного явного числа меняло бы расчет cache layout.

Throughput растет только пока backend успевает эффективно батчить decode/prompt. После насыщения GPU/CPU дополнительные слоты чаще повышают tail latency.

## Взаимодействие с другими аргументами

- `--ctx-size`: общий контекст; без `--kv-unified` делится между слотами.
- `--kv-unified`: автоматически включается при `--parallel -1`.
- `--cont-batching`: позволяет scheduler добавлять новые запросы к текущей работе.
- `--cache-idle-slots`: требует `--cache-ram`; очищает KV idle slots только при `--kv-unified`.
- `--predict`: глобальный default лимита генерации для каждого запроса.
- `n_cmpl` в HTTP API не может быть больше числа слотов.
- Speculative decoding: `n_parallel` передается при инициализации — `common_speculative_init(params_base.speculative, params_base.n_parallel)` в `server-context.cpp`.

## INI-пресеты и router-режим

В INI используйте `parallel = 4` или `LLAMA_ARG_N_PARALLEL`. В router-режиме параметр относится к дочернему процессу модели; сам router модель не грузит и слоты инференса не создает.

## Типовые проблемы и диагностика

- Логи `initializing slots, n_slots = ...` и `new slot, n_ctx = ...` показывают фактическое число слотов и контекст на слот. Контекст слота капится training-контекстом модели с warning `the slot context (%d) exceeds the training context of the model (%d) - capping`, поэтому `new slot, n_ctx = ...` может показать меньше ожидаемого.
- Поле `total_slots` в `/props` и метриках определяется `--parallel` — быстрый способ проверить фактическое число слотов снаружи.
- Ошибка `n_cmpl cannot be greater than the number of slots, please increase -np` лечится увеличением `--parallel` или уменьшением `n_cmpl`.
- Для рекуррентной памяти возможен лог `Try using a bigger --parallel value`, если seq_id выходит за `n_seq_max`.

## Примеры

```bash
llama-server --model /models/model.gguf --parallel 1 --ctx-size 16384
```

```bash
llama-server --model /models/model.gguf --parallel -1 --ctx-size 65536
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/README.md`
