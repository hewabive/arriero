---
schema: 1
engine: sglang
primaryName: "--pp-size"
title: "--pp-size"
summary: Делит слои модели на последовательные стадии, каждая на своей группе GPU. Инструмент для длинного контекста на нескольких узлах, несовместимый с overlap-планировщиком и спекулятивным декодированием.
group: parallel
related:
  - --tp-size
  - --pp-max-micro-batch-size
  - --pp-async-batch-depth
  - --disable-overlap-schedule
  - --enable-dynamic-chunking
  - --chunked-prefill-size
  - --nnodes
  - --speculative-algorithm
  - --min-free-slots-delay
  - --mem-fraction-static
---

# --pp-size

## Кратко

`--pp-size` разрезает модель по слоям: стадия `k` держит только диапазон `[start_layer, end_layer)` и передает активации следующей стадии по P2P. В отличие от `--tp-size`, обмен идет один раз на границе стадии, а не на каждом слое, поэтому pipeline лучше переживает межузловые линки. Плата — пузыри в конвейере, отказ от overlap-планировщика и от спекулятивного декодирования. Значение по умолчанию `1`; движок переписывает его только в одном месте — принудительно ставит `1` для диффузионных LLM.

## Оригинальная справка

```text
The pipeline parallelism size.
```

## Паспорт аргумента

- Флаги: `--pp-size`, `--pipeline-parallel-size`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет; осмысленный диапазон — от 1 до числа узлов (или числа групп GPU)
- Значение по умолчанию: `1`
- Эффективное значение: совпадает с заданным, кроме `_handle_dllm_inference`, где при `pp_size > 1` печатается `Pipeline parallelism is disabled because of using diffusion LLM inference` и значение принудительно становится `1`
- Где объявлен: `ServerArgs.pp_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_pipeline_parallelism` (предупреждение о несовместимости с overlap) → `check_server_args` (проверки делимости и совместимости) → запуск `pp_size * tp_size` процессов → `initialize_model_parallel` (PP-группы) → разбиение слоев в `get_pp_indices` → выделение KV-пула только под локальные слои

## Что меняет в движке

`world_size = tp_size * pp_size`, глобальный ранг — `tp_size * pp_rank + tp_rank`. PP-группы строятся в `initialize_model_parallel`: при `tp_size=2, pp_size=4` и восьми картах TP-группы это `[g0,g1] [g2,g3] [g4,g5] [g6,g7]`, PP-группы — `[g0,g2,g4,g6]` и `[g1,g3,g5,g7]`.

Слои раскладываются по стадиям в `get_pp_indices` (`distributed/utils.py`): базово поровну, остаток отдается **последним** стадиям. Переменная окружения `SGLANG_PP_LAYER_PARTITION` (список через запятую, длиной ровно `pp_size`, суммой ровно `num_hidden_layers`) задает разбиение вручную; апстрим рекомендует ставить более крупные куски на старшие ранги, например `SGLANG_PP_LAYER_PARTITION=15,15,15,16` для DeepSeek-V3.1 на четырех стадиях.

KV-пул выделяется только под слои своей стадии: конфигуратор передает `start_layer`/`end_layer` и считает `cell_size` по `num_effective_layers`. Для гибридных mamba-моделей учитывается худшая по числу слоев стадия, чтобы все ранги посчитали одинаковый пул без коллектива.

Планировщик работает микробатчами: `_pp_send_pyobj_to_next_stage` использует `async_send` и возвращает `P2PWork`, синхронизация откладывается до `_pp_commit_comm_work`; отдельные потоки `forward_stream`/`copy_stream` перекрывают вычисления и D2H-копирование.

## Значения и формат

- Целое ≥ 1. `1` — pipeline выключен.
- `(tp_size * pp_size) % nnodes == 0` обязательно (`check_server_args`).
- Раскладка по узлам: `pp_size_per_node = max(pp_size // nnodes, 1)`, `nnodes_per_pp_rank = max(nnodes // pp_size, 1)`. Типовые конфигурации — либо одна стадия на узел (`pp_size == nnodes`), либо несколько узлов на стадию.
- Число слоев на `pp_size` делить не обязательно: остаток распределяется по последним стадиям.

## Когда использовать

- Межузловое развертывание, где TP упирается в пропускную способность линка: PP общается только на границах стадий. Апстрим-статья и `pipeline_parallelism.mdx` описывают это как основной сценарий — снижение TTFT на ультрадлинных входах.
- Ультрадлинный контекст: разные чанки одного запроса обрабатываются разными стадиями одновременно; в связке с `--enable-dynamic-chunking` это заметно режет TTFT.
- Не включайте PP на одном узле с NVLink: там TP почти всегда быстрее, а PP добавляет пузыри и отбирает overlap-планировщик.
- Не включайте PP, если нужны спекулятивное декодирование или overlap-расписание — это взаимоисключающие вещи, старт упадет.

