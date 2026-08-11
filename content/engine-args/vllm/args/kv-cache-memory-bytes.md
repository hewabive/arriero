---
schema: 1
engine: vllm
primaryName: "--kv-cache-memory-bytes"
title: "--kv-cache-memory-bytes"
summary: Жестко задает размер KV-cache в байтах вместо профилирования памяти. Отменяет действие --gpu-memory-utilization и переносит ответственность за отсутствие OOM на оператора.
group: CacheConfig
related:
  - --gpu-memory-utilization
  - --max-model-len
  - --max-num-seqs
  - --enforce-eager
  - --num-gpu-blocks-override
  - --tensor-parallel-size
---

# --kv-cache-memory-bytes

## Кратко

В штатном режиме размер KV-cache вычисляется: движок профилирует потребление памяти, вычитает его из бюджета `--gpu-memory-utilization` и отдает остаток под кэш. `--kv-cache-memory-bytes` заменяет это измерение фиксированным числом байт на GPU.

Профилирование при этом **не** пропускается целиком: `profile_run()` все равно выполняется, потому что модель нужно скомпилировать под `max_num_batched_tokens`. Пропускается только измерение памяти и оценка CUDA graphs — и вместе с ними исчезает страховка от OOM.

## Оригинальная справка

```text
Size of KV Cache per GPU in bytes. By default, this is set to None
and vllm can automatically infer the kv cache size based on
gpu_memory_utilization. However, users may want to manually specify
the kv cache memory size. kv_cache_memory_bytes allows more fine-grain
control of how much memory gets used when compared with using
gpu_memory_utilization. Note that kv_cache_memory_bytes
(when not-None) ignores gpu_memory_utilization
```

## Паспорт аргумента

- Флаги: `--kv-cache-memory-bytes`
- Группа argparse: `CacheConfig`
- Тип значения: int (байты), с поддержкой человекочитаемых суффиксов
- Допустимые значения: любое положительное целое; дополнительно принимается литерал `None` (и пустая строка) как «не задано»
- Значение по умолчанию: `None`
- Эффективное значение: при `VLLM_ENABLE_STARTUP_PLAN=1` и отсутствии явного значения worker может подставить сохраненное с прошлого запуска (`maybe_apply_startup_plan`); явно заданное значение никогда не перезаписывается
- Где объявлен: `vllm/config/cache.py:CacheConfig.kv_cache_memory_bytes`
- Этап применения: `Worker.determine_available_memory()` — до расчета числа блоков KV-cache

## Что меняет в движке

`Worker.determine_available_memory()` начинается с `maybe_apply_startup_plan(self)`, а затем проверяет `kv_cache_memory_bytes`. Если значение непусто, ветка с `memory_profiling` не выполняется: движок делает только `profile_run()` (для компиляции), пишет предупреждающее info-сообщение и возвращает заданное число байт как доступную под KV-cache память.

Сообщение стоит прочитать целиком, оно описывает контракт: «Initial free memory X GiB, reserved Y GiB memory for KV Cache as specified by kv_cache_memory_bytes config and skipped memory profiling. This does not respect the gpu_memory_utilization config. Only use kv_cache_memory_bytes config when you want manual control of KV cache memory size. If OOM'ed, check the difference of initial free memory between the current run and the previous run where kv_cache_memory_bytes is suggested and update it correspondingly.»

Откуда брать число: при **обычном** запуске (без этого флага) движок в конце прогрева печатает готовые значения — `Replace gpu_memory_utilization config with --kv-cache-memory=<N>` для «влезть в запрошенный бюджет» и второй вариант для «занять всю свободную память карты». Обратите внимание на расхождение: в тексте лога и в апстрим-документации фигурирует имя `--kv-cache-memory`, тогда как в этом commit'е CLI объявляет флаг `--kv-cache-memory-bytes`. Проверяйте фактическое имя через `vllm serve --help` своей сборки.

Значение трактуется как **на GPU**: под TP каждый rank резервирует столько байт на своей карте.

Есть и автоматизированный путь: при `VLLM_ENABLE_STARTUP_PLAN=1` профилировочный результат сохраняется в `{VLLM_CACHE_ROOT}/startup_plan/` под отпечатком, включающим версию vLLM, `VllmConfig.compute_hash()`, имя и объем устройства, compute capability, версии torch/CUDA, ранг и размер мира. На следующем старте план применяется только если отпечаток совпал **и** свободной памяти сейчас не меньше, чем было при записи; иначе движок логирует отказ и профилирует заново.

На CPU-платформе флаг тоже работает, но проверяется иначе: `CPUWorker.determine_available_memory()` сравнивает значение с доступной памятью NUMA-узла и падает с сообщением, предлагающим уменьшить `--kv-cache-memory-bytes` или `VLLM_CPU_KVCACHE_SPACE`.

