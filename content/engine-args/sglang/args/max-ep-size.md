---
schema: 1
engine: sglang
primaryName: "--max-ep-size"
title: "--max-ep-size"
summary: Потолок EP-группы для elastic EP — под него заранее выделяются слоты активных рангов и RDMA-буферы диспетчера. Работает только вместе с `--elastic-ep-backend`.
group: parallel
related:
  - --elastic-ep-backend
  - --elastic-ep-join-mode
  - --elastic-ep-join-rank-offset
  - --elastic-ep-initial-size
  - --elastic-ep-scale-timeout
  - --ep-size
  - --tp-size
  - --dp-size
  - --enable-dp-attention
  - --enable-dp-lm-head
  - --moe-a2a-backend
  - --load-balance-method
  - --enable-dp-attention-local-control-broadcast
---

# --max-ep-size

## Кратко

`--max-ep-size` относится исключительно к elastic EP — режиму, в котором к работающему серверу можно на ходу присоединять новые TP-группы. Он объявляет верхнюю границу, до которой EP-группа сможет вырасти, и эта граница закладывается в память **на старте**: под нее выделяются массив активных рангов, слоты воркеров в `DataParallelController` и RDMA-буферы NIXL. Поднять потолок после запуска нельзя — только рестарт. Без `--elastic-ep-backend` аргумент запрещен.

## Оригинальная справка

```text
Maximum EP size the server can scale to at runtime. Pre-allocates active-rank state and backend buffers to this size. Defaults to the launch-time world size.
```

## Паспорт аргумента

