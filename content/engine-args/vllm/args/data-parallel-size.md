---
schema: 1
engine: vllm
primaryName: "--data-parallel-size"
title: "--data-parallel-size"
summary: Число реплик модели (DP-рангов) в одном развертывании. Для плотной модели это просто N независимых копий за одним HTTP-портом, для MoE — связанная топология с синхронными forward'ами и общим EP/TP-слоем экспертов.
group: ParallelConfig
related:
  - --data-parallel-size-local
  - --data-parallel-rank
  - --data-parallel-start-rank
  - --data-parallel-address
  - --data-parallel-rpc-port
  - --data-parallel-backend
  - --data-parallel-external-lb
  - --data-parallel-hybrid-lb
  - --data-parallel-multi-port-external-lb
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --enable-expert-parallel
  - --api-server-count
  - --headless
  - --nnodes
  - --max-num-seqs
---

# --data-parallel-size

## Кратко

`--data-parallel-size N` запускает `N` реплик модели — каждая со своими весами, своим KV-cache и своим процессом «core engine». Это единственный флаг семейства `--data-parallel-*`, который обязателен: остальные девять только раскладывают эти `N` рангов по узлам, портам и режимам балансировки.

Этот документ — общее описание топологии DP. В файлах остальных `--data-parallel-*` расписано лишь то, какую роль/порт/ранг задает конкретный флаг и на каком узле его надо передать.

## Оригинальная справка

```text
Number of data parallel groups. MoE layers will be sharded according to
the product of the tensor, prefill-context, and data parallel sizes.
```

## Паспорт аргумента

- Флаги: `--data-parallel-size`, `-dp`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: не ограничены списком; валидация `ge=1`
- Значение по умолчанию: `Field(default=1, ge=1)` — то есть `1` при минимуме `1`
- Эффективное значение: при `data_parallel_size == 1` и не заданном `--data-parallel-size-local 0` `ParallelConfig.__post_init__` **перечитывает** размер из переменных окружения (`VLLM_DP_SIZE`, `VLLM_DP_RANK`, `VLLM_DP_RANK_LOCAL`, `VLLM_DP_MASTER_IP`, `VLLM_DP_MASTER_PORT`) — это offline/SPMD-путь. Для **не-MoE** модели каждый engine-процесс дополнительно вызывает `reconfigure_for_independent_dp_rank()` и работает с `data_parallel_size = 1`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.data_parallel_size`
- Этап применения: разбор CLI → `create_engine_config` → запуск engine-процессов и рукопожатие → инициализация process group → каждый forward (для MoE)

## Что меняет в движке

**Сколько процессов появится.** `ParallelConfig.world_size` — это `pipeline_parallel_size × tensor_parallel_size × prefill_context_parallel_size`, то есть число worker-процессов **внутри одного** DP-ранга. DP умножает это число: `world_size_across_dp = world_size × data_parallel_size`. `-dp 4 -tp 2` — это 4 engine-процесса по 2 worker'а, всего 8 GPU. Исключение: при `--distributed-executor-backend external_launcher` DP включается прямо в `world_size`.

**Плотная модель и MoE — два разных режима.** В `vllm/v1/engine/core.py` при старте engine-процесса:

- если модель MoE (`model_config.is_moe`), создается `DPEngineCoreProc`: ранги синхронизируются, при работе любого ранга остальные выполняют пустые «dummy» forward'ы, а слои экспертов образуют группу размера `DP × TP` (тензорным параллелизмом по умолчанию, экспертным — при `--enable-expert-parallel`);
- иначе вызывается `parallel_config.reconfigure_for_independent_dp_rank()`, который сбрасывает `data_parallel_size`/`data_parallel_size_local`/`data_parallel_rank` в 1/1/0. Ранги плотной модели полностью независимы: никакой синхронизации, никаких коллективов между ними. Остается только общий фронтенд с балансировкой.

**Кто балансирует.** Для online-развертывания есть четыре раскладки:

| Режим | Чем включается | Кто балансирует | Сколько HTTP-эндпоинтов |
| --- | --- | --- | --- |
| Internal LB (по умолчанию) | только `--data-parallel-size` | сам vLLM внутри API-сервера | один |
| Hybrid LB | `--data-parallel-hybrid-lb` или `--data-parallel-start-rank` | vLLM — между локальными рангами, внешний LB — между узлами | один на узел |
| External LB | `--data-parallel-external-lb` или `--data-parallel-rank` | целиком внешний | один на ранг |
| Multi-port external LB | `--data-parallel-multi-port-external-lb` | внешний, порты выдает локальный супервизор | один на локальный ранг + порт супервизора |

Больше одного режима одновременно — ошибка `Cannot use more than one data parallel load balancing mode.` из `vllm/entrypoints/cli/serve.py`.

**Число API-серверов.** При internal LB `--api-server-count` по умолчанию равен `--data-parallel-size` (в лог уходит `Defaulting api_server_count to data_parallel_size (N).`); при hybrid — `--data-parallel-size-local`; при external и multi-port — 1.

**Рукопожатие.** Ранг 0 поднимает ZMQ-ROUTER и ждет `HELLO`/`READY` от всех `dp_size` движков. Если все ранги локальные (`data_parallel_size_local == data_parallel_size`), транспорт — IPC-сокет, и `--data-parallel-rpc-port` вообще не используется; иначе — `tcp://<data-parallel-address>:<data-parallel-rpc-port>`.

