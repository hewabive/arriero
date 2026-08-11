---
schema: 1
engine: vllm
primaryName: "--pipeline-parallel-size"
title: "--pipeline-parallel-size"
summary: Режет модель по слоям на N последовательных ступеней, по одной на ранг. Допускает неровное деление и не требует быстрого межкарточного линка, но добавляет пузыри конвейера и работает только для моделей с интерфейсом SupportsPP.
group: ParallelConfig
related:
  - --tensor-parallel-size
  - --prefill-context-parallel-size
  - --data-parallel-size
  - --distributed-executor-backend
  - --nnodes
  - --node-rank
  - --gpu-memory-utilization
  - --max-num-batched-tokens
  - --async-scheduling
  - --enable-elastic-ep
---

# --pipeline-parallel-size

## Кратко

`--pipeline-parallel-size N` (алиас `-pp`) делит слои модели на N последовательных ступеней: ранг 0 держит эмбеддинги и первые слои, последний ранг — последние слои и `lm_head`. Между ступенями передаются только скрытые состояния, а не тензоры каждого слоя, поэтому PP гораздо терпимее к медленному межкарточному линку, чем `--tensor-parallel-size`.

Плата — пузыри конвейера. Чтобы их закрыть, планировщик держит `pipeline_parallel_size` батчей одновременно в полёте, что умножает пиковый спрос на KV-cache и на память активаций.

Второе ограничение жёсткое: PP работает не для всех моделей, а только для тех, чья реализация в vLLM объявляет интерфейс `SupportsPP`.

## Оригинальная справка

```text
Number of pipeline parallel groups.
```

## Паспорт аргумента

