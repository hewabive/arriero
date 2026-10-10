---
schema: 1
engine: sglang
primaryName: "--nnodes"
title: "--nnodes"
summary: Сколько машин участвует в одном экземпляре. Задается одинаково на всех узлах и определяет, какие TP/PP-ранги поднимет каждый из них; `tp_size * pp_size` обязано делиться на это число.
group: parallel
related:
  - --node-rank
  - --dist-init-addr
  - --tp-size
  - --pp-size
  - --dp-size
  - --enable-dp-attention
  - --dist-timeout
  - --mm-feature-transport
  - --weight-cache-mode
  - --base-gpu-id
---

# --nnodes

## Кратко

`--nnodes` объявляет, на скольких машинах живет один экземпляр SGLang. Значение одинаково на всех узлах; различает их только `--node-rank`. Аргумент ничего не «распределяет» сам — он лишь делит уже объявленные `--tp-size` и `--pp-size` на узлы, поэтому первая проверка при многоузловом запуске — делимость `(tp_size * pp_size) % nnodes == 0`. Значение по умолчанию `1`. Собственно рандеву (адрес, порты, таймаут) описано в `dist-init-addr.md` — здесь только топология.

## Оригинальная справка

```text
The number of nodes.
```

## Паспорт аргумента

- Флаги: `--nnodes`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет; делители `tp_size * pp_size`
- Значение по умолчанию: `1`
- Эффективное значение: совпадает с заданным — ни один шаг резолва его не декларирует. Зато оно влияет на соседей: при `nnodes > 1` запрещается `--mm-feature-transport cuda_ipc`, а авто-выбор транспорта признаков (`handle_multimodal_feature_transport`) дает `cpu` — кроме GB200/GB300 с MNNVL и смонтированным IMEX-каналом, где для моделей с поддержкой выбирается `cuda_vmm`; на одном узле авто-выбор тоже дает `cpu`, а `cuda_ipc` включается только явно. Custom all-reduce v2 резолв больше не трогает (прежний `_handle_custom_all_reduce_v2_multinode` удален): выбор делается в рантайме по топологии группы
- Где объявлен: `python/sglang/srt/arg_groups/fields/parallel.py:Parallel.nnodes`
- Статус: обычный
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline` (`handle_environment_variables` → `handle_multimodal_feature_transport` в `arg_groups/serving_hook.py`, ветки модельных настроек) → `check_server_args` (`arg_groups/validation_hook.py`, вызывается из `Engine._launch_subprocesses` после резолва; делимость) → `PortArgs.init_new` → `_calculate_rank_ranges` (какие ранги поднимает этот узел) → `init_distributed_environment`

## Что меняет в движке

### Раскладка рангов по узлам

`_calculate_rank_ranges` (`entrypoints/engine.py`, ровно то же продублировано в `DataParallelController.launch_tensor_parallel_group`):

```python
pp_size_per_node    = max(pp_size // nnodes, 1)
nnodes_per_pp_rank  = max(nnodes // pp_size, 1)
pp_rank_range       = range(pp_size_per_node *  (node_rank // nnodes_per_pp_rank),
                            pp_size_per_node * ((node_rank // nnodes_per_pp_rank) + 1))
nnodes_per_tp_group = nnodes_per_pp_rank
tp_size_per_node    = tp_size // nnodes_per_tp_group
tp_rank_range       = range(tp_size_per_node *  (node_rank % nnodes_per_tp_group),
                            tp_size_per_node * ((node_rank % nnodes_per_tp_group) + 1))
```

Два практических случая:

- **TP через узлы** (`--tp-size 4 --nnodes 2`, без PP): `tp_size_per_node = 2`; узел 0 поднимает ранги 0–1, узел 1 — ранги 2–3. Каждый узел занимает по две карты, начиная с `--base-gpu-id`.
- **PP по узлам** (`--tp-size 8 --pp-size 4 --nnodes 4`): `nnodes_per_pp_rank = 1`, значит `tp_size_per_node = 8` — каждый узел держит одну стадию целиком со всеми восемью TP-рангами.

Мировой размер группы — `tp_size * pp_size` независимо от числа узлов; глобальный ранг считается как `tp_size * pp_rank + tp_rank`.

### Кто что запускает

HTTP-сервер, tokenizer и detokenizer живут только на узле с `--node-rank 0`; остальные узлы поднимают свои scheduler-процессы и блокируются. Детали — в `node-rank.md`.

### Что отключается на нескольких узлах

- `--mm-feature-transport cuda_ipc`: `ValueError: --mm-feature-transport=cuda_ipc only supports a single node.` Авто-подбор `cuda_ipc` не выбирает и на одном узле — он включается только явно; на нескольких узлах авто-подбор дает CPU-транспорт, а на GB200/GB300 с MNNVL/IMEX — `cuda_vmm` для моделей, которые его поддерживают.
- Custom all-reduce v2: резолв аргументов `SGLANG_OPT_USE_CUSTOM_ALL_REDUCE_V2` больше не сбрасывает, а переменной `SGLANG_ENABLE_CUSTOM_ALL_REDUCE_V2_MULTINODE` больше нет. При создании группы `dispatch_custom_allreduce` (`distributed/device_communicators/custom_all_reduce.py`) берет v2 для межузловой группы, только если `can_use_custom_all_reduce_v2` видит один NVLink-клик (MNNVL) и VMM-аллокатор; остальные межузловые группы уходят на NCCL.
- Aiter AllReduce Fusion для DeepSeekV3/GPT-OSS рассматривается только при `nnodes == 1`.
- `--weight-cache-mode daemon` требует заданного `--dist-init-addr`.

## Значения и формат

- Целое ≥ 1. `1` — обычный одноузловой запуск.
- `(tp_size * pp_size) % nnodes == 0` — жесткая проверка `check_server_args` с текстом `tp_size must be divisible by number of nodes` (в тексте сказано про `tp_size`, но проверяется произведение).
- Одинаковое значение на всех узлах. Расхождение приводит не к ошибке, а к тому, что часть рангов никогда не появится и группа не соберется.
- `--dp-size > 1` без `--enable-dp-attention` при `nnodes != 1` запрещен: `multi-node data parallel is not supported unless dp attention!`.
- Проверка делимости пропускается только в режиме elastic EP `--elastic-ep-join-mode scale`.

## Когда использовать

- Модель не помещается на одну машину, и нужен TP или PP через узлы — единственная причина.
- PP обычно предпочтительнее TP на межузловом линке: он обменивается только на границах стадий. См. `pp-size.md`.
- Не используйте `--nnodes` для «горизонтального масштабирования» пропускной способности: несколько независимых экземпляров за роутером дают лучшую изоляцию и наблюдаемость, чем один растянутый на узлы экземпляр.
- Не растягивайте TP на узлы через медленный Ethernet: каждый слой делает all-reduce, и decode-latency вырастет кратно.

## Влияние на производительность и память

- **VRAM.** Сам по себе не влияет: делится то, что уже задано `--tp-size`/`--pp-size`.
- **Коллективы.** Часть all-reduce уходит на межузловой линк. Вне MNNVL-клика custom all-reduce v2 для межузловой группы не выбирается — остается общий путь NCCL.
- **Время старта.** Растет: добавляется ожидание рандеву; при недоступном узле старт висит до `--dist-timeout`.
- **Мультимодальные модели.** Дешевый `cuda_ipc`-транспорт признаков становится недоступен даже явным указанием; на больших изображениях CPU-транспорт заметно дороже по TTFT. На одном узле его хотя бы можно включить руками — здесь нет.
- **Хост.** На каждом узле поднимается `pp_size_per_node * tp_size_per_node` процессов.

## Взаимодействие с другими аргументами

- `--node-rank`: индекс этого узла, `0…nnodes-1`.
- `--dist-init-addr`: обязателен при значении > 1 (формально опционален — ошибки не будет, будет дедлок); механика в `dist-init-addr.md`.
- `--tp-size` / `--pp-size`: произведение делится на `nnodes`; отсюда `tp_size_per_node` и `pp_size_per_node`.
- `--dp-size`: native DP на нескольких узлах запрещен, нужен `--enable-dp-attention`.
- `--enable-dp-attention`: переводит служебный транспорт на TCP, что и делает многоузловой DP возможным; добавляет порт `load_collector` (`port_base + 5`), который проверяется только при `nnodes > 1`.
- `--dist-timeout`: верхняя граница ожидания сборки группы.
- `--base-gpu-id` / `--gpu-id-step`: применяются локально на каждом узле.
- `--mm-feature-transport`, `--weight-cache-mode`: ограничения перечислены выше.

## Типовые проблемы и диагностика

- `AssertionError: tp_size must be divisible by number of nodes` — нарушено `(tp_size * pp_size) % nnodes == 0`.
- Старт висит на `Init torch distributed begin.` — не собрались все `tp_size * pp_size` рангов: разный `--nnodes` или `--dist-init-addr` на узлах, забытый узел, закрытый порт. Проверьте, что на каждом узле поднялось ожидаемое число процессов-scheduler'ов.
- `ValueError: --mm-feature-transport=cuda_ipc only supports a single node.`
- `AssertionError: multi-node data parallel is not supported unless dp attention!`
- `ValueError: Multi-node weight cache daemons (nnodes > 1) require --dist-init-addr …`
- Апстрим-документация советует при дедлоках на многоузловом TP дополнительно попробовать `--disable-cuda-graph`.
- Принятое значение — в дампе `server_args=` на каждом узле; фактические ранги узла — по префиксам ` TP<n>` в его логе.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --tensor-parallel-size 4 --nnodes 2 --node-rank 0 --dist-init-addr 10.0.0.10:50000
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.1 --tensor-parallel-size 8 --pp-size 4 --nnodes 4 --node-rank 2 --dist-init-addr 10.0.0.10:50000 --disable-overlap-schedule
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/parallel.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/serving_hook.py`
- `sglang/python/sglang/srt/arg_groups/validation_hook.py`
- `sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce.py`
- `sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce_v2.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- `sglang/docs/docs/advanced_features/pipeline_parallelism.mdx`
