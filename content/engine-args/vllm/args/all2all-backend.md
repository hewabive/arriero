---
schema: 1
engine: vllm
primaryName: "--all2all-backend"
title: "--all2all-backend"
summary: Ядро обмена токенами между экспертами MoE. Значим только когда all2all вообще используется (DP > 1 или EP с PCP > 1); большинство вариантов требуют внешних ядер — DeepEP, MoRI, NIXL или FlashInfer.
group: ParallelConfig
related:
  - --enable-expert-parallel
  - --data-parallel-size
  - --tensor-parallel-size
  - --prefill-context-parallel-size
  - --enable-dbo
  - --ubatch-size
  - --enable-eplb
  - --eplb-config
  - --expert-placement-strategy
  - --enable-fault-tolerance
  - --enable-elastic-ep
  - --async-scheduling
---

# --all2all-backend

## Кратко

Когда слои экспертов MoE разложены по рангам, на каждом шаге токены надо разослать «своим» экспертам и собрать результаты обратно. `--all2all-backend` выбирает, каким кодом это делается.

Флаг не срабатывает сам по себе: менеджер all2all создаётся только для коммуникатора группы `ep` и только когда `ParallelConfig.use_all2all` истинно — то есть при `--data-parallel-size > 1`, либо при sequence-parallel MoE, либо при EP с `--prefill-context-parallel-size > 1`. На одиночной карте без DP значение не читается.

## Оригинальная справка

```text
All2All backend for MoE expert parallel communication. Available options:

- "allgather_reducescatter": All2all based on allgather and reducescatter
- "deepep_high_throughput": Use deepep high-throughput kernels
- "deepep_low_latency": Use deepep low-latency kernels
- "mori_high_throughput": MoRI EP with InterNodeV1 for multi-node
- "mori_low_latency": MoRI EP with InterNodeV1LL for multi-node
- "nixl_ep": Use nixl-ep kernels
- "flashinfer_nvlink_two_sided": Use flashinfer two-sided kernels for mnnvl
- "flashinfer_nvlink_one_sided": Use flashinfer high-throughput a2a kernels
```

## Паспорт аргумента