## Значения и формат

- Целое `≥ 1`. `1` — DP выключен.
- Значение `0` и отрицательные отвергаются pydantic'ом (`ge=1`).
- Специальных значений нет; «не задано» = 1.
- Значение должно быть **одинаковым на всех узлах** одного развертывания. Оно входит в `ParallelConfig.compute_hash()` и попадает в проверку согласованности (см. диагностику ниже).
- `--data-parallel-size` не делит `--max-num-seqs`, `--max-num-batched-tokens` и `--gpu-memory-utilization`: каждое из них применяется **к рангу**. `-dp 4 --max-num-seqs 8` — это 32 одновременных последовательности на развертывание.

## Когда использовать

- На хосте с несколькими одинаковыми картами и моделью, которая целиком влезает в одну карту: `-dp N` дает почти линейный throughput и **не** платит за межкартовые коллективы, в отличие от `-tp N`. Для плотной модели это буквально N независимых серверов за одним портом.
- На MoE-модели вместе с `--enable-expert-parallel`: DP по слоям внимания + EP по экспертам — штатная раскладка для DeepSeek-подобных архитектур.
- Не используйте DP, чтобы «вместить модель побольше»: реплики не шардируют веса. Для этого нужны `--tensor-parallel-size` и `--pipeline-parallel-size`.
- В arriero каждый инстанс — отдельный процесс с собственной записью в реестре и собственной оценкой памяти. Часто проще завести N инстансов vLLM с разными `CUDA_VISIBLE_DEVICES`/`--device-ids` и раскидать их через прокси, чем поднимать один инстанс с `-dp N`: при DP arriero видит одну единицу управления, вытеснение и autostart работают только целиком (`docs/RESOURCE_MANAGEMENT.md`).

## Влияние на производительность и память

- **VRAM.** Умножает потребление на число рангов: веса и KV-cache копируются в каждый ранг. `--gpu-memory-utilization` — доля **на карту**, поэтому суммарный draw развертывания = доля × число задействованных карт.
- **Throughput.** Растет практически линейно по числу рангов для плотной модели. Для MoE — сублинейно: ранги обязаны идти в ногу, и незанятый ранг все равно выполняет dummy-проход.
- **Latency.** DP не ускоряет один запрос — только увеличивает число одновременных.
- **Время старта.** Каждый ранг грузит и профилирует модель самостоятельно; старт с `-dp 4` занимает столько же времени, что и один ранг, если хватает пропускной способности диска, и заметно дольше, если веса читаются с одного медленного тома.
- **RAM хоста.** N engine-процессов + N × world_size worker'ов; на больших N процесс API-сервера сам становится узким местом — тогда поднимают `--api-server-count` или переходят на hybrid/external LB.

## Взаимодействие с другими аргументами

