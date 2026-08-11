---
schema: 1
engine: vllm
primaryName: "--max-cudagraph-capture-size"
title: "--max-cudagraph-capture-size"
summary: Верхняя граница размера батча, для которого захватываются CUDA-графы; из неё же выводится вся автоматическая решётка размеров. Понижение режет и время старта, и графовый пул в VRAM.
group: CompilationConfig
related:
  - --cudagraph-capture-sizes
  - --compilation-config
  - --enforce-eager
  - --max-num-seqs
  - --max-num-batched-tokens
  - --gpu-memory-utilization
  - --optimization-level
  - --performance-mode
  - --speculative-config
  - --enable-lora
---

# --max-cudagraph-capture-size

## Кратко

Аргумент задаёт потолок решётки CUDA-графов. Если `--cudagraph-capture-sizes` не задан, из этого потолка целиком генерируется набор размеров: `[1, 2, 4]`, дальше шаг 8 до 256, дальше шаг 16 до потолка. Понижение потолка одновременно укорачивает решётку — это самый дешёвый способ сократить и время захвата, и объём графового пула, не расписывая список вручную.

Своего значения по умолчанию у аргумента нет: потолок вычисляется из `--max-num-seqs`, `--max-num-batched-tokens` и класса карты.

## Оригинальная справка

```text
The maximum cudagraph capture size.

If cudagraph_capture_sizes is specified, this will be set to the largest
size in that list (or checked for consistency if specified). If
cudagraph_capture_sizes is not specified, the list of sizes is generated
automatically following the pattern:

    [1, 2, 4] + list(range(8, 256, 8)) + list(
    range(256, max_cudagraph_capture_size + 1, 16))

If not specified, max_cudagraph_capture_size is capped at 512 by default,
or 1024 on data center Blackwell GPUs. This avoids OOM in tight memory
scenarios with small max_num_seqs, and limits capture of large graphs that
increase startup time and memory usage.
```

## Паспорт аргумента

- Флаги: `--max-cudagraph-capture-size`
- Группа argparse: `CompilationConfig`
- Тип значения: int (число токенов в батче), `None` строкой не принимается — тип не обёрнут в `optional_type`
- Допустимые значения: положительное целое; после всех правок проверяется ассертом `max_cudagraph_capture_size >= 1`
- Значение по умолчанию: `None` — «вычислить»
- Эффективное значение: считается в `VllmConfig._set_cudagraph_sizes()` и **всегда** перезаписывается финальным `cudagraph_capture_sizes[-1]`. Если аргумент не задан: `min(max_num_seqs × (1 + num_speculative_tokens) × 2, 1024 на data center Blackwell иначе 512)`. Затем, независимо от того, задан он или нет: `min(max_num_batched_tokens, значение)`. При `--enforce-eager` или `cudagraph_mode=NONE` обнуляется в `0`
- Где объявлен: `vllm/config/compilation.py:CompilationConfig.max_cudagraph_capture_size`
- Этап применения: сборка `VllmConfig` → инициализация cudagraph-диспетчера → профилирование памяти графов → захват графов в прогреве worker'а

## Что меняет в движке

`_set_cudagraph_sizes()` выполняет три шага.

**Шаг 1 — потолок.** Не заданное значение выводится из планировщика: `max_num_seqs × decode_query_len × 2`, где `decode_query_len = 1 + num_speculative_tokens`, но не больше 512 (1024 на картах семейства SM 10.x, `is_device_capability_family(100)`). Заданное значение берётся как есть. В обоих случаях сверху накладывается `min(max_num_batched_tokens, …)`.

**Шаг 2 — решётка.** Если `--cudagraph-capture-sizes` не задан, строится `[1, 2, 4]` (только те, что ≤ потолка), затем `range(8, min(потолок + 1, 256), 8)`, затем `range(256, потолок + 1, 16)`; в конец добавляется `max_num_batched_tokens`, если он помещается. При `--performance-mode interactivity` мелкая часть заменяется на сплошной `range(1, min(потолок, 32) + 1)`.

**Шаг 3 — согласование.** `valid_max_size = решётка[-1]`. Если заданный потолок ему не равен:

- при одновременно заданном `--cudagraph-capture-sizes` — `ValueError` о несогласованности;
- иначе — предупреждение `Truncating max_cudagraph_capture_size to N`.

Итог в любом случае записывается обратно: `max_cudagraph_capture_size = valid_max_size`. Поэтому «не круглое» значение молча съезжает вниз до узла решётки: `--max-cudagraph-capture-size 500` даёт 496, потому что шаг за 256 равен 16.

Дальше потолок работает уже опосредованно — через длину решётки. `CudagraphDispatcher` разворачивает её в графы (mixed-режим — на каждый размер; отдельная decode-ветка FULL — только для размеров ≤ `max_num_seqs × decode_query_len`; LoRA удваивает), `profile_cudagraph_memory()` оценивает их суммарный объём и вычитает его из бюджета `--gpu-memory-utilization`, а `capture_model()` захватывает от больших к меньшим.

На исполнении смысл потолка прямой: батч крупнее максимального захваченного размера идёт мимо графов целиком.

## Значения и формат

- Единица измерения — токены в батче (для чистого decode это и есть число последовательностей).
- Значение больше `--max-num-batched-tokens` бессмысленно: оно немедленно срезается до него.
- Значение, не попадающее на узел решётки (не кратно 8 ниже 256 и не кратно 16 выше), округляется вниз с предупреждением.
- `0` не допускается: ассерт `Maximum cudagraph size should be greater than or equal to 1 when using cuda graph`. Чтобы отключить графы, используйте `-cc.cudagraph_mode=none` или `--enforce-eager` — они выставят `0` сами.
- Структурные формы: `-cc '{"max_cudagraph_capture_size": 64}'` или `-cc.max_cudagraph_capture_size 64`.

