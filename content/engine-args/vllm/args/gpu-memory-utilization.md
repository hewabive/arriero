---
schema: 1
engine: vllm
primaryName: "--gpu-memory-utilization"
title: "--gpu-memory-utilization"
summary: Доля полной памяти устройства, которую инстанс vLLM резервирует под веса, активации, CUDA graphs и KV-cache. Единственная ручка, которой регулируется размер KV-cache в штатном режиме, и обязательный аргумент для оценки памяти в arriero.
group: CacheConfig
related:
  - --kv-cache-memory-bytes
  - --max-model-len
  - --max-num-seqs
  - --max-num-batched-tokens
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --enforce-eager
  - --num-gpu-blocks-override
---

# --gpu-memory-utilization

## Кратко

`--gpu-memory-utilization` задает бюджет: `requested = ceil(total_memory × utilization)`, где `total_memory` — **полный** объем памяти устройства, а не свободный. Из этого бюджета вычитается все, что измерило профилирование (веса, не-torch аллокации, пик активаций, оценка CUDA graphs), а остаток целиком уходит под KV-cache.

Это лимит **на инстанс и на устройство**: при `--tensor-parallel-size 4` каждый из четырех процессов применяет ту же долю к своей карте, значение не делится между картами.

## Оригинальная справка

```text
The fraction of GPU memory to be used for the model executor, which can
range from 0 to 1. For example, a value of 0.5 would imply 50% GPU memory
utilization. If unspecified, will use the default value of 0.92. This is a
per-instance limit, and only applies to the current vLLM instance. It does
not matter if you have another vLLM instance running on the same GPU. For
example, if you have two vLLM instances running on the same GPU, you can
set the GPU memory utilization to 0.5 for each instance.
```

## Паспорт аргумента

- Флаги: `--gpu-memory-utilization`
- Группа argparse: `CacheConfig`
- Тип значения: float (доля, не проценты)
- Допустимые значения: `(0, 1]` — валидация `gt=0, le=1` на уровне pydantic
- Значение по умолчанию: `Field(default=0.92, gt=0, le=1)`, то есть `0.92` при ограничении «строго больше 0 и не больше 1»
- Эффективное значение: не переопределяется движком, но **полностью игнорируется**, если задан `--kv-cache-memory-bytes` (или если применен сохраненный startup plan при `VLLM_ENABLE_STARTUP_PLAN=1`)
- Где объявлен: `vllm/config/cache.py:CacheConfig.gpu_memory_utilization`
- Этап применения: инициализация worker'а → профилирование памяти → расчет доступной памяти под KV-cache

## Что меняет в движке

`request_memory()` (`vllm/v1/worker/utils.py`) считает `requested_memory = ceil(init_snapshot.total_memory × gpu_memory_utilization)` и сразу проверяет, что свободной памяти на устройстве не меньше запрошенной. Если на карте уже сидит чужой процесс и свободного меньше — старт падает **до** загрузки весов.

Дальше `Worker.determine_available_memory()`:

1. запускает `profile_run()` под `memory_profiling`, измеряя веса, не-torch память и транзиентный пик активаций;
2. если CUDA graphs будут захватываться, отдельно оценивает их объем (`profile_cudagraph_memory`), учитывая его только при `VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS` (по умолчанию включено);
3. считает `available_kv_cache_memory_bytes = requested_memory − non_kv_cache_memory − cudagraph_memory_estimate`.

Полученное число уходит в `get_kv_cache_configs()`, где делится на размер страницы и превращается в число блоков; затем `update_kv_cache_capacity()` печатает итог. Обратите внимание: неиспользованная память сверх `requested_memory` (`unrequested_memory`) остается свободной на карте и движком не трогается — именно это делает лимит «на инстанс».

На CPU-платформе тот же параметр означает долю памяти NUMA-узла (`vllm/v1/worker/cpu_worker.py`), и сообщение об ошибке это проговаривает явно: «On the CPU backend, the `--gpu-memory-utilization` flag controls the fraction of CPU memory reserved (despite its name)».

## Значения и формат

- Дробное число в диапазоне `(0, 1]`. `0.9` — это 90 % полной памяти устройства.
- `0` и отрицательные значения отвергаются валидацией; значение больше `1` — тоже.
- Специальных значений нет. «Не задано» означает 0.92 в этом commit'е; в более старых релизах дефолт был 0.9, поэтому в скриптах и в оценке памяти его стоит задавать явно.
- Значение применяется к полной памяти карты. Если на устройстве уже занято 30 %, `--gpu-memory-utilization 0.9` не означает «занять 90 % от остатка»: движок потребует 90 % полного объема и упадет, если столько не свободно.

## Когда использовать