## Значения и формат

- Целое число байт: `--kv-cache-memory-bytes 21474836480`.
- Человекочитаемые суффиксы (`human_readable_int`): строчные — десятичные множители (`8g` = 8·10⁹), прописные — двоичные (`8G` = 8·2³⁰). Аналогично `k/K`, `m/M`, `t/T`; допускается дробная мантисса (`25.6k`).
- `None` или пустая строка — вернуться к профилированию.
- Ноль и отрицательные значения бессмысленны: `if kv_cache_memory_bytes :=` считает `0` ложью, и движок уйдет в обычное профилирование.

## Когда использовать

- Когда время старта критично и конфигурация зафиксирована: пропуск измерения памяти и оценки CUDA graphs заметно сокращает загрузку. Апстрим-документация по оптимизации описывает это как основной сценарий.
- Когда нужен строго воспроизводимый размер KV-cache между перезапусками, независимо от того, сколько памяти занято на карте в момент старта.
- Когда профилирование систематически недооценивает или переоценивает потребление на вашей связке модель/backend, и вы вручную выставили работающее значение.
- **Не используйте** на карте, которую делите с другими процессами с меняющимся потреблением: значение валидно только при том же начальном объеме свободной памяти, что и при его получении.
- Не используйте как замену `--gpu-memory-utilization` в arriero-инстансе: оценщик памяти считает draw по utilization и про этот флаг ничего не знает, поэтому декларированный draw разойдется с фактическим.

## Влияние на производительность и память

- **VRAM.** Задает ровно столько байт под KV-cache, сколько указано. Все остальное потребление (веса, активации, CUDA graphs) сверх этого — и никто не проверяет, что сумма влезает в карту.
- **Время старта.** Уменьшается: пропускается измерение памяти и проход оценки CUDA-graph-памяти.
- **Throughput.** Консервативное значение ограничивает concurrency ровно так же, как заниженный `--gpu-memory-utilization`; оптимистичное падает на аллокации.
- **Стабильность.** Единственный аргумент из этой группы, который снимает автоматическую защиту от OOM.

## Взаимодействие с другими аргументами

- `--gpu-memory-utilization`: полностью игнорируется, пока задан этот флаг. Проверка «свободной памяти хватает на запрошенный бюджет» при этом все равно выполняется на входе в worker.
- `--max-model-len`: проверка «влезает ли хотя бы один запрос максимальной длины» выполняется по заданному числу байт. Слишком маленькое значение даст ту же ошибку с предложением уменьшить `max_model_len`.
- `--num-gpu-blocks-override`: перебивает результат уже на уровне числа блоков; при обоих заданных аргументах фактическую емкость определяет override.
- `--enforce-eager`: убирает CUDA graphs, поэтому число, снятое с прогона без него, будет заниженным (и наоборот).
- `--tensor-parallel-size`: значение применяется на каждом GPU, а не делится.

## Типовые проблемы и диагностика

- **Симптом:** OOM во время прогрева или захвата CUDA graphs после добавления флага. **Причина:** значение снято на прогоне с другим объемом свободной памяти или другим набором флагов. **Проверка:** сравнить `Initial free memory X GiB` в логе текущего и того запуска. **Лечение:** уменьшить значение или снять флаг и переснять подсказку.
- **Симптом:** `To serve at least one request with the model's max seq len ...` **Причина:** заданных байт не хватает на один запрос полной длины. **Лечение:** увеличить значение или уменьшить `--max-model-len`.
- **Симптом:** флаг не принимается парсером. **Причина:** расхождение имен между версиями (`--kv-cache-memory` в логах и апстрим-документации против `--kv-cache-memory-bytes` в этом commit'е). **Проверка:** `vllm serve --help` установленной версии.
- **Симптом:** профилирование пропущено, хотя флаг не задан, и в логе `Applying persisted startup plan (fingerprint ...)`. **Причина:** включен `VLLM_ENABLE_STARTUP_PLAN=1` и найден подходящий сохраненный план. **Лечение:** убрать переменную окружения либо очистить `{VLLM_CACHE_ROOT}/startup_plan/`.
- **Подтверждение:** строка `Initial free memory ... reserved ... GiB memory for KV Cache as specified by kv_cache_memory_bytes config and skipped memory profiling.` в логе старта.

## Примеры

```bash
vllm serve /models/Qwen3-4B --kv-cache-memory-bytes 12G --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --kv-cache-memory-bytes 12884901888 --max-num-seqs 8
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/v1/worker/cpu_worker.py`
- `vllm/vllm/v1/worker/startup_plan.py`
- `vllm/docs/configuration/optimization.md`
- `docs/MEMORY_ESTIMATION.md` (arriero)
