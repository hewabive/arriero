---
schema: 1
engine: vllm
primaryName: "--tensor-parallel-size"
title: "--tensor-parallel-size"
summary: Число рангов, между которыми режутся тензоры каждого слоя: головы внимания, матрицы MLP и KV-cache. Главная ручка для модели, которая не влезает в одну карту, и обязательный вход для оценки памяти vLLM-инстанса в arriero.
group: ParallelConfig
related:
  - --pipeline-parallel-size
  - --prefill-context-parallel-size
  - --decode-context-parallel-size
  - --data-parallel-size
  - --enable-expert-parallel
  - --distributed-executor-backend
  - --disable-custom-all-reduce
  - --gpu-memory-utilization
  - --nnodes
  - --device-ids
---

# --tensor-parallel-size

## Кратко

`--tensor-parallel-size N` (алиас `-tp`) разрезает **каждый** слой модели по N устройств: головы внимания и матрицы MLP делятся по признаковой размерности, каждый ранг считает свою часть и после этого делает all-reduce. Веса, активации и KV-cache уменьшаются примерно в N раз на карту, но за каждый слой добавляется коллективная операция между картами.

Это не «использовать N GPU», а «разрезать тензоры на N частей». Число процессов равно `pipeline_parallel_size × tensor_parallel_size × prefill_context_parallel_size`, и каждый из них занимает свою карту.

Флаг ничего не делает с долей памяти: `--gpu-memory-utilization` остаётся лимитом **на устройство** и между рангами не делится (см. `gpu-memory-utilization.md`).

## Оригинальная справка

```text
Number of tensor parallel groups.
```

## Паспорт аргумента

- Флаги: `--tensor-parallel-size`, `-tp`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: `Field(default=1, ge=1)` — целое не меньше 1; верхней границы в конфиге нет, её задаёт железо и архитектура модели
- Значение по умолчанию: `1`
- Эффективное значение: не переопределяется, но участвует в производном `world_size = pipeline_parallel_size × tensor_parallel_size × prefill_context_parallel_size` (`ParallelConfig.__post_init__`), а `world_size` определяет выбор `distributed_executor_backend` (`uni` при `world_size == 1`, иначе `mp`)
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.tensor_parallel_size`
- Этап применения: сборка `VllmConfig` (валидация делимости, расчёт `world_size`) → запуск worker-процессов executor'ом → построение слоёв модели → каждый forward (all-reduce)

## Что меняет в движке

**Число процессов.** `ParallelConfig.__post_init__` считает `world_size = pp × tp × pcp`. Если backend не задан явно и `world_size > 1`, выбирается `mp`; при `world_size == 1` — `uni` (executor в том же процессе). `MultiprocExecutor` поднимает `local_world_size` worker-подпроцессов и проверяет утверждением, что `world_size` равен произведению TP × PP × PCP.

**Разрез весов.** `ModelConfig.get_num_attention_heads()` возвращает `total_num_attention_heads // tensor_parallel_size`, то есть головы внимания делятся строго. `ModelConfig.get_num_kv_heads()` возвращает `max(1, total_num_kv_heads // tensor_parallel_size)` — здесь деления может не быть: при `tp > total_num_kv_heads` KV-головы **реплицируются**, и KV-cache дублируется `tp / H` раз. Именно этот эффект и лечит `--decode-context-parallel-size`.

**Валидация.** `ModelConfig.verify_with_parallel_config()` требует `total_num_attention_heads % tensor_parallel_size == 0`; иначе `ValueError` ещё до загрузки весов.

**MoE.** Без `--enable-expert-parallel` слои MoE тоже шардируются тензорно, вместе с остальными. С `--enable-expert-parallel` они переходят на экспертный параллелизм с `ep_size = data_parallel_size × prefill_context_parallel_size × tensor_parallel_size` (`FusedMoEParallelConfig.flatten_tp_across_dp_and_pcp`).

**Коммуникация.** Внутри узла vLLM пытается использовать собственное ядро all-reduce (`CustomAllreduce`). Оно включается только для `world_size ∈ {2, 4, 6, 8, 16}`, требует P2P между картами и отключается на конфигурации «больше двух карт без полной связности» (только PCIe). Отключение — не ошибка, а падение пропускной способности: работа уходит в NCCL.