- Всегда задавайте явно на управляемом сервере: дефолт зависит от версии, а arriero-оценка памяти (`vllm-gpu-util`) отказывается считать draw без явного значения — см. `docs/MEMORY_ESTIMATION.md` (документ arriero).
- Повышайте, когда в логе видны вытеснения (preemption) и низкий `Maximum concurrency`: KV-cache — единственное, что растет от повышения.
- Понижайте, когда на карте живет что-то еще (второй инстанс, дисплей, чужой процесс) или когда старт падает на нехватке свободной памяти.
- Не используйте как способ «зарезервировать VRAM на будущее»: память резервируется реально и сразу, при `1.0` не остается запаса на фрагментацию аллокатора и внешние аллокации драйвера.

## Влияние на производительность и память

- **VRAM.** Прямо задает верхнюю границу потребления инстансом на каждом устройстве. Все, что не ушло на веса/активации/CUDA graphs, становится KV-cache.
- **Throughput.** Через размер KV-cache определяет `Maximum concurrency` — сколько запросов длиной `max_model_len` помещается одновременно. Ниже concurrency — больше вытеснений и пересчетов prefill.
- **Время старта.** Не влияет: профилирование выполняется в любом случае. Пропустить его можно только через `--kv-cache-memory-bytes`.
- **CUDA graphs.** Их вклад учитывается в бюджете. Если отключить оценку через `VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS=0`, движок предупредит, что графы не учтены, и предложит понизить utilization.

## Взаимодействие с другими аргументами

- `--kv-cache-memory-bytes`: при непустом значении полностью отменяет действие этого флага (профилирование памяти пропускается, размер KV-cache задается байтами).
- `--max-model-len`: определяет, сколько KV-памяти нужно на один запрос. Если бюджета не хватает даже на один запрос максимальной длины, движок падает на старте и подсказывает оценочный максимум длины.
- `--max-num-seqs`, `--max-num-batched-tokens`: задают спрос на KV-cache и активации; при нехватке памяти движок в сообщениях предлагает понизить именно их либо utilization.
- `--tensor-parallel-size`, `--pipeline-parallel-size`: шардируют веса и тем самым освобождают память под KV-cache на каждом устройстве, но долю не делят — каждый rank применяет ее к своей карте.
- `--enforce-eager`: отключает CUDA graphs, убирая их из бюджета; при том же utilization KV-cache становится больше.
- `--num-gpu-blocks-override`: перебивает результат профилирования на уровне числа блоков — фактическая емкость перестает соответствовать бюджету.

## Типовые проблемы и диагностика

- **Симптом:** `Free memory on device (X/Y GiB) on startup is less than desired GPU memory utilization (0.9, Z GiB). Decrease GPU memory utilization or reduce GPU memory used by other processes.` **Причина:** карта уже занята. **Лечение:** понизить значение или освободить карту.
- **Симптом:** `No available memory for the cache blocks. Try increasing gpu_memory_utilization ...` **Причина:** после вычета весов, активаций и CUDA graphs остаток бюджета неположителен. **Лечение:** повысить utilization, уменьшить `--max-num-batched-tokens`, добавить TP/PP.
- **Симптом:** `To serve at least one request with the model's max seq len (N), (X GiB KV cache is needed, which is larger than the available KV cache memory (Y GiB). Based on the available memory, the estimated maximum model length is M.` **Причина:** KV-cache не вмещает даже один запрос полной длины. **Лечение:** взять предложенное `M` как `--max-model-len` либо повысить utilization.
- **Симптом:** частые preemption и просадка throughput. **Проверка:** строка `GPU KV cache size: N tokens, Maximum concurrency for M tokens per request: X.XXx` и `GPU KV cache usage` в периодическом логе. **Лечение:** повысить utilization или снизить `--max-num-seqs`.
- **Подтверждение принятого значения:** `Available KV cache memory: X GiB` (info) и подробная строка `Free memory on device (...). Desired GPU memory utilization is (0.9, X GiB). Actual usage is ... for consumed memory (weights + non-torch), ... for peak activation, and ... for CUDAGraph memory.` В ней же движок печатает готовое значение для перехода на ручной режим.
- **Симптом (arriero):** оценка памяти инстанса не считается. **Причина:** `--gpu-memory-utilization` не задан явно — оценщик отказывается угадывать версионно-зависимый дефолт. **Лечение:** задать значение в аргументах инстанса и пересчитать оценку.

## Примеры

```bash
vllm serve /models/Qwen3-4B --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --gpu-memory-utilization 0.45 --max-num-seqs 4 --enforce-eager
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/v1/worker/utils.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/v1/worker/cpu_worker.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/docs/configuration/optimization.md`
- `vllm/docs/configuration/conserving_memory.md`
- `docs/MEMORY_ESTIMATION.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