- Флаги: `--max-ep-size`
- Группа: `parallel`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: строго положительное целое; проверяется `assert self.max_ep_size > 0` с текстом `--max-ep-size must be a positive integer.`
- Значение по умолчанию: `null`. Не «ноль» и не «без ограничения» — при незаданном значении потребители подставляют текущий world size: `max_ep_size or world_size` в NIXL-диспетчере и в `ElasticEPStateManager`, `server_args.max_ep_size or server_args.dp_size` в `DataParallelController`
- Эффективное значение: не переписывается. Но само его наличие меняет чужие: связка «`elastic_ep_backend` задан **и** `max_ep_size > tp_size`» включает режим `scaling_active`, который принудительно ставит `enable_dp_attention_local_control_broadcast = True` и добавляет длинный список обязательных условий (см. ниже)
- Где объявлен: `ServerArgs.max_ep_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но применим только в экспериментальном контуре elastic EP
- Этап применения: `__post_init__` (`_handle_elastic_ep`) → `PortArgs`/`DataParallelController` (резервирование слотов воркеров) → `init_distributed_environment(max_world_size=…)` → создание буферов диспетчера NIXL → runtime-scale по запросу

## Что меняет в движке

- **Слоты воркеров.** `DataParallelController.max_dp_size = server_args.max_ep_size or server_args.dp_size`; проверяется `max_dp_size >= dp_size` с текстом `--max-ep-size (…) must be >= --dp (…)`. Массивы `dp_active`, `status`, `workers` создаются длиной `max_dp_size`, и на узле с `node_rank == 0` сразу биндится `max_dp_size` PUSH-сокетов — они ждут будущих присоединяющихся групп.
- **Процессная группа.** `max_world_size` пробрасывается в `init_distributed_environment` и `initialize_model_parallel`. Для backend'а `mooncake` при `max_world_size > world_size` создается тензор `active_ranks` длиной `max_ep_size` и `MooncakeBackendOptions(active_ranks, recovered_rank, max_world_size)`; проверяется `max_world_size >= len(ranks)`.
- **Буферы диспетчера.** NIXL считает `nixl_max_ranks = max_ep_size` и берет `Buffer.get_rdma_size_hint(num_max_dispatch_tokens_per_rank, hidden_size, nixl_max_ranks, max_num_global_experts)`, где `max_num_global_experts = nixl_max_ranks * num_local_experts`. То есть RDMA-память резервируется под **максимальный**, а не под текущий размер группы. Туда же уходит маска `_mask_buffer` длиной `max_ep_size`.
- **DP-ранг.** При заданном `max_ep_size` и elastic-backend'е `initialize_dp_attention` переопределяет `_ATTN_DP_RANK = tp_rank + ep_join_rank_offset` — ранги живут в расширенном глобальном пространстве.

## Значения и формат

- Целое > 0. `0` и отрицательные отвергаются `assert`.
- Не задан — потолок равен world size на момент запуска, то есть масштабирование фактически невозможно.
- `max_ep_size > tp_size` — это и есть условие «scale-up включен». Значение, равное `tp_size`, аргумент как таковой не ломает, но и ничего не открывает.
- Присоединяющаяся группа обязана уложиться: `ep_join_rank_offset + tp_size <= max_ep_size`, иначе `Elastic EP joining group exceeds --max-ep-size`.

## Когда использовать

- Только когда выбран `--elastic-ep-backend mooncake` и планируется runtime scale-up. Значение выбирается как максимальное число рангов, до которого развертывание вырастет за жизнь процесса.
- Не задавайте «с запасом ×4»: буферы RDMA и массивы состояний выделяются сразу, это прямой расход памяти при нулевой пользе, пока группа не выросла.
- Не задавайте вовсе в обычном (не elastic) развертывании — старт упадет.

## Влияние на производительность и память

- **VRAM/RDMA.** Основная статья: `num_rdma_bytes` у NIXL считается от `max_ep_size`, а не от текущего размера. Разница между `--max-ep-size 32` и `--max-ep-size 8` при восьми рангах — это чистый резерв, занятый с первой секунды.
- **Хост.** `max_dp_size` ZMQ-сокетов на rank-0 узле, плюс массивы состояний.
- **Throughput/latency.** Пока группа не выросла, влияния нет; после scale-up добавляются подключения рангов (`_connect_ranks`) и пересчет раскладки экспертов.
- **Ограничение режима.** `scaling_active` требует выключенных CUDA graph (и decode, и prefill) — это заметный удар по decode-latency, но он следствие elastic-режима в целом, а не самого аргумента.

## Взаимодействие с другими аргументами

- `--elastic-ep-backend`: обязателен (`--max-ep-size requires --elastic-ep-backend to be set.`); для scale-up конкретно `mooncake`.
- `--elastic-ep-initial-size`: допустим только когда `max_ep_size > tp_size`; у первичного развертывания обязан равняться его `tp_size`.
- `--elastic-ep-join-mode scale` / `--elastic-ep-join-rank-offset`: присоединяющаяся группа запускается с `--node-rank 1` и ненулевым offset; `offset + tp_size <= max_ep_size`.
- При активном scale-up обязательны: `--enable-dp-attention`, `--enable-dp-lm-head`, `--moe-a2a-backend nixl`, `--load-balance-method round_robin`, `--tokenizer-worker-num 1`, `--pp-size 1`, `--attn-cp-size 1`, `--moe-dp-size 1`, `ep_size == tp_size`, `dp_size == tp_size`, отключенные CUDA graph; запрещены `--use-ray` и `--enable-elastic-expert-backup`.
- `--enable-dp-attention-local-control-broadcast` включается автоматически.
- `--dp-size`: `max_ep_size` служит потолком и для числа DP-слотов контроллера.

## Типовые проблемы и диагностика

- `AssertionError: --max-ep-size requires --elastic-ep-backend to be set.` — аргумент задан вне elastic-контура.
- `AssertionError: --max-ep-size must be a positive integer.` — ноль или отрицательное.
- `AssertionError: --max-ep-size (N) must be >= --dp (M).` — потолок меньше стартового числа DP-групп.
- `ValueError: [Elastic EP] add_elastic_workers: slot_offset=… + slot_count=… exceeds max_dp_size=…. Restart with a larger --max-ep-size.` и ответ на scale-запрос `new_ep_size (…) exceeds --max-ep-size (…). Restart with a larger --max-ep-size.` — попытка вырасти выше потолка; лечится только рестартом с бо́льшим значением.
- `AssertionError: --max-ep-size (N) must be >= world_size (M).` из `ElasticEPStateManager.init` — потолок меньше уже собранного world size.
- `AssertionError: Elastic EP joining group exceeds --max-ep-size (join_target=…, max_ep_size=…).` — неверный `--elastic-ep-join-rank-offset` у присоединяющейся группы.
- Подтверждение принятого значения — строка `Using NIXL EP (world_size=…, max_ep_size=…, rank=…, global_rank=…, offset=…)` при инициализации диспетчера и дамп `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --ep-size 8 --enable-dp-attention --enable-dp-lm-head --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --load-balance-method round_robin --disable-cuda-graph --dist-init-addr 10.0.0.10:50000
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --ep-size 8 --enable-dp-attention --enable-dp-lm-head --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --elastic-ep-join-mode scale --elastic-ep-join-rank-offset 8 --elastic-ep-initial-size 8 --node-rank 1 --load-balance-method round_robin --disable-cuda-graph --dist-init-addr 10.0.0.10:50000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/layers/moe/token_dispatcher/nixl.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
- `sglang/python/sglang/srt/elastic_ep/elastic_ep.py`