- Флаги: `--pipeline-parallel-size`, `-pp`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: `Field(default=1, ge=1)` — целое не меньше 1
- Значение по умолчанию: `1`
- Эффективное значение: не переопределяется, но входит в `world_size = pipeline_parallel_size × tensor_parallel_size × prefill_context_parallel_size` и в `VllmConfig.max_concurrent_batches` (при `--async-scheduling` на Model Runner V2 это `pp_size + 1`, иначе `pp_size`)
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.pipeline_parallel_size`
- Этап применения: сборка `VllmConfig` (проверка поддержки модели, расчёт `world_size`) → запуск worker-процессов → построение слоёв (каждый ранг строит только свой диапазон) → планировщик (глубина очереди батчей) → forward

## Что меняет в движке

**Раскладка рангов.** Порядок — DP × PP × TP: `pp_rank = (rank // tensor_parallel_size) % pipeline_parallel_size` (`ModelConfig.get_layers_start_end_indices`).

**Разрез по слоям.** `get_pp_indices(num_hidden_layers, pp_rank, pp_size)` (`vllm/distributed/utils.py`) раскладывает слои по ступеням. При неровном делении остаток раздаётся не последней ступени, а предпоследним: `for i in range(2, remaining + 2): partitions[-i] += 1`. Мотив в докстринге: последняя ступень часто несёт дополнительный norm-слой, а первая и последняя — эмбеддинги и выходную проекцию, поэтому нагрузку выравнивают через середину. Факт неровного деления печатается: `Hidden layers were unevenly partitioned: [...]. This can be manually overridden using the VLLM_PP_LAYER_PARTITION environment variable`.

**Ручное разбиение.** Переменная окружения `VLLM_PP_LAYER_PARTITION` (не CLI-флаг) принимает список длин по одному числу на ступень; длина списка должна совпасть с `pp_size`, а сумма — с числом слоёв, иначе `ValueError`.

**Поддержка модели.** `ModelConfig.verify_with_parallel_config()` при `pp_size > 1` спрашивает реестр `registry.is_pp_supported_model(...)` и падает `NotImplementedError: Pipeline parallelism is not supported for this model. Supported models implement the ``SupportsPP`` interface.`

**Планировщик.** `VllmConfig.max_concurrent_batches` возвращает `pp_size` (или `pp_size + 1` при async-scheduling на V2 runner), это же число становится `batch_queue_size` в `EngineCore`. Отсюда `max_in_flight_tokens = max_concurrent_batches × max_num_batched_tokens` — верхняя оценка числа токенов, запланированных, но ещё не освобождённых.

**KV-cache.** Каждый ранг инстанцирует только свои слои, поэтому и KV-блоки он держит только для них: per-token стоимость KV-cache на карту падает примерно в `pp` раз.

## Значения и формат

- Целое ≥ 1. `1` — конвейера нет.
- Специальных значений нет; `0` отвергается валидацией `ge=1`.
- Число слоёв делить нацело **не обязательно** — в этом и есть преимущество перед TP. Практический потолок — число слоёв: ступень без слоёв бессмысленна.
- `pipeline_parallel_size × tensor_parallel_size × prefill_context_parallel_size` не должно превышать число видимых карт (для одного узла).

## Когда использовать

- **Карты не связаны NVLink.** Между ступенями идёт одна передача скрытых состояний на батч, а не all-reduce на каждый слой. На PCIe-only машине PP обычно даёт больше throughput, чем TP той же ширины.
- **Число карт не делит число голов внимания.** TP потребует делимости, PP — нет.
- **Несколько узлов.** Каноническая раскладка: `-tp` = число карт в узле, `-pp` = число узлов.
- **Не берите PP ради минимальной latency одного запроса.** При одиночном запросе конвейер пустой: ступени работают по очереди, и время ответа не улучшается, а слегка ухудшается за счёт передач.
- **Не берите PP, не проверив поддержку модели.** Отказ приходит на этапе сборки конфига, а не при первом запросе.

## Влияние на производительность и память

- **VRAM.** Веса на карту ≈ `общий размер / pp`, но деление неровное: ступень с эмбеддингами или с `lm_head` тяжелее. KV-cache на карту тоже уменьшается пропорционально числу локальных слоёв.
- **Спрос на KV-cache.** Растёт: планировщик держит `pp` батчей в полёте, и запросы из всех них одновременно занимают блоки. При переходе с `-pp 1` на `-pp 4` при том же `--max-num-batched-tokens` пиковое число незавершённых токенов вчетверо больше.
- **Время старта.** Как и у TP: `pp × tp × pcp` процессов, каждый со своей загрузкой шарда, компиляцией и захватом графов.
- **Throughput.** Растёт при достаточной нагрузке — конвейер заполняется. При редких запросах выигрыша нет.
- **Latency.** Слегка хуже, чем у одной карты той же ёмкости: добавляются межступенчатые передачи, а параллелизма внутри одного запроса конвейер не даёт.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`: перемножаются в `world_size`. Смешанная раскладка TP внутри узла + PP между узлами — стандартный рецепт `vllm/docs/serving/parallelism_scaling.md`.
- `--prefill-context-parallel-size`: третий множитель `world_size`.
- `--max-num-batched-tokens`: вместе с `pp` задаёт `max_in_flight_tokens`; при большом PP осмысленно пересмотреть размер батча.
- `--gpu-memory-utilization`: доля применяется каждым рангом к своей карте; PP освобождает место под KV-cache тем же способом, что TP (см. `gpu-memory-utilization.md`).
- `--async-scheduling`: на Model Runner V2 поднимает число одновременных батчей до `pp_size + 1`; на V1 async-scheduling с PP > 1 не поддержан и число батчей остаётся `pp_size`.
- `--distributed-executor-backend`: `external_launcher` вместе с PP > 1 не поддержан Model Runner V2 (`unsupported: pipeline parallelism with external_launcher`).
- `--nnodes`, `--node-rank`, `--master-addr`: multiprocessing-вариант многоузлового PP.
- `--enable-elastic-ep`: несовместим — `Elastic EP is not supported with pipeline parallelism`.
- `--speculative-config`: метод `eagle3` вместе с PP > 1 попадает в список неподдерживаемого V2 runner'ом.

## Типовые проблемы и диагностика

- **Симптом:** `Pipeline parallelism is not supported for this model. Supported models implement the ``SupportsPP`` interface.` **Причина:** реализация архитектуры в vLLM не объявляет PP. **Лечение:** использовать TP, либо другую модель/сборку vLLM.
- **Симптом:** в логе `Hidden layers were unevenly partitioned: [...]`. **Причина:** число слоёв не делится на `pp`. **Что делать:** обычно ничего; если перекос по памяти мешает, задать `VLLM_PP_LAYER_PARTITION` явным списком.
- **Симптом:** `len(partitions)=3 does not match pp_size=4` или `sum(partitions)=30 does not match num_hidden_layers=32`. **Причина:** неверный `VLLM_PP_LAYER_PARTITION`. **Лечение:** список ровно из `pp_size` чисел с суммой, равной числу слоёв.
- **Симптом:** одна карта уходит в OOM, остальные полупустые. **Причина:** ступень с эмбеддингами/`lm_head` или неровное разбиение. **Проверка:** строка про неровное разбиение и `Available KV cache memory` по рангам. **Лечение:** `VLLM_PP_LAYER_PARTITION` со сдвигом в пользу тяжёлой ступени, либо понижение `--gpu-memory-utilization`.
- **Симптом:** после включения PP выросли вытеснения (preemption). **Причина:** `pp` батчей в полёте одновременно занимают KV-cache. **Лечение:** снизить `--max-num-seqs`/`--max-num-batched-tokens` или поднять `--gpu-memory-utilization`.
- **Подтверждение принятого значения:** строка стартового конфига содержит `pipeline_parallel_size=N`; общее число worker-процессов равно `pp × tp × pcp`.

## Примеры

```bash
vllm serve /models/Qwen3-32B --pipeline-parallel-size 4 --tensor-parallel-size 1 --gpu-memory-utilization 0.9
```

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 8 --pipeline-parallel-size 2 --distributed-executor-backend ray
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/distributed/utils.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/model_executor/models/registry.py`
- `vllm/docs/serving/parallelism_scaling.md`
