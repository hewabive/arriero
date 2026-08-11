---
schema: 1
engine: vllm
primaryName: "--max-loras"
title: "--max-loras"
summary: Число GPU-слотов под адаптеры: сколько разных LoRA может одновременно участвовать в одном шаге движка. Это первый множитель во всех преаллоцированных LoRA-буферах и жёсткое ограничение планировщика.
group: LoRAConfig
related:
  - --enable-lora
  - --max-cpu-loras
  - --max-lora-rank
  - --lora-dtype
  - --lora-target-modules
  - --fully-sharded-loras
  - --specialize-active-lora
  - --lora-modules
  - --gpu-memory-utilization
  - --max-num-seqs
---

# --max-loras

## Кратко

`--max-loras` — это количество **GPU-слотов**, а не количество адаптеров, которые можно зарегистрировать. Слоты выделяются один раз при загрузке модели: каждая LoRA-обёртка создаёт тензоры с ведущей размерностью `max_loras`, и эта память занята всё время жизни процесса независимо от того, загружен ли хоть один адаптер.

Второе следствие — планировщик: в одном шаге не может быть больше `max_loras` разных адаптеров, запросы сверх этого откладываются в очередь.

## Оригинальная справка

```text
Max number of LoRAs in a single batch.
```

## Паспорт аргумента

- Флаги: `--max-loras`
- Группа argparse: `LoRAConfig`
- Тип значения: int
- Допустимые значения: `Field(default=1, ge=1)` — целое, не меньше 1; верхней границы нет
- Значение по умолчанию: `1`
- Эффективное значение: не переопределяется; но при пустом `--max-cpu-loras` значение копируется в `max_cpu_loras` валидатором `LoRAConfig._validate_lora_config`
- Где объявлен: `vllm/config/lora.py:LoRAConfig.max_loras`
- Этап применения: загрузка модели (выделение GPU-слотов) → профилирование памяти → захват CUDA graph → планировщик → forward

## Что меняет в движке

Значение читается в трёх местах.

**Выделение буферов.** `LoRAModelManager.lora_slots` возвращает `max_loras`; это же число передаётся в `create_lora_weights(max_loras, lora_config, …)` каждой обёртки. Для обычного линейного слоя выделяются

- `lora_a_stacked`: `n_slices` тензоров формы `(max_loras, 1, max_lora_rank, input_size)`,
- `lora_b_stacked`: `n_slices` тензоров формы `(max_loras, 1, output_size, max_lora_rank)`,

в dtype из `--lora-dtype`. Для MoE-обёрток к форме добавляется размерность экспертов. Плюс `LoRAKernelMeta` выделяет служебные тензоры размеров `max_loras + 1` и `max_loras + 2` и два буфера длиной `max_num_batched_tokens`.

**Активация адаптера.** `LoRAModelManager` держит `lora_index_to_id: [None] * lora_slots` и LRU-кэш активных адаптеров той же ёмкости. `activate_adapter()` ищет свободный слот и копирует веса адаптера с CPU в GPU-буфер по этому индексу; если свободных слотов нет — `ValueError: No free lora slots`. Вытеснение из активных слотов идёт по LRU.

**Планирование.** `Scheduler.schedule()` собирает `scheduled_loras` из уже работающих запросов и пропускает из очереди запрос, чей адаптер не входит в это множество, когда `len(scheduled_loras) == max_loras`. Запрос не отклоняется — он откладывается (`step_skipped_waiting`) и будет рассмотрен на следующем шаге.

**Захват CUDA graph.** `get_lora_capture_cases()` при `cudagraph_specialize_lora=True` (дефолт `CompilationConfig`) и `--no-specialize-active-lora` возвращает `[0, max_loras + 1]`, то есть два набора графов на каждый размер батча. С `--specialize-active-lora` набор расширяется до степеней двойки вплоть до `max_loras` плюс `max_loras + 1`.

## Значения и формат

- Целое ≥ 1. `0` и отрицательные отвергаются валидацией pydantic (`ge=1`).
- Специальных значений нет; «безлимита» не существует.
- Значение не обязано совпадать с числом зарегистрированных адаптеров: адаптеров может быть больше (до `--max-cpu-loras`), но одновременно активными будут только `max_loras`.
- `--max-cpu-loras` меньше `max_loras` — ошибка конфигурации: `max_cpu_loras (N) must be >= max_loras (M).`

