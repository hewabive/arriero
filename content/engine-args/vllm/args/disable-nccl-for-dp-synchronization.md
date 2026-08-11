---
schema: 1
engine: vllm
primaryName: "--disable-nccl-for-dp-synchronization"
title: "--disable-nccl-for-dp-synchronization"
summary: Переводит пошаговый обмен между DP-рангами (согласование числа токенов, паддинга и режима CUDA graph) с NCCL на gloo по CPU. Значимо только при `--data-parallel-size > 1`; по умолчанию включается вместе с async scheduling.
group: ParallelConfig
related:
  - --data-parallel-size
  - --async-scheduling
  - --cpu-distributed-timeout-seconds
  - --distributed-timeout-seconds
  - --enable-dbo
  - --dbo-decode-token-threshold
  - --dbo-prefill-token-threshold
  - --enable-expert-parallel
---

# --disable-nccl-for-dp-synchronization

## Кратко

На каждом шаге DP-ранги обязаны договориться: сколько токенов у кого в батче, до какого размера padding'а всем дотянуться, в каком режиме CUDA graph идти и стоит ли микробатчить. Это маленький all-reduce по тензору `4 × dp_size` из `int32`.

Флаг решает, где этот all-reduce выполнять. `False` — на GPU через NCCL. `True` — на CPU через gloo. Причина, по которой вариант с CPU вообще существует, записана прямо в коде `dp_utils.py`: перенос тензора с GPU на CPU создаёт точку синхронизации GPU, которая портит выигрыш от асинхронного планирования.

При `--data-parallel-size 1` флаг ни на что не влияет: `coordinate_batch_across_dp` выходит до этого кода.

## Оригинальная справка

```text
Forces the dp synchronization logic in vllm/v1/worker/dp_utils.py 
to use Gloo instead of NCCL for its all reduce.

Defaults to True when async scheduling is enabled, False otherwise.
```

## Паспорт аргумента

- Флаги: `--disable-nccl-for-dp-synchronization`, `--no-disable-nccl-for-dp-synchronization`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`), тип допускает `None`
- Допустимые значения: флаг без значения (`True`), `--no-...` (`False`), либо отсутствие флага (`None` — «решит движок»)
- Значение по умолчанию: `null`
- Эффективное значение: доопределяется в `VllmConfig.__post_init__` уже **после** того, как разрешён `--async-scheduling`: `True`, если async scheduling включён, иначе `False`. При `data_parallel_size > 1` и MoE-модели решение печатается: `Disabling NCCL for DP synchronization when using async scheduling.` Само async scheduling по умолчанию тоже не задано и включается автоматически, если нет несовместимостей (pooling-модель, часть методов спекулятивного декодирования, Ray-исполнитель, ROCm DeepEP HT + DBO), — поэтому на типовом CUDA-развертывании эффективное значение этого флага оказывается `True`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.disable_nccl_for_dp_synchronization`
- Этап применения: сборка `VllmConfig` → каждый шаг планировщика на пути `coordinate_batch_across_dp`

## Что меняет в движке

`_get_device_and_group(parallel_config)` выбирает пару «устройство + группа»:

- `False` ⇒ `device = get_dp_group().device`, `group = get_dp_group().device_group` — тензор уезжает на GPU и all-reduce идёт по NCCL;
- `True` ⇒ `device = "cpu"`, `group = get_dp_group().cpu_group`, и один раз в лог уходит `Using CPU all reduce to synchronize DP padding between ranks.`

Дальше `_run_ar` собирает на CPU тензор `4 × dp_size`: `[0]` — число токенов без паддинга, `[1]` — с паддингом, `[2]` — флаг «готов микробатчить», `[3]` — режим CUDA graph, — и выполняет `all_reduce`. Результат даёт согласованные `should_ubatch`, `num_tokens_after_padding` и общий (минимальный по рангам) режим CUDA graph.

Поле объявлено с `field_validator(..., mode="wrap")`, который пропускает валидацию при `None`, — именно чтобы «нерешённое» значение дожило до `VllmConfig.__post_init__`.

