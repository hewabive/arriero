---
schema: 1
engine: vllm
primaryName: "--cpu-distributed-timeout-seconds"
title: "--cpu-distributed-timeout-seconds"
summary: Таймаут gloo-групп `torch.distributed` — CPU-коллективов, сопровождающих каждую device-группу, и DP-группы, которая на gloo и работает. Парный к `--distributed-timeout-seconds`.
group: ParallelConfig
related:
  - --distributed-timeout-seconds
  - --data-parallel-size
  - --disable-nccl-for-dp-synchronization
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --nnodes
  - --data-parallel-address
  - --distributed-executor-backend
---

# --cpu-distributed-timeout-seconds

## Кратко

Рядом с каждой device-группой (NCCL) vLLM заводит CPU-группу на gloo — для координации, не требующей GPU. На gloo же целиком работает DP-группа: `stateless_init_dp_group()` создаёт её с `backend="gloo"`, потому что процесс движка может вообще не иметь CUDA-устройства.

`--cpu-distributed-timeout-seconds` задаёт таймаут именно для этих групп. `--distributed-timeout-seconds` их **не** покрывает: в коде это два разных хелпера.

## Оригинальная справка

```text
Timeout (in seconds) for cpu communication groups. If None, PyTorch's
default timeout is used (1800s for gloo).
```

## Паспорт аргумента

- Флаги: `--cpu-distributed-timeout-seconds`
- Группа argparse: `ParallelConfig`
- Тип значения: int (секунды)
- Допустимые значения: не ограничены списком; тип допускает `None`, поэтому `--help` показывает `None` дополнительным вариантом
- Значение по умолчанию: `null` — «не передавать `timeout`, пусть решает PyTorch»
- Эффективное значение: не переопределяется движком; `None` означает дефолт gloo (по справке — 1800 с)
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.cpu_distributed_timeout_seconds`
- Этап применения: создание CPU-подгрупп при инициализации распределённого окружения и инициализация DP-группы

## Что меняет в движке

Значение читается ленивым хелпером `get_cpu_distributed_timeout_or_none()` (через текущий `VllmConfig`) и применяется в трёх местах:

1. `torch.distributed.split_group(..., backend="cpu:gloo,<device>", timeout=...)` — CPU-подгруппа, создаваемая вместе с каждой device-подгруппой в `GroupCoordinator`.
2. `torch.distributed.new_group(ranks, backend="gloo", timeout=...)` — тот же смысл на пути без `split_group`.
3. `stateless_init_torch_distributed_process_group(...)` при `backend == "gloo"` — это и есть DP-группа (`ParallelConfig.stateless_init_dp_group`), а также прочие stateless gloo-группы.

Практическое следствие: все CPU-коллективы между DP-рангами — синхронизация «есть ли незавершённая работа» (`has_unfinished_dp`, `sync_dp_state`), согласование размера KV-cache (`sync_kv_cache_memory_size`), и — при включённом `--disable-nccl-for-dp-synchronization` — обмен размерами микробатчей — живут под этим таймаутом.

## Значения и формат

- Целое число секунд.
- «Не задано» ⇒ дефолт PyTorch для gloo (по справке — 1800 с).
- Значение одно на процесс; отдельно для CPU-подгруппы TP и для DP-группы его не задать.
- Задавать одинаковым на всех узлах: таймаут работает только если его выдерживают обе стороны.

## Когда использовать

- Вместе с `--distributed-timeout-seconds` на многоузловых развертываниях с медленной загрузкой весов: gloo-группы создаются на том же этапе, что и NCCL-группы, и упираются в свой собственный дефолт.
- Когда DP-ранги стартуют сильно вразнобой: DP-группа целиком на gloo, и именно её таймаут определяет, дождётся ли ранг 0 остальных.
- Когда включён `--disable-nccl-for-dp-synchronization` — тогда per-step обмен между DP-рангами тоже идёт через gloo-группу.
- Не нужен на одиночной карте без DP: gloo-группы там не создаются.

## Влияние на производительность и память

Не влияет: это только верхняя граница ожидания. Стоимость самих gloo-коллективов от таймаута не зависит.

## Взаимодействие с другими аргументами

- `--distributed-timeout-seconds`: покрывает device-группы (NCCL); эти два флага не заменяют друг друга и обычно ставятся парой.
- `--data-parallel-size`: DP-группа на gloo появляется только при DP > 1.
- `--disable-nccl-for-dp-synchronization`: переносит per-step синхронизацию DP на CPU-группу, повышая её значимость.
- `--tensor-parallel-size`, `--pipeline-parallel-size`: у каждой device-подгруппы есть парная CPU-подгруппа.
- `--distributed-executor-backend`: при `uni` без DP групп нет, флаг инертен.

## Типовые проблемы и диагностика

- **Симптом:** старт падает по таймауту gloo примерно через 30 минут при живом NCCL-таймауте. **Причина:** поднят только `--distributed-timeout-seconds`. **Лечение:** поднять и этот флаг.
- **Симптом:** DP-развертывание падает по таймауту на этапе согласования размера KV-cache. **Причина:** ранги завершили профилирование памяти с большим разбросом по времени. **Лечение:** увеличить значение; при систематическом разбросе — выровнять карты и модель по рангам.
- **Симптом:** предупреждение `Distributed backend nccl is not available; falling back to gloo.` **Причина:** сборка без NCCL. **Действие:** после отката весь трафик идёт по gloo, и релевантен именно этот таймаут.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `cpu_distributed_timeout_seconds=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --cpu-distributed-timeout-seconds 3600
```

```bash
vllm serve /models/Qwen3-4B --tensor-parallel-size 2 --distributed-timeout-seconds 3600 --cpu-distributed-timeout-seconds 3600
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/distributed/utils.py`
- `vllm/vllm/distributed/parallel_state.py`
- `vllm/vllm/v1/worker/dp_utils.py`
- `vllm/vllm/engine/arg_utils.py`
