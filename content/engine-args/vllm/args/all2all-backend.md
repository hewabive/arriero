---
schema: 1
engine: vllm
primaryName: "--all2all-backend"
title: "--all2all-backend"
summary: Ядро обмена токенами между экспертами MoE. Значим только когда all2all вообще используется (DP > 1 или EP с PCP > 1); большинство вариантов требуют внешних ядер — DeepEP, MoRI, NIXL, MoonEP или FlashInfer.
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
  - --dtype
  - --quantization
  - --compilation-config
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
- "moonep": MoonEP balanced EP with dynamic redundant experts (NVLink)
- "nixl_ep": Use nixl-ep kernels
- "flashinfer_nvlink_one_sided": Use flashinfer high-throughput a2a kernels
- "flashinfer_nvlink_two_sided": Use flashinfer two-sided kernels for mnnvl
```

## Паспорт аргумента

- Флаги: `--all2all-backend`
- Группа argparse: `ParallelConfig`
- Тип значения: enum (строка)
- Допустимые значения: `naive`, `pplx`, `deepep_high_throughput`, `deepep_low_latency`, `deepep_v2`, `mori_high_throughput`, `mori_low_latency`, `moonep`, `nixl_ep`, `allgather_reducescatter`, `flashinfer_all2allv`, `flashinfer_nvlink_two_sided`, `flashinfer_nvlink_one_sided`. Список `choices` шире, чем перечень в справке: `naive`, `pplx`, `deepep_v2` и `flashinfer_all2allv` в тексте не упомянуты
- Значение по умолчанию: `allgather_reducescatter`
- Эффективное значение: `naive` и `pplx` **удалены** — валидатор `ParallelConfig` заменяет их на `allgather_reducescatter` с предупреждением `The '%s' all2all backend has been removed. Falling back to 'allgather_reducescatter'.`; `flashinfer_all2allv` — устаревший алиас `flashinfer_nvlink_two_sided`; на CPU и XPU любое значение кроме `naive`/`allgather_reducescatter` откатывается к `allgather_reducescatter` с предупреждением. Для `moonep` `VllmConfig.__post_init__` дополнительно выключает CUDA graphs (`cudagraph_mode = NONE`), если `use_all2all` истинно
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
| `moonep` | `MoonEPAll2AllManager` | пакет `moonep` и NVSwitch multicast (SHARP) на каждом EP-ранге (`check_moonep_system_support()`) |
| `nixl_ep` | `NixlEPAll2AllManager` | NIXL |
| `flashinfer_nvlink_two_sided` (и `flashinfer_all2allv`) | `FlashInferNVLinkTwoSidedManager` | FlashInfer, MNNVL |
| `flashinfer_nvlink_one_sided` | `FlashInferNVLinkOneSidedManager` | FlashInfer, MNNVL |

Значение читается и производными свойствами `FusedMoEParallelConfig`: `use_deepep_ht_kernels`, `use_deepep_ll_kernels`, `use_ag_rs_all2all_kernels`, `use_mori_kernels`, `use_nixl_ep_kernels`, `use_deepep_v2_kernels`, `use_moonep_kernels`, `use_fi_nvl_two_sided_kernels`, `use_fi_nvl_one_sided_kernels`. Через них меняется формат активаций (`use_batched_activation_format` для `deepep_low_latency` и `nixl_ep`), необходимость round-robin таблиц маршрутизации и путь компиляции.

Отдельно `ParallelConfig.use_sequence_parallel_moe` истинно только для подмножества бэкендов (`allgather_reducescatter`, `deepep_high_throughput`, `deepep_low_latency`, `deepep_v2`, `flashinfer_nvlink_one_sided`, оба `mori_*`, `nixl_ep`; `moonep` в него не входит) в связке `EP + TP > 1 + DP > 1` — это убирает дублирующие вычисления на репликах TP.

**MoonEP.** `moonep` выравнивает нагрузку между EP-рангами: планировщик MoonEP онлайн выбирает несколько динамически дублируемых экспертов и заранее подкачивает их веса в слоты предвыборки, так что каждый ранг получает ровно `S × K` токенов независимо от перекоса роутера, и формы обмена и вычисления статичны. Интеграция помечена в коде как PoC и накладывает ограничения, которые `VllmConfig.__post_init__` проверяет на старте: только неквантованные BF16-модели, без `--enable-eplb`, только `--expert-placement-strategy linear`. Веса экспертов при загрузке собираются all-gather'ом в раскладку `[E+B, ...]` **на каждом** EP-ранге (`gather_moonep_weight_layout`): `E` — все эксперты модели, `B = 4` слота предвыборки; число экспертов должно делиться на размер EP-группы. Dispatch/combine MoonEP работают только в eager, поэтому при `use_all2all` движок принудительно выключает CUDA graphs с сообщением `MoonEP: Disabling CUDA Graphs since the MoonEP integration is currently eager-only.` Буферы обмена (`MoonEPBufferPool`) создаются лениво: на каждый шаг берётся наименьшая ёмкость-степень двойки (не меньше 128 токенов), вмещающая его токены, чтобы decode-шаги не дополнялись до полного `max_num_batched_tokens`; буфер каждой встреченной ёмкости кэшируется до остановки движка.

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
- `moonep` — экспериментальный вариант для одноузловых NVSwitch-систем (класс H100/H200/B200/GB300 с SHARP) и BF16-моделей с сильным перекосом нагрузки по экспертам. Цена — полная копия весов экспертов на каждом ранге и работа без CUDA graphs; без замера на своей нагрузке не включайте.
- `flashinfer_nvlink_*` — для MNNVL-топологий.
- Не трогайте флаг, если модель не MoE или если `--data-parallel-size 1` и EP не задействован: значение просто не будет прочитано.

## Влияние на производительность и память

- **Throughput/latency.** Это и есть предмет флага: high-throughput ядра оптимизированы под большие батчи prefill'а, low-latency — под короткие декодирующие шаги. `allgather_reducescatter` универсален, но на больших EP-группах проигрывает специализированным ядрам.
- **VRAM.** Специализированные менеджеры держат собственные буферы обмена; их объём зависит от реализации и от размеров батча, и он попадает в измеренную профилировщиком non-KV память, уменьшая KV-cache при фиксированном `--gpu-memory-utilization`.
- **VRAM при `moonep`.** Главная статья: веса **всех** экспертов плюс четыре слота предвыборки лежат на каждом EP-ранге, то есть EP перестаёт экономить память на экспертах. На крупной MoE-модели это может не поместиться туда, куда помещается тот же запуск с другим бэкендом.
- **CUDA graphs.** `moonep` выключает их целиком, и decode идёт в eager — заметный рост задержки на мелких батчах.
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
- `--dtype`, `--quantization`: при `moonep` модель обязана быть неквантованной и в `bfloat16`.
- `--compilation-config`: при `moonep` `cudagraph_mode` принудительно становится `NONE`, что бы там ни было задано.
- `--enable-eplb`, `--expert-placement-strategy`: при `moonep` EPLB запрещён, а размещение экспертов должно быть `linear`.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: DeepEP kernels not found. Please follow https://github.com/vllm-project/vllm/blob/main/tools/ep_kernels/README.md to install DeepEP kernels.` **Причина:** выбран `deepep_*` без установленных ядер. **Лечение:** установить ядра или вернуться на `allgather_reducescatter`.
- **Симптом:** предупреждение `The 'pplx' all2all backend has been removed. Falling back to 'allgather_reducescatter'.` **Действие:** убрать флаг, значение мертво.
- **Симптом:** `AssertionError: Microbatching currently only supports the deepep_low_latency, deepep_high_throughput, and nixl_ep all2all backends.` **Причина:** `--enable-dbo` с дефолтным бэкендом. **Лечение:** выбрать поддерживаемый.
- **Симптом:** `Fused MoE LoRA with EP currently only supports all2all_backend='allgather_reducescatter', got '...'.` **Лечение:** для LoRA + EP оставить дефолт.
- **Симптом:** `RuntimeError: MoonEP not available. Install it from https://github.com/MoonshotAI/MoonEP.` **Причина:** выбран `moonep` без пакета. **Лечение (arriero):** окружения неизменяемы — соберите новое окружение с пакетом `moonep` (`docs/ENVIRONMENTS.md`).
- **Симптом:** `RuntimeError: MoonEP requires NVSwitch multicast (SHARP) support on the current device; it is not supported on this GPU/topology.` **Причина:** топология без NVSwitch multicast (например, NVLink без NVSwitch). **Лечение:** другой бэкенд.
- **Симптом:** `ValueError: The moonep all2all backend currently supports unquantized BF16 models only; got quantization=...` или `... supports BF16 models only; got dtype=...`. **Лечение:** неквантованная модель с `--dtype bfloat16` либо другой бэкенд.
- **Симптом:** `ValueError: The moonep all2all backend does not support EPLB yet: ...` или `... requires linear expert placement: ...`. **Лечение:** снять `--enable-eplb`, вернуть `--expert-placement-strategy linear`.
- **Симптом:** `NotImplementedError: MoonEP PoC requires num_experts to be evenly divisible across EP ranks: ...`. **Лечение:** подобрать размер EP-группы (DP × TP), на который делится число экспертов.
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
- `vllm/vllm/model_executor/layers/fused_moe/prepare_finalize/moonep.py`
- `vllm/vllm/model_executor/layers/fused_moe/oracle/unquantized.py`
- `vllm/vllm/utils/import_utils.py`
- `vllm/vllm/model_executor/layers/fused_moe/config.py`
- `vllm/vllm/lora/layers/fused_moe.py`
- `vllm/vllm/v1/worker/sentinel/gpu_worker_sentinel.py`
- `vllm/docs/serving/expert_parallel_deployment.md`
- `vllm/tests/kernels/moe/test_moonep_bf16_poc.py`
- upstream-коммит `911548247` «[Distributed][MoonEP] BF16 integration of MoonEP balanced EP backend (#52101)» в checkout'е