**CPU хоста.** `set_multiprocessing_worker_envs(local_world_size)` перед стартом воркеров выставляет `OMP_NUM_THREADS = available_cpu_count() // local_world_size` (если переменная не задана снаружи). Чем больше TP, тем меньше потоков на загрузку весов у каждого воркера.

## Значения и формат

- Целое ≥ 1. `1` — тензорного параллелизма нет.
- Специальных значений (`0`, `-1`, `auto`) нет: `0` отвергается pydantic-валидацией `ge=1`.
- Практическая граница — количество голов: TP должен делить `num_attention_heads` нацело. Для большинства моделей это степень двойки, поэтому 2/4/8 работают, а 3/6 обычно нет.
- Число видимых карт должно быть не меньше `pp × tp × pcp`. Набор карт задаётся `CUDA_VISIBLE_DEVICES` или флагом `--device-ids`.
- На одном узле TP ограничен числом карт в этом узле; выход за узел — это `--nnodes` (backend `mp`) либо `--distributed-executor-backend ray`.

## Когда использовать

- **Модель не влезает в одну карту.** Первый и основной сценарий: `-tp` уменьшает вес модели на карту примерно в N раз, освобождая место под KV-cache.
- **KV-cache упирается в потолок.** При том же `--gpu-memory-utilization` каждая карта отдаёт под KV-cache свой остаток; суммарная ёмкость растёт (но не линейно — см. про репликацию KV-голов ниже).
- **Есть NVLink/NVSwitch.** TP делает all-reduce после каждого слоя, поэтому он выигрывает именно на быстром межкарточном линке.
- **Не увеличивайте TP «на всякий случай» на PCIe-only машине.** При `tp > 2` без полной связности собственное ядро all-reduce отключается, и латентность межкарточного обмена становится доминирующей. Здесь обычно выгоднее `--pipeline-parallel-size`.
- **Не поднимайте TP выше числа KV-голов ради KV-cache.** Сверх `total_num_kv_heads` KV-cache начинает дублироваться, а не делиться: восемь карт при 4 KV-головах дают дублирование ×2. Дальше нужен `--decode-context-parallel-size`.

## Влияние на производительность и память

- **VRAM.** Веса на карту ≈ `общий размер / tp`. KV-cache на карту делится по числу KV-голов, но не мельче одной головы (репликация при `tp > H`). Активации делятся вместе с признаковой размерностью.
- **Бюджет.** `--gpu-memory-utilization` применяется каждым рангом к своей карте целиком; суммарный запрос растёт линейно по TP. Оценка arriero делает то же самое (см. ниже).
- **Время старта.** Растёт: N процессов, N загрузок шардов, инициализация process group, отдельная компиляция и захват CUDA graphs в каждом ранге. Плюс `OMP_NUM_THREADS` на воркер меньше, то есть загрузка весов на процесс медленнее.
- **Latency.** Per-layer all-reduce добавляет фиксированные накладные расходы на каждый forward. На NVLink это обычно окупается; на PCIe при малом батче — часто нет.
- **Throughput.** Растёт за счёт большего KV-cache и распределённого счёта, пока коммуникация не станет узким местом.
- **RAM хоста.** N процессов Python + N наборов CUDA-контекстов; на машине с ограниченной RAM это заметно.

## Взаимодействие с другими аргументами

- `--pipeline-parallel-size`: перемножается с TP в `world_size`. Каноническая раскладка для нескольких узлов — TP по числу карт в узле, PP по числу узлов.
- `--prefill-context-parallel-size`: третий множитель `world_size`; сам по себе не увеличивает число шардов KV-cache.
- `--decode-context-parallel-size`: допустим только если `tp % dcp == 0` (при `pcp == 1`), а для GQA/MQA дополнительно требует `tp > total_num_kv_heads` и `dcp ≤ tp / total_num_kv_heads`. Это прямое лекарство от дублирования KV-cache при большом TP.
- `--enable-expert-parallel`: переводит MoE-слои с тензорного параллелизма на экспертный, `ep_size = dp × pcp × tp`.
- `--data-parallel-size`: не заменяет TP, а тиражирует всю группу TP×PP; для MoE вместе с EP расширяет экспертную группу.
- `--gpu-memory-utilization`: не делится между рангами. При `-tp 4` и `0.9` вы просите 90 % на каждой из четырёх карт.
- `--distributed-executor-backend`: при `world_size > 1` по умолчанию `mp`; для нескольких узлов — либо `ray`, либо `mp` вместе с `--nnodes`.
- `--disable-custom-all-reduce`: явно выключает собственное ядро all-reduce (и заодно предупреждения о его недоступности).
- `--device-ids`: выбирает конкретные физические карты, не трогая `CUDA_VISIBLE_DEVICES`; не работает с Ray-executor'ами.