## Когда использовать

- Дефолт `1` подходит ровно для одного адаптера в один момент времени. Если клиенты обращаются к двум и более адаптерам одновременно, при `1` запросы будут чередоваться по шагам и latency вырастет — поднимайте до реального числа одновременно востребованных адаптеров.
- Держите значение равным ожидаемой конкурентности по адаптерам, а не общему числу адаптеров: каждая лишняя единица — постоянно занятая VRAM во всех обёрнутых слоях.
- Не поднимайте выше `--max-num-seqs`: больше разных адаптеров, чем запросов в батче, всё равно не окажется.

## Влияние на производительность и память

- **VRAM.** Линейно масштабирует все буферы адаптеров. Ориентир: удвоение `--max-loras` удваивает постоянно занятые LoRA-буферы, и ровно на столько же уменьшается доступный KV-cache при том же `--gpu-memory-utilization`.
- **RAM хоста.** Косвенно: при незаданном `--max-cpu-loras` CPU-кэш адаптеров получает ту же ёмкость.
- **Время старта.** Растёт через профилирование: `maybe_setup_dummy_loras` создаёт ровно `max_loras` фиктивных адаптеров, и с `--specialize-active-lora` число захватываемых CUDA graph растёт логарифмически по `max_loras`.
- **Throughput.** Выше значение — меньше отложенных запросов и меньше перезагрузок адаптеров с CPU, но дороже каждый шаг: ядра LoRA работают по числу активных адаптеров в батче, а без `--specialize-active-lora` метаданные всегда рассчитаны на `max_loras + 1` групп.

## Взаимодействие с другими аргументами

- `--max-cpu-loras`: должен быть `>= max_loras`, иначе старт падает. Пустое значение ⇒ равен `max_loras`.
- `--max-lora-rank`: второй множитель в размере тех же буферов; память растёт как произведение.
- `--lora-target-modules`: сокращает число обёрнутых слоёв, то есть число буферов, которые множатся на `max_loras`.
- `--fully-sharded-loras`: при TP > 1 делит часть размерностей на `tensor_parallel_size`, уменьшая слот.
- `--specialize-active-lora`: меняет способ захвата CUDA graph по числу активных адаптеров; набор точек захвата выводится из `max_loras`.
- `--max-num-seqs`: верхняя граница числа запросов в шаге; больше разных адаптеров, чем запросов, быть не может.
- `--gpu-memory-utilization`: общий бюджет, из которого вычитаются LoRA-буферы.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: max_cpu_loras (2) must be >= max_loras (4).` **Причина:** CPU-кэш меньше числа GPU-слотов. **Лечение:** поднять `--max-cpu-loras` или снизить `--max-loras`.
- **Симптом:** `RuntimeError: Number of requested LoRAs (N) is greater than the number of GPU LoRA slots (M).` **Причина:** в один шаг попало больше разных адаптеров, чем слотов; штатно это отсекает планировщик, так что сообщение указывает на рассинхронизацию конфигурации воркера и планировщика. **Проверка:** одинаковый ли `--max-loras` во всех процессах. **Лечение:** привести конфигурацию к одному значению.
- **Симптом:** `ValueError: No free lora slots` при активации. **Причина:** та же — попытка активировать больше адаптеров, чем слотов.
- **Симптом:** запросы к «второму» адаптеру ждут дольше, хотя GPU не загружен. **Причина:** `--max-loras 1`, планировщик откладывает запрос с другим адаптером. **Проверка:** метка `waiting_lora_adapters` в `vllm:lora_requests_info` непуста при свободном KV-cache. **Лечение:** поднять `--max-loras`.
- **Подтверждение принятого значения:** метка `max_lora` в `vllm:lora_requests_info` в `/metrics`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-lora --max-loras 4 --max-cpu-loras 8 --max-lora-rank 16
```

```bash
vllm serve /models/Qwen3-4B --enable-lora --max-loras 2 --max-num-seqs 8 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/lora.py`
- `vllm/vllm/lora/model_manager.py`
- `vllm/vllm/lora/worker_manager.py`
- `vllm/vllm/lora/layers/base_linear.py`
- `vllm/vllm/lora/ops/triton_ops/lora_kernel_metadata.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/worker/gpu/lora_utils.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/docs/features/lora.md`
