---
schema: 1
engine: vllm
primaryName: "--enable-dbo"
title: "--enable-dbo"
summary: Включает dual batch overlap — разрезание батча на два микробатча, чтобы вычисления одного перекрывались с all2all-коммуникацией другого. Работает только на MoE с EP-ядрами DeepEP/NIXL и только при `--data-parallel-size > 1`.
group: ParallelConfig
related:
  - --dbo-decode-token-threshold
  - --dbo-prefill-token-threshold
  - --ubatch-size
  - --all2all-backend
  - --data-parallel-size
  - --enable-expert-parallel
  - --async-scheduling
  - --disable-cascade-attn
  - --disable-nccl-for-dp-synchronization
  - --enforce-eager
---

# --enable-dbo

## Кратко

DBO делит батч шага на два микробатча и планирует их так, чтобы GPU считал один, пока по сети идёт all2all-обмен другого. Это оптимизация MoE-развертываний с экспертным параллелизмом, где на обмен между рангами уходит заметная доля шага.

Три условия, без которых флаг бесполезен: MoE-модель с `--enable-expert-parallel`, `--all2all-backend` из числа поддержанных, и `--data-parallel-size > 1` — при DP=1 согласование микробатчинга не выполняется вовсе.

## Оригинальная справка

```text
Enable dual batch overlap for the model executor.
```

## Паспорт аргумента