## Типовые проблемы и диагностика

- **Симптом:** `Total number of attention heads (N) must be divisible by tensor parallel size (M).` **Причина:** TP не делит число голов внимания. **Лечение:** взять делитель `N` (обычно степень двойки) либо перейти на `--pipeline-parallel-size`, который режет по слоям и допускает неровное деление.
- **Симптом:** `World size (X) is larger than the number of available GPUs (Y) in this node. If this is intentional and you are using: - ray, set '--distributed-executor-backend ray'. - multiprocessing, set '--nnodes' appropriately.` **Причина:** `pp × tp × pcp` больше числа видимых карт. **Лечение:** уменьшить TP/PP, расширить `CUDA_VISIBLE_DEVICES`, либо выйти за узел через `--nnodes`/Ray.
- **Симптом:** `Custom allreduce is disabled because it's not supported on more than two PCIe-only GPUs.` **Причина:** `tp > 2` без полной связности карт. **Следствие:** all-reduce уходит в NCCL, latency растёт. **Лечение:** либо принять, либо перейти на PP, либо задать `--disable-custom-all-reduce`, чтобы предупреждение не мешало.
- **Симптом:** `Custom allreduce is disabled due to an unsupported world size: 3. Supported world sizes: [2, 4, 6, 8, 16].` **Причина:** TP не из поддерживаемого набора. **Лечение:** выбрать размер из списка, если важна пропускная способность коллектива.
- **Симптом:** карт стало вдвое больше, а `GPU KV cache size` вырос заметно меньше чем вдвое. **Причина:** `tp > total_num_kv_heads`, KV-головы реплицируются. **Проверка:** число KV-голов в конфиге модели. **Лечение:** `--decode-context-parallel-size` в пределах `tp / H`.
- **Симптом:** старт зависает на инициализации process group. **Проверка:** строка `world_size=%d rank=%d local_rank=%d distributed_init_method=%s backend=%s` из `init_distributed_environment` — по ней видно, все ли ранги дошли до рандеву. Диагностика распределённых зависаний — `vllm/docs/serving/distributed_troubleshooting.md`.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `tensor_parallel_size=N`, и в логе появляется ровно N наборов сообщений воркеров.
- **Симптом (arriero):** оценка памяти жалуется `Tensor parallel size is N, but only M matching GPU pool(s) exist.` **Причина:** стратегия `vllm-gpu-util` берёт первые `--tensor-parallel-size` GPU-пулов в порядке `CUDA_VISIBLE_DEVICES`, а пулов настроено меньше. **Лечение:** привести `CUDA_VISIBLE_DEVICES` и `config/resources.json` в соответствие с реальной топологией (`docs/MEMORY_ESTIMATION.md`, `docs/RESOURCE_MANAGEMENT.md` — документы arriero).

## Примеры

```bash
vllm serve /models/Qwen3-32B --tensor-parallel-size 2 --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/DeepSeek-V3 --tensor-parallel-size 8 --decode-context-parallel-size 8 --gpu-memory-utilization 0.9
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/distributed/parallel_state.py`
- `vllm/vllm/distributed/device_communicators/custom_all_reduce.py`
- `vllm/vllm/model_executor/layers/fused_moe/config.py`
- `vllm/vllm/utils/torch_utils.py`
- `vllm/docs/serving/parallelism_scaling.md`
- `vllm/docs/serving/context_parallel_deployment.md`
- `docs/MEMORY_ESTIMATION.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