## Влияние на производительность и память

- **VRAM.** Веса и KV-пул делятся по слоям почти линейно: стадия из 15 слоев из 61 держит примерно четверть весов и четверть KV-пула. Это единственный способ уменьшить и веса, и KV, не трогая attention-шардирование.
- **Резерв под активации.** `pp_size` входит в автоподбор `--mem-fraction-static` слагаемым `tp_size * pp_size / 8 * 1024` МиБ.
- **TTFT.** Основной выигрыш при длинном входе: чанки конвейеризуются.
- **Пузыри.** Время слоя растет с длиной префикса, поэтому фиксированный `--chunked-prefill-size` дает рассинхрон стадий. Лечится `--enable-dynamic-chunking` и подбором `SGLANG_DYNAMIC_CHUNKING_SMOOTH_FACTOR` (по замерам апстрима — 0.6…0.85).
- **Decode-latency.** Ухудшается: каждый шаг проходит через все стадии, а overlap-расписание отключено.
- **Хост.** Процессов становится `tp_size * pp_size` на весь запуск (в разбивке по узлам).

## Взаимодействие с другими аргументами

- `--tp-size`: перемножаются в world size; на каждом узле поднимается `pp_size_per_node * tp_size_per_node` процессов.
- `--disable-overlap-schedule`: при `pp_size > 1` в лог идет `Pipeline parallelism is incompatible with overlap schedule.`, а `check_server_args` требует `disable_overlap_schedule == True`.
- `--speculative-algorithm`: должен быть не задан — то же требование `check_server_args`.
- `--min-free-slots-delay`: должен быть не задан (порог свободных слотов при микробатчах может никогда не сработать).
- `--pp-max-micro-batch-size` / `--pp-async-batch-depth`: настройка конвейера; `pp_max_micro_batch_size` — либо `None` (авто), либо ≥ 1.
- `--enable-dynamic-chunking`: рекомендованный спутник PP; связка `enable_dynamic_chunking && pp_size > 1` поднимает потолок prefill-буфера до `max(chunked_prefill_size, max_prefill_tokens, ceil(chunked_prefill_size * 1.25))` (`max_prefill_buffer_tokens`), то есть чанк может расти выше заданного значения.
- `--nnodes`: делимость `tp_size * pp_size` на число узлов.
- Несовместимо: `--enable-prefill-cp`/`--moe-dp-size > 1` (`PP is not supported with context parallelism`), elastic EP (`PP size should be set to 1 under elastic EP`), DWDP (`DWDP requires pp_size == 1`), PD-Multiplexing, `--mm-feature-transport cuda_vmm`, `--enable-unified-memory` в PD-режиме, `--enable-dsa-cache-layer-split`. `--optimistic-prefill-attempts` при `pp_size > 1` в PD-prefill молча обнуляется с предупреждением.

## Типовые проблемы и диагностика

- `AssertionError: Pipeline parallelism is not compatible with overlap schedule, speculative decoding` — добавьте `--disable-overlap-schedule` и уберите `--speculative-algorithm`.
- `AssertionError: tp_size must be divisible by number of nodes` — нарушено `(tp_size * pp_size) % nnodes == 0`.
- `ValueError: len(partitions)=3 does not match pp_size=4` или `sum(partitions)=60 does not match num_hidden_layers=61` — ошибка в `SGLANG_PP_LAYER_PARTITION`.
- Низкая утилизация GPU на старших рангах, TTFT хуже, чем при том же числе карт под TP — классические пузыри конвейера: включите `--enable-dynamic-chunking`, увеличьте начальный `--chunked-prefill-size` в 2–3 раза и сместите остаток слоев на старшие ранги.
- В логе при `pp_size > 1` каждая строка получает префикс ` PP<rank>`; принятое значение — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.1 --tensor-parallel-size 8 --pp-size 4 --nnodes 4 --node-rank 0 --dist-init-addr 10.0.0.10:50000 --disable-overlap-schedule --chunked-prefill-size 4096
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.1 --tensor-parallel-size 8 --pp-size 4 --nnodes 4 --node-rank 0 --dist-init-addr 10.0.0.10:50000 --disable-overlap-schedule --chunked-prefill-size 12288 --enable-dynamic-chunking
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/utils.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/docs/docs/advanced_features/pipeline_parallelism.mdx`