## Значения и формат

- Три состояния: `True`, `False`, «не задан». Последнее — не то же самое, что `False`.
- `--no-disable-nccl-for-dp-synchronization` жёстко возвращает NCCL, отменяя автоматическое включение gloo при async scheduling.
- При `--data-parallel-size 1` любое значение инертно.
- gloo-путь подчиняется `--cpu-distributed-timeout-seconds`, NCCL-путь — `--distributed-timeout-seconds`.

## Когда использовать

- Оставить как есть в подавляющем большинстве случаев: связка «async scheduling ⇒ gloo» подобрана именно под то, чтобы синхронизация не создавала GPU sync point.
- `--no-disable-nccl-for-dp-synchronization` — когда async scheduling включён, но профиль показывает, что узкое место именно в CPU-коллективе (медленный межузловой gloo, шумные CPU), и хочется вернуть обмен на GPU-интерконнект.
- `--disable-nccl-for-dp-synchronization` явно — когда async scheduling выключен, но NCCL-путь ведёт себя нестабильно и хочется убрать per-step NCCL-коллектив из горячего цикла.
- Не трогайте на одноранговом развертывании: эффекта не будет.

## Влияние на производительность и память

- **Память.** Тензор `4 × dp_size` из `int32` — единицы байт. Влияния на VRAM нет.
- **Latency.** Эффект — в природе точки синхронизации, а не в объёме данных. NCCL-путь требует переноса тензора на GPU и обратно, что при async scheduling обнуляет часть выигрыша от перекрытия. gloo-путь оставляет всё на CPU, но зависит от качества CPU-сети между рангами (особенно межузловой).
- **Throughput.** Заметен только при большом числе DP-рангов и коротких шагах декодирования, где на шаг приходится один такой all-reduce.

## Взаимодействие с другими аргументами

- `--data-parallel-size`: единственный флаг, делающий этот значимым.
- `--async-scheduling`: определяет значение по умолчанию.
- `--enable-dbo`, `--dbo-decode-token-threshold`, `--dbo-prefill-token-threshold`: решение о микробатчинге передаётся именно этим all-reduce (элемент `[2]` тензора), поэтому канал синхронизации общий.
- `--cpu-distributed-timeout-seconds`: таймаут gloo-пути.
- `--distributed-timeout-seconds`: таймаут NCCL-пути.
- `--enable-expert-parallel`: не меняет механику, но повышает цену рассинхронизации рангов — при EP пустые ранги обязаны идти в ногу.

## Типовые проблемы и диагностика

- **Симптом:** async scheduling включён, но выигрыша по latency нет. **Причина:** синхронизация DP вернулась на NCCL (например, явным `--no-disable-nccl-for-dp-synchronization`). **Проверка:** отсутствие строки `Using CPU all reduce to synchronize DP padding between ranks.` **Лечение:** убрать явный флаг.
- **Симптом:** DP-развертывание тормозит именно на межузловой конфигурации. **Причина:** gloo-коллектив идёт по обычной сети между узлами. **Действие:** сравнить с `--no-disable-nccl-for-dp-synchronization` на своём профиле нагрузки.
- **Симптом:** таймаут коллектива на шаге, а не на старте. **Причина:** один из DP-рангов встал. **Лечение:** искать причину в логе конкретного ранга; таймаут задаётся соответствующим флагом (`--cpu-distributed-timeout-seconds` для gloo).
- **Подтверждение принятого значения:** `Using CPU all reduce to synchronize DP padding between ranks.` (однократно, при gloo-пути) и `Disabling NCCL for DP synchronization when using async scheduling.` (при автоматическом решении); стартовая строка конфига содержит `disable_nccl_for_dp_synchronization=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --disable-nccl-for-dp-synchronization
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --enable-expert-parallel --no-disable-nccl-for-dp-synchronization --async-scheduling
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/worker/dp_utils.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/config/scheduler.py`