- Флаги: `--all2all-backend`
- Группа argparse: `ParallelConfig`
- Тип значения: enum (строка)
- Допустимые значения: `naive`, `pplx`, `deepep_high_throughput`, `deepep_low_latency`, `deepep_v2`, `mori_high_throughput`, `mori_low_latency`, `nixl_ep`, `allgather_reducescatter`, `flashinfer_all2allv`, `flashinfer_nvlink_two_sided`, `flashinfer_nvlink_one_sided`. Список `choices` шире, чем перечень в справке: `naive`, `pplx`, `deepep_v2` и `flashinfer_all2allv` в тексте не упомянуты
- Значение по умолчанию: `allgather_reducescatter`
- Эффективное значение: `naive` и `pplx` **удалены** — валидатор `ParallelConfig` заменяет их на `allgather_reducescatter` с предупреждением `The '%s' all2all backend has been removed. Falling back to 'allgather_reducescatter'.`; `flashinfer_all2allv` — устаревший алиас `flashinfer_nvlink_two_sided`; на CPU и XPU любое значение кроме `naive`/`allgather_reducescatter` откатывается к `allgather_reducescatter` с предупреждением
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.all2all_backend`
- Этап применения: сборка `VllmConfig` → создание коммуникатора группы `ep` → каждый forward слоёв MoE

## Что меняет в движке

`CudaCommunicator` выбирает конкретный менеджер:

| Значение | Менеджер | Требование |
| --- | --- | --- |
| `allgather_reducescatter` (и `naive` после отката) | `AgRsAll2AllManager` | ничего сверх vLLM |
| `deepep_high_throughput` | `DeepEPHTAll2AllManager` | ядра DeepEP (`has_deep_ep()`) |
| `deepep_low_latency` | `DeepEPLLAll2AllManager` | ядра DeepEP |
| `deepep_v2` | `DeepEPV2All2AllManager` | ядра DeepEP v2 |
| `mori_high_throughput`, `mori_low_latency` | `MoriAll2AllManager` | пакет MoRI (`has_mori()`) |
| `nixl_ep` | `NixlEPAll2AllManager` | NIXL |
| `flashinfer_nvlink_two_sided` (и `flashinfer_all2allv`) | `FlashInferNVLinkTwoSidedManager` | FlashInfer, MNNVL |
| `flashinfer_nvlink_one_sided` | `FlashInferNVLinkOneSidedManager` | FlashInfer, MNNVL |

Значение читается и производными свойствами `FusedMoEParallelConfig`: `use_deepep_ht_kernels`, `use_deepep_ll_kernels`, `use_ag_rs_all2all_kernels`, `use_mori_kernels`, `use_nixl_ep_kernels`, `use_fi_nvl_two_sided_kernels`, `use_fi_nvl_one_sided_kernels`. Через них меняется формат активаций (`use_batched_activation_format` для `deepep_low_latency` и `nixl_ep`), необходимость round-robin таблиц маршрутизации и путь компиляции.

Отдельно `ParallelConfig.use_sequence_parallel_moe` истинно только для подмножества бэкендов (`allgather_reducescatter`, оба `deepep_*`, оба `mori_*`, `nixl_ep`) в связке `EP + TP > 1 + DP > 1` — это убирает дублирующие вычисления на репликах TP.

## Значения и формат

- Одна строка из `choices`. Неизвестное значение отвергается argparse'ом.
- `naive` и `pplx` принимаются, но молча превращаются в `allgather_reducescatter` (с предупреждением в логе) — считайте их несуществующими.
- `flashinfer_all2allv` даёт предупреждение о переименовании и ведёт себя как `flashinfer_nvlink_two_sided`.
- Отсутствие нужных ядер — это не тихая деградация, а `AssertionError` на старте с прямой ссылкой на инструкцию установки.
- «Не задано» = `allgather_reducescatter`, работающий везде и не требующий дополнительных пакетов.

## Когда использовать

- **Оставить дефолт**, если MoE-развертывание одноузловое или если внешние EP-ядра не установлены: `allgather_reducescatter` не требует ничего сверх vLLM.
- `deepep_high_throughput` — для prefill-ориентированной нагрузки на многоузловом EP; `deepep_low_latency` — для decode-ориентированной. Эти же два (и `nixl_ep`) — единственные, с которыми работает `--enable-dbo`.
- `mori_*` — вариант для ROCm-развертываний с MoRI.
- `flashinfer_nvlink_*` — для MNNVL-топологий.
- Не трогайте флаг, если модель не MoE или если `--data-parallel-size 1` и EP не задействован: значение просто не будет прочитано.

## Влияние на производительность и память

- **Throughput/latency.** Это и есть предмет флага: high-throughput ядра оптимизированы под большие батчи prefill'а, low-latency — под короткие декодирующие шаги. `allgather_reducescatter` универсален, но на больших EP-группах проигрывает специализированным ядрам.
- **VRAM.** Специализированные менеджеры держат собственные буферы обмена; их объём зависит от реализации и от размеров батча, и он попадает в измеренную профилировщиком non-KV память, уменьшая KV-cache при фиксированном `--gpu-memory-utilization`.
- **SM.** Для DeepEP high-throughput под коммуникацию резервируются SM (`VLLM_DBO_COMM_SMS`, по умолчанию 20 на CUDA и 64 на ROCm); на ROCm в связке с DBO резервирование принудительно снимается.
- **Время старта.** Специализированные бэкенды подгружают внешние ядра и создают буферы обмена — старт длиннее.

## Взаимодействие с другими аргументами

- `--enable-expert-parallel`: без EP большинство производных свойств `FusedMoEParallelConfig` ложны и ядра не задействуются.
- `--data-parallel-size`, `--prefill-context-parallel-size`: определяют, истинно ли `use_all2all`.
- `--tensor-parallel-size`: вместе с DP и EP определяет, включится ли sequence-parallel MoE.
- `--enable-dbo`, `--ubatch-size`: требуют `deepep_low_latency`, `deepep_high_throughput` или `nixl_ep`; иначе старт падает.
- `--enable-eplb`, `--eplb-config`, `--expert-placement-strategy`: живут в той же EP-подсистеме; выбор бэкенда влияет на путь пересылки весов экспертов.
- `--enable-fault-tolerance`: требует бэкенд из FT-совместимого набора, иначе `Fault tolerance requires an FT-capable all2all backend (one of ...), but got '...'`.
- `--async-scheduling`: несовместим с ROCm DeepEP high-throughput при включённом DBO.
- LoRA поверх fused MoE с EP поддерживается только на `allgather_reducescatter`.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: DeepEP kernels not found. Please follow https://github.com/vllm-project/vllm/blob/main/tools/ep_kernels/README.md to install DeepEP kernels.` **Причина:** выбран `deepep_*` без установленных ядер. **Лечение:** установить ядра или вернуться на `allgather_reducescatter`.
- **Симптом:** предупреждение `The 'pplx' all2all backend has been removed. Falling back to 'allgather_reducescatter'.` **Действие:** убрать флаг, значение мертво.
- **Симптом:** `AssertionError: Microbatching currently only supports the deepep_low_latency, deepep_high_throughput, and nixl_ep all2all backends.` **Причина:** `--enable-dbo` с дефолтным бэкендом. **Лечение:** выбрать поддерживаемый.
- **Симптом:** `Fused MoE LoRA with EP currently only supports all2all_backend='allgather_reducescatter', got '...'.` **Лечение:** для LoRA + EP оставить дефолт.
- **Симптом:** на CPU/XPU выбранный бэкенд не применился. **Причина:** предупреждение `'%s' all2all manager is not supported on CPU. Falling back to 'allgather_reducescatter' manager.` (аналогично на XPU). **Действие:** ожидаемо.
- **Подтверждение принятого значения:** однократная строка `Using %s all2all manager.` с именем класса менеджера (`AgRsAll2AllManager`, `DeepEPLLAll2AllManager` и так далее); стартовая строка конфига содержит `all2all_backend=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --all2all-backend deepep_low_latency
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --tensor-parallel-size 2 --enable-expert-parallel --all2all-backend allgather_reducescatter
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/distributed/device_communicators/all2all.py`
- `vllm/vllm/distributed/device_communicators/cuda_communicator.py`
- `vllm/vllm/distributed/device_communicators/cpu_communicator.py`
- `vllm/vllm/distributed/device_communicators/xpu_communicator.py`
- `vllm/vllm/model_executor/layers/fused_moe/config.py`
- `vllm/vllm/lora/layers/fused_moe.py`
- `vllm/vllm/v1/worker/sentinel/gpu_worker_sentinel.py`
- `vllm/docs/serving/expert_parallel_deployment.md`
