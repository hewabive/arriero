---
schema: 1
engine: vllm
primaryName: "--distributed-timeout-seconds"
title: "--distributed-timeout-seconds"
summary: Таймаут, с которым создаются device-группы `torch.distributed` (NCCL). Поднимают его там, где ранги стартуют неравномерно — многоузловые развертывания, долгая загрузка весов, медленный диск.
group: ParallelConfig
related:
  - --cpu-distributed-timeout-seconds
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --data-parallel-size
  - --distributed-executor-backend
  - --nnodes
  - --master-addr
  - --master-port
  - --data-parallel-address
  - --load-format
  - --download-dir
---

# --distributed-timeout-seconds

## Кратко

Значение уходит параметром `timeout` во все вызовы, создающие device-группы `torch.distributed`: `init_process_group` для WORLD, `new_group`/`split_group` для подгрупп TP/PP/DP/EP и stateless-инициализацию не-gloo групп. Если флаг не задан, действует дефолт PyTorch (справка называет 600 с для NCCL).

Практическая ситуация ровно одна: ранг, который дольше всех добирается до рандеву — грузит веса с медленного тома или скачивает модель — не должен успеть выйти за таймаут остальных.

## Оригинальная справка

```text
Timeout in seconds for distributed operations (e.g., init_process_group).
If set, this value is passed to torch.distributed.init_process_group as the
timeout parameter. If None, PyTorch's default timeout is used (600s for NCCL).
Increase this for multi-node setups where model downloads may be slow.
```

## Паспорт аргумента

- Флаги: `--distributed-timeout-seconds`
- Группа argparse: `ParallelConfig`
- Тип значения: int (секунды)
- Допустимые значения: не ограничены списком; тип допускает `None`, поэтому `--help` показывает `None` дополнительным вариантом
- Значение по умолчанию: `null` — то есть «не передавать `timeout`, пусть решает PyTorch»
- Эффективное значение: не переопределяется движком; `None` означает дефолт PyTorch для выбранного backend'а
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.distributed_timeout_seconds`
- Этап применения: инициализация распределённого окружения worker'а — до загрузки весов и до профилирования памяти, а также при каждом последующем создании подгруппы

## Что меняет в движке

`gpu_worker.init_worker_distributed_environment` превращает число в `timedelta(seconds=...)` и передаёт в `init_distributed_environment(...)`, откуда оно доходит до `torch.distributed.init_process_group` (или до `_init_process_group_for_split_group` при `VLLM_DISTRIBUTED_USE_SPLIT_GROUP`).

Дальше то же значение читается ленивым хелпером `get_distributed_timeout_or_none()` (он берёт текущий `VllmConfig`) и применяется в:

- `torch.distributed.split_group(..., timeout=...)` для device-подгрупп в `GroupCoordinator`;
- `torch.distributed.new_group(..., timeout=device_timeout)` для тех же подгрупп на пути без `split_group`;
- `make_sibling_device_group(...)`;
- `stateless_init_torch_distributed_process_group(...)` для всех backend'ов, кроме `gloo` (для gloo используется `--cpu-distributed-timeout-seconds`).

`None` не превращается в число: он передаётся как `timeout=None`, и PyTorch подставляет собственный дефолт.

## Значения и формат

- Целое число секунд. Дробных значений нет.
- «Не задано» ⇒ дефолт PyTorch (по справке — 600 с для NCCL).
- Значение общее для всех device-групп процесса; отдельно для TP и для DP его не задать.
- Осмысленно задавать одинаковым на всех узлах: рандеву — двусторонняя операция, и толку от большого таймаута на одном узле нет, если второй отвалится раньше.

## Когда использовать

- Многоузловые развертывания, где веса тянутся из Hugging Face или с сетевого тома: пока один ранг качает модель, остальные уже стоят на рандеву.
- Диагностика: временно поднять до нескольких тысяч секунд, чтобы вместо обрыва по таймауту получить внятную картину — какие ранги дошли, а какие нет.
- Не используйте как «лечение» зависаний: если ранг не приходит из-за неверного адреса, порта или несогласованной топологии, увеличение таймаута лишь оттянет ту же ошибку. Сначала проверьте, что развертывание вообще может сойтись.
- На одиночной карте (`world_size == 1`, исполнитель `uni`) флаг бесполезен: process group не создаётся.

## Влияние на производительность и память

На VRAM, throughput и latency не влияет — это только верхняя граница ожидания при создании групп. Косвенное влияние на время старта: слишком маленькое значение обрывает старт на медленной загрузке весов, слишком большое затягивает обнаружение действительно недостижимого узла.

## Взаимодействие с другими аргументами

- `--cpu-distributed-timeout-seconds`: то же самое для gloo-групп (CPU-коллективы, DP-группа); задавать имеет смысл в паре.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--prefill-context-parallel-size`: определяют, сколько device-групп вообще создаётся.
- `--nnodes`, `--master-addr`, `--master-port`, `--data-parallel-address`: описывают рандеву, к которому применяется таймаут.
- `--distributed-executor-backend`: при `uni` (одна карта) значение не задействовано; при неправильно выбранном `uni` с `-tp > 1` именно этот таймаут определяет, как быстро процесс упадёт вместо бесконечного ожидания.
- `--load-format`, `--download-dir`: влияют на то, сколько времени ранг тратит до выхода на рандеву.

## Типовые проблемы и диагностика

- **Симптом:** старт многоузлового развертывания падает с таймаутом инициализации process group примерно через 10 минут. **Причина:** один из рангов ещё качал/читал веса. **Лечение:** поднять `--distributed-timeout-seconds` (и, симметрично, `--cpu-distributed-timeout-seconds`), либо предварительно прогреть кэш моделей на всех узлах.
- **Симптом:** таймаут стабильно срабатывает при любом значении. **Причина:** ранг физически не приходит — неверный адрес/порт или несовпадающий `world_size`. **Лечение:** сверить `--master-addr`/`--master-port`/`--data-parallel-address` и топологические флаги; увеличение таймаута тут не поможет.
- **Симптом:** предупреждение `Distributed backend nccl is not available; falling back to gloo.` **Причина:** NCCL недоступен в сборке. **Действие:** после отката на gloo релевантным становится `--cpu-distributed-timeout-seconds`.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `distributed_timeout_seconds=...`; сам факт инициализации виден по `world_size=%d rank=%d local_rank=%d distributed_init_method=%s backend=%s`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --tensor-parallel-size 2 --distributed-timeout-seconds 3600
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --distributed-timeout-seconds 3600 --cpu-distributed-timeout-seconds 3600
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/distributed/utils.py`
- `vllm/vllm/distributed/parallel_state.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/engine/arg_utils.py`