## Когда использовать

- **Ограничить графовый пул одним числом.** Понижение потолка со 512 до 64 убирает из решётки весь хвост (размеры 256…512 с шагом 16 и часть шага-8), то есть большую часть графов, ничего не перечисляя руками.
- **Модель с большим `--max-num-seqs`, но фактически мелким батчем.** Автоматический потолок равен `max_num_seqs × 2`; если реальная конкурентность вдвое ниже заявленной, половина графов никогда не используется.
- **Сократить старт.** Число графов примерно линейно по потолку выше 256 (шаг 16) и по потолку ниже 256 (шаг 8).
- **Не поднимайте выше `max_num_seqs × decode_query_len × 2`** — decode-графы всё равно обрезаются по `max_num_seqs`, а mixed-графы на больших размерах используются только при chunked prefill крупными кусками.
- **Не задавайте вместе с `--cudagraph-capture-sizes`**, если не готовы держать значения синхронными: рассогласование это ошибка старта, а не предупреждение.

## Влияние на производительность и память

- **VRAM.** Уменьшение потолка убирает поштучную составляющую графового пула (`per_graph × (N − 1)` на режим), общая часть первого захвата остаётся. Величины видны в `Estimated CUDA graph memory: X GiB total` и в отладочной строке `Estimated PIECEWISE CUDA graph memory: A MiB first-capture + (N-1) × B MiB per-graph`.
- **Время старта.** Пропорционально числу графов: прогрев плюс захват на каждый размер, дважды при LoRA-специализации, плюс отдельный профилировочный прогон. Финальная строка `Graph capturing finished in N secs, took X GiB` даёт точную цену.
- **Latency.** Батчи, не превышающие потолок, работают на графах; всё, что выше, теряет выигрыш и исполняется обычным путём. Внутри решётки latency зависит от плотности узлов, а не от потолка.
- **Throughput.** Просаживается только если реальные батчи регулярно перескакивают потолок.

## Взаимодействие с другими аргументами

- `--cudagraph-capture-sizes`: приоритетнее. При заданном списке потолок обязан равняться его максимуму, иначе `ValueError`; если потолок не задан — он просто выводится из списка.
- `--max-num-seqs`: источник автоматического потолка (`× decode_query_len × 2`) и жёсткая граница для FULL-графов decode.
- `--max-num-batched-tokens`: срезает потолок сверху всегда, даже при явном значении.
- `--enforce-eager`: обнуляет потолок и решётку; совместное указание бессмысленно.
- `--compilation-config`: `-cc.cudagraph_mode` определяет число наборов графов (`FULL_AND_PIECEWISE` — два), `-cc.cudagraph_specialize_lora` — удвоение при LoRA.
- `--optimization-level`: через дефолтный `cudagraph_mode` (`O0` → графов нет, `O1` → `PIECEWISE`, `O2`/`O3` → `FULL_AND_PIECEWISE`) решает, во сколько наборов развернётся решётка.
- `--performance-mode interactivity`: меняет форму решётки ниже 32, потолок при этом продолжает ограничивать её сверху.
- `--speculative-config`: увеличивает `decode_query_len`, а значит и автоматический потолок; все размеры дополнительно округляются вверх до кратного `num_speculative_tokens + 1`, что может изменить итоговый максимум.
- `--gpu-memory-utilization`: потолок перераспределяет память внутри бюджета (графы ↔ KV-cache), а не увеличивает его.

## Типовые проблемы и диагностика

- **Симптом:** `Truncating max_cudagraph_capture_size to 496`, хотя задали 500. **Причина:** значение не попало на узел решётки (шаг 16 после 256). **Лечение:** задавать кратные 16 (или 8 ниже 256) значения — либо игнорировать, эффект косметический.
- **Симптом:** `ValueError: customized max_cudagraph_capture_size(=512) should be consistent with the max value of cudagraph_capture_sizes(=8)`. **Причина:** заданы оба флага и они расходятся. **Лечение:** убрать `--max-cudagraph-capture-size`.
- **Симптом:** задали 1024, а в логе максимум 512. **Причина:** срез по `--max-num-batched-tokens`. **Проверка:** значение `max_num_batched_tokens` в стартовой строке конфига.
- **Симптом:** OOM во время `Capturing CUDA graphs`. **Причина:** оценка графовой памяти не покрыла реальный расход. **Лечение:** понизить потолок (в первую очередь) или `--gpu-memory-utilization`.
- **Симптом:** после понижения потолка выросло время шага на пиковой нагрузке. **Причина:** батчи стали превышать максимальный захваченный размер и перестали попадать в графы. **Лечение:** вернуть потолок хотя бы до фактического максимума конкурентности.
- **Симптом:** `ValueError: No valid cudagraph sizes after rounding to multiple of N`. **Причина:** при спекулятивном декодировании потолок меньше `num_speculative_tokens + 1`. **Лечение:** поднять потолок или уменьшить число спекулятивных токенов.
- **Подтверждение принятого значения:** `Profiling CUDA graph memory: PIECEWISE=<N> (largest=<потолок>), FULL=<M> (largest=<...>)` — `largest` и есть итоговый максимум после всех правок.

## Примеры

```bash
vllm serve /models/Qwen3-4B --max-cudagraph-capture-size 64 --max-num-seqs 32 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --compilation-config '{"max_cudagraph_capture_size": 32}' --max-model-len 8192
```

## Источники

- `vllm/vllm/config/compilation.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/cudagraph_dispatcher.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/docs/design/cuda_graphs.md`
- `vllm/docs/configuration/conserving_memory.md`