- Флаги: `--enable-dbo`, `--no-enable-dbo`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо `--no-...`; «не задан» = `False`
- Значение по умолчанию: `false`
- Эффективное значение: принудительно сбрасывается в `False` на CPU-платформе (`Dual-Batch Overlap is not supported on CPU, disabled.`). Кроме того, включение меняет чужие настройки: `--disable-cascade-attn` становится истинным (`Disabling cascade attention when DBO is enabled.`), а на ROCm с `deepep_high_throughput` отключается async scheduling
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.enable_dbo`
- Этап применения: сборка `VllmConfig` (проверка all2all-бэкенда) → инициализация workspace worker'а → обёртка модели `UBatchWrapper` → решение о микробатчинге на каждом шаге

## Что меняет в движке

**Производные свойства.** `ParallelConfig.use_ubatching = enable_dbo or ubatch_size > 1`, `num_ubatches = 2 if enable_dbo else ubatch_size`. То есть DBO — это ровно два микробатча; произвольное число задаётся отдельным `--ubatch-size`.

**Жёсткая проверка бэкенда.** В `VllmConfig.__post_init__` при `use_ubatching` стоит assert: `Microbatching currently only supports the deepep_low_latency, deepep_high_throughput, and nixl_ep all2all backends. <X> is not supported. To fix use --all2all-backend=deepep_low_latency, --all2all-backend=deepep_high_throughput, or --all2all-backend=nixl_ep and install the matching kernels.` Бэкенд по умолчанию (`allgather_reducescatter`) в список не входит, поэтому один только `--enable-dbo` уронит старт.

**Обёртка модели.** Вместо `CUDAGraphWrapper`/`BreakableCUDAGraphWrapper` модель оборачивается в `UBatchWrapper` (с `CUDAGraphMode.FULL`, если полные графы включены, иначе `NONE`). Workspace-менеджер инициализируется на два микробатча (`init_workspace_manager(device, num_ubatches)`).

**Решение на каждом шаге.** Микробатчинг включается, только если сошлось всё:

1. `data_parallel_size > 1` — иначе `coordinate_batch_across_dp` выходит сразу и возвращает «не микробатчить»;
2. в батче хотя бы два запроса и нет опасного пересечения prefix-cache (`_allow_microbatching` вето);
3. число токенов превышает порог — `--dbo-decode-token-threshold` для чисто decode-батча, `--dbo-prefill-token-threshold` для батча с prefill'ами;
4. все DP-ранги согласились: решение проходит через тот же all-reduce, что и согласование паддинга (`_run_ar`, элемент `[2]` тензора);
5. второй микробатч не оказывается пустым (`is_last_ubatch_empty`, иначе `Aborting ubatching %s %s` в debug-логе).

**Резервирование SM.** Для DeepEP high-throughput часть SM резервируется под коммуникацию (`VLLM_DBO_COMM_SMS`, по умолчанию 20 на CUDA и 64 на ROCm). На ROCm с `deepep_high_throughput` значение принудительно обнуляется, потому что резервирование CU там портит точность генерации DP+EP.

**Несовместимость.** DBO попадает в список неподдерживаемого для Model Runner V2 (`dual batch overlap`).

## Значения и формат

- Булев переключатель без аргумента; `--no-enable-dbo` возвращает `False`.
- Число микробатчей не настраивается: DBO — это всегда два. Больше — через `--ubatch-size`.
- На CPU-платформе значение игнорируется с предупреждением.

## Когда использовать

- MoE-развертывание с DP + EP и установленными ядрами DeepEP или NIXL, где профиль показывает заметную долю времени в all2all.
- Вместе с осознанно выставленными `--dbo-prefill-token-threshold` и `--dbo-decode-token-threshold`: на маленьких батчах разрезание только добавляет накладных расходов.
- Не включайте на плотной модели, на одной карте и при `--data-parallel-size 1` — эффекта не будет, а cascade attention отключится.
- Не включайте, не поменяв `--all2all-backend`: старт упадёт на assert'е.

## Влияние на производительность и память

- **VRAM.** Workspace выделяется на два микробатча вместо одного, и при полных CUDA graph'ах захватываются отдельные ubatched-графы для декодирующих батчей выше порога. Это дополнительный расход к тому, что вычитается из бюджета `--gpu-memory-utilization`.
- **Throughput.** Целевой выигрыш — перекрытие обмена и счёта на MoE. Величина зависит от доли all2all в шаге; на TP-развертывании без EP выигрыша нет по построению.
- **Latency.** На малых батчах DBO вреден — отсюда пороги. Ниже порога батч идёт целиком, как обычно.
- **Cascade attention.** Отключается принудительно, что само по себе может стоить производительности на нагрузках с общим длинным префиксом.
- **SM.** Резервирование SM под коммуникацию отбирает их у вычислений.

## Взаимодействие с другими аргументами

- `--all2all-backend`: обязателен один из `deepep_low_latency`, `deepep_high_throughput`, `nixl_ep`.
- `--enable-expert-parallel`: без EP all2all-ядра не задействуются, перекрывать нечего.
- `--data-parallel-size`: при `1` микробатчинг не срабатывает.
- `--dbo-decode-token-threshold`, `--dbo-prefill-token-threshold`: нижние границы применения.
- `--ubatch-size`: альтернативный путь к тому же `use_ubatching` с произвольным числом микробатчей.
- `--disable-cascade-attn`: выставляется принудительно.
- `--async-scheduling`: отключается на ROCm в связке с `deepep_high_throughput`.
- `--disable-nccl-for-dp-synchronization`: тем же all-reduce переносится и согласие на микробатчинг.
- `--enforce-eager`: убирает CUDA graph'ы, и `UBatchWrapper` работает в режиме `CUDAGraphMode.NONE`.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: Microbatching currently only supports the deepep_low_latency, deepep_high_throughput, and nixl_ep all2all backends. allgather_reducescatter is not supported.` **Причина:** бэкенд по умолчанию. **Лечение:** задать поддерживаемый `--all2all-backend` и установить соответствующие ядра.
- **Симптом:** флаг включён, а профиль не изменился. **Причина:** `--data-parallel-size 1`, батчи ниже порогов, или в батче меньше двух запросов. **Проверка:** debug-строка `Aborting ubatching %s %s` появляется, когда второй микробатч выходит пустым.
- **Симптом:** предупреждение `Disabling cascade attention when DBO is enabled.` **Действие:** ожидаемо; оцените, не была ли cascade attention важнее.
- **Симптом:** `Model Runner V2 does not yet support: dual batch overlap`. **Лечение:** отключить DBO или V2-раннер.
- **Симптом:** на CPU `Dual-Batch Overlap is not supported on CPU, disabled.` **Действие:** флаг игнорируется.
- **Симптом (ROCm):** `Async scheduling is not compatible with ROCm DeepEP high-throughput DBO. Please use --no-async-scheduling or select a different all2all backend.` **Лечение:** одно из двух по тексту сообщения.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `enable_dbo=True`; при захвате графов в прогресс-баре видны отдельные ubatched-графы для декодирующих батчей.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --all2all-backend deepep_low_latency --enable-dbo
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --all2all-backend deepep_high_throughput --enable-dbo --dbo-prefill-token-threshold 1024 --dbo-decode-token-threshold 64
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/worker/ubatch_utils.py`
- `vllm/vllm/v1/worker/dp_utils.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/worker/gpu_ubatch_wrapper.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/platforms/cpu.py`
- `vllm/vllm/envs.py`