- `--data-parallel-size-local`: сколько из `N` рангов живут на этом узле. По умолчанию — все `N` (для `mp`-бэкенда).
- `--data-parallel-rank` / `--data-parallel-start-rank`: включают external / hybrid LB и задают, какие именно ранги обслуживает этот запуск.
- `--data-parallel-address`, `--data-parallel-rpc-port`: адрес и порт рукопожатия, нужны только когда часть рангов удаленные.
- `--data-parallel-backend`: `mp` (по умолчанию) требует отдельного запуска на каждом узле, `ray` поднимает удаленные ранги одной командой.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--prefill-context-parallel-size`: перемножаются в `world_size` внутри ранга. `--prefill-context-parallel-size > 1` вместе с DP > 1 запрещен: `PCP does not support data parallelism yet.`
- `--enable-expert-parallel`: переводит слои экспертов с TP на EP внутри группы `DP × TP`.
- `--enable-eplb`: требует, чтобы `TP × PCP × DP > 1`.
- `--all2all-backend`: начинает что-то значить именно при DP > 1 (`ParallelConfig.use_all2all`).
- `--enable-dbo`: микробатчинг включается только при DP > 1 — `coordinate_batch_across_dp` при `data_parallel_size == 1` выходит сразу.
- `--headless`: узел без API-сервера, только engine-процессы; применим лишь в internal LB.

## Типовые проблемы и диагностика

- **Симптом:** старт «висит», в логе повторяется `Waiting for %d local, %d remote core engine proc(s) to connect.` **Причина:** ожидаются ранги, которые не пришли — второй узел не запущен, у него другой `--data-parallel-address`/`--data-parallel-rpc-port` или порт закрыт файрволом. **Важно:** таймаута здесь нет, `poller.poll(STARTUP_POLL_PERIOD_MS)` крутится с периодом 10 с бесконечно. **Лечение:** сверить адрес/порт/`--data-parallel-size-local` на всех узлах.
- **Симптом:** `Message from engine with unexpected data parallel rank: N`. **Причина:** ранг, которого голова не ждет, — разъехались `--data-parallel-size`, `--data-parallel-start-rank` или `--data-parallel-size-local`. **Лечение:** привести раскладку рангов к сумме, равной `--data-parallel-size`.
- **Симптом:** `Configuration mismatch detected for engine N. All DP workers must have identical configurations ... Worker hash: ..., Expected hash: ...` **Причина:** для MoE с координируемым DP сравнивается `ParallelConfig.compute_hash()`; разошелся аргумент, влияющий на коллективы (например `--enable-eplb`, `--all2all-backend`, `--tensor-parallel-size`). **Лечение:** запускать все узлы одной и той же командной строкой, меняя только `--node-rank`/`--data-parallel-start-rank`/`--data-parallel-rank`. Чисто «транспортные» поля (`--data-parallel-rank`, `--data-parallel-size-local`, адрес, порты, `--disable-custom-all-reduce`, `--distributed-executor-backend`) в хеш не входят и различаться могут.
- **Симптом:** `Non-MoE models do not support external data parallel mode. For external load balancing, launch independent vLLM instances without --data-parallel-* arguments.` **Причина:** external LB на плотной модели. **Лечение:** поднять независимые инстансы.
- **Симптом:** `World size (N) is larger than the number of available GPUs (M) in this node.` **Причина:** `pp × tp × pcp` не помещается на узел. Обратите внимание: это про `world_size` **одного** ранга, а не про `dp × tp`.
- **Подтверждение принятого значения:** в стартовой строке конфига видно `data_parallel_size=N`; при internal LB — `Defaulting api_server_count to data_parallel_size (N).`; при multi-node — `Launching %d data parallel engine(s) in headless mode, with head node address %s.`

## Примеры

```bash
vllm serve /models/Qwen3-4B --data-parallel-size 2 --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --data-parallel-size 4 --tensor-parallel-size 2 --api-server-count 2
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/vllm/v1/worker/dp_utils.py`
- `vllm/docs/serving/data_parallel_deployment.md`
- `vllm/docs/serving/parallelism_scaling.md`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
