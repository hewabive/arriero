---
schema: 1
engine: vllm
primaryName: "--async-scheduling"
title: "--async-scheduling"
summary: Трехпозиционный переключатель асинхронного планирования — планировщик готовит шаг N+1, пока GPU считает шаг N. По умолчанию не задан и включается автоматически везде, где это совместимо; трогают его, чтобы принудительно отключить при отладке или чтобы получить явную ошибку вместо тихого авто-отключения.
group: SchedulerConfig
related:
  - --scheduler-cls
  - --max-num-batched-tokens
  - --max-num-seqs
  - --speculative-config
  - --distributed-executor-backend
  - --pipeline-parallel-size
  - --disable-nccl-for-dp-synchronization
  - --disable-cascade-attn
  - --prefill-schedule-interval
---

# --async-scheduling

## Кратко

Без асинхронного планирования цикл движка строго последовательный: GPU считает шаг, CPU ждет результат, планирует следующий шаг, снова запускает GPU. Между шагами на карте образуется «дыра». Асинхронное планирование убирает ее: планировщик резервирует за каждым запросом `num_output_placeholders` — токены, которые шаг еще не вернул, но обязательно вернет, — и планирует следующий шаг, не дожидаясь выборки.

Это **трехпозиционный** аргумент. `--async-scheduling` — жесткое требование (несовместимая конфигурация приведет к ошибке старта), `--no-async-scheduling` — жесткий запрет, а «не задан» означает «движок решит сам», и в подавляющем большинстве конфигураций решит «включить».

## Оригинальная справка

```text
If set to False, disable async scheduling. Async scheduling helps to
avoid gaps in GPU utilization, leading to better latency and throughput.
```

## Паспорт аргумента

- Флаги: `--async-scheduling`, `--no-async-scheduling`
- Группа argparse: `SchedulerConfig`
- Тип значения: bool, объявленный как `bool | None` (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: не ограничены сверх пары флагов; «не задан» — отдельное третье состояние
- Значение по умолчанию: `None` — то есть решение отложено, а не «выключено»
- Эффективное значение: определяется в `VllmConfig.__post_init__`. Из `None` получается `True`, если ни одно из условий несовместимости не сработало, иначе `False` с предупреждением. На CPU-платформе `vllm/platforms/cpu.py` безусловно ставит `False` уже после этого
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.async_scheduling`
- Этап применения: сборка `VllmConfig` → выбор класса планировщика (`get_scheduler_cls`) → цикл движка и воркер

## Что меняет в движке

1. **Класс планировщика.** При `scheduler_cls is None` и `async_scheduling` истинном `get_scheduler_cls()` возвращает `AsyncScheduler` (`vllm/v1/core/sched/async_scheduler.py`) вместо базового `Scheduler`. `AsyncScheduler` после каждого планирования увеличивает `request.num_output_placeholders` на число токенов, которые шаг обязан выдать, и подставляет плейсхолдеры вместо еще не полученных spec-токенов. Именно это позволяет запланировать следующий шаг для того же запроса, не зная его вывода.
2. **Число одновременных батчей.** `VllmConfig.max_concurrent_batches` при включенном async становится `2` (а с Model Runner V2 — `pipeline_parallel_size + 1`) вместо `pipeline_parallel_size`. Отсюда же считается `max_in_flight_tokens = max_concurrent_batches × max_num_batched_tokens` — верхняя граница «запланированных, но еще не освобожденных» токенов, которую KV-cache резервирует для recycling-aware спецификаций (sliding window, chunked-local).
3. **Воркер.** В `MultiprocExecutor` при `use_async_scheduling` поднимается отдельный поток `WorkerAsyncOutputCopy`, который перекладывает выход шага в очередь, не блокируя основной цикл.
4. **Побочные переключения.** Если `disable_nccl_for_dp_synchronization` не задан явно, при async он ставится в `True`. Если одновременно включено спекулятивное декодирование, движок принудительно выключает cascade attention с предупреждением «Disabling cascade attention (not yet compatible with async speculative decoding)».

## Значения и формат

- **Не задан (`None`)** — движок включит async, если исполнитель его поддерживает (`uni`, `mp`) и нет несовместимых опций. Несовместимость приводит не к ошибке, а к предупреждению и тихому отключению.
- **`--async-scheduling`** — жесткое требование. Любая несовместимость — `ValueError` на старте, а не деградация.
- **`--no-async-scheduling`** — жесткое отключение; никаких проверок не выполняется.
- На CPU async всегда выключен: `vllm/platforms/cpu.py` перезаписывает поле после общей логики, поэтому даже явный `--async-scheduling` там не приведет ни к ошибке, ни к включению.

## Когда использовать

- Явный `--async-scheduling` осмысленен на управляемом сервере как **страховка**: вы хотите узнать о несовместимости из ошибки старта, а не обнаружить через месяц, что режим тихо отключился после смены исполнителя или метода спекуляции.
- `--no-async-scheduling` — при отладке расхождений вывода, при подозрении на гонку с внешним компонентом (KV-connector, свой планировщик) и при сравнительных замерах: он делает цикл детерминированно последовательным.
- Не трогайте аргумент, если инстанс работает на дефолтах и в логе нет предупреждений про async: включенное состояние уже является дефолтом.

## Влияние на производительность и память

- **Throughput и latency.** Основной выигрыш — устранение простоя GPU между шагами. Эффект тем заметнее, чем короче шаг (маленькая модель, малый батч, высокий темп decode).
- **VRAM.** Косвенный, но реальный рост: `max_in_flight_tokens` удваивается (`2 × max_num_batched_tokens` вместо `1 ×`), и для моделей с sliding-window / chunked-local KV это увеличивает резерв блоков, который KV-cache держит под незавершенные шаги. На моделях с обычным full attention эффекта на резерв нет.
- **RAM хоста.** Дополнительный поток копирования выходов в мультипроцессном исполнителе; в масштабе процесса величина незначимая.
- **Время старта.** Не влияет.
- **Точность.** Режим не меняет математику. Ограничения по спекулятивному декодированию существуют не из-за качества, а из-за того, что соответствующие реализации не умеют работать с плейсхолдерами.

## Взаимодействие с другими аргументами

- `--scheduler-cls`: заданный пользовательский класс полностью перекрывает выбор `AsyncScheduler`. Если он унаследован от `Scheduler`, а не от `AsyncScheduler`, движок предупредит о деградации производительности из-за отключенного async.
- `--speculative-config`: async поддерживается только с EAGLE/MTP, NGram GPU, `draft_model` и `dspark`. Остальные методы при `None` дают предупреждение и отключение, при явном флаге — ошибку. Отдельно несовместим `disable_padded_drafter_batch: true`.
- `--distributed-executor-backend`: `uni` и `mp` поддерживают async, Ray — нет (`supports_async_scheduling()` в `vllm/v1/executor/abstract.py` возвращает `False`, а переопределяют его только `UniProcExecutor` и `MultiprocExecutor`).
- `--pipeline-parallel-size`: с V1 model runner async и PP > 1 не совмещаются в части одновременных батчей — `max_concurrent_batches` остается `pp_size`; с V2 runner получается `pp_size + 1`.
- `--max-num-batched-tokens`: удваивает резерв in-flight токенов, см. выше.
- `--disable-nccl-for-dp-synchronization`: при незаданном значении включается вместе с async.
- `--disable-cascade-attn`: принудительно включается при связке async + спекулятивное декодирование.
- `--prefill-schedule-interval`: работает и с `AsyncScheduler` — интерфейс `schedule(throttle_prefills)` у обоих классов один.
- `--runner`: для pooling-моделей (`runner_type == "pooling"`) async при `None` отключается — на них реализация дает не выигрыш, а потерю.

## Типовые проблемы и диагностика

- **Симптом:** `` `ray` does not support async scheduling yet. `` **Причина:** явный `--async-scheduling` с Ray-исполнителем. **Лечение:** снять флаг (тогда движок сам отключит async с предупреждением) или перейти на `mp`.
- **Симптом:** `Currently, async scheduling is only supported with EAGLE/MTP/Draft Model/NGram GPU/DSpark kind of speculative decoding`. **Причина:** явный флаг вместе с неподдерживаемым методом спекуляции. **Лечение:** сменить метод или убрать явный флаг.
- **Симптом:** `Async scheduling is not compatible with disable_padded_drafter_batch=True.` **Лечение:** убрать `disable_padded_drafter_batch` из `--speculative-config`.
- **Симптом (ROCm):** `Async scheduling is not compatible with ROCm DeepEP high-throughput DBO. Please use --no-async-scheduling or select a different all2all backend.`
- **Симптом:** ожидали async, а производительность как в синхронном режиме. **Проверка:** ищите в логе `warning_once`-строки `Async scheduling will be disabled because it is not supported with the ... distributed executor backend` и `Async scheduling not supported with %s-based speculative decoding and will be disabled.` **Лечение:** устранить причину или зафиксировать явным флагом, чтобы отключение стало ошибкой.
- **Проверка принятого значения:** отдельной строки «async scheduling enabled» движок не печатает. Косвенное подтверждение — отсутствие перечисленных предупреждений и наличие потока `WorkerAsyncOutputCopy` в мультипроцессном запуске.
- **Симптом (arriero):** после смены версии движка инстанс стал медленнее без изменения аргументов. **Причина:** авто-отключение по новому условию совместимости. **Лечение:** посмотреть managed-лог инстанса на предупреждения выше — они печатаются один раз при старте, до открытия HTTP-порта.

## Примеры

```bash
vllm serve /models/Qwen3-4B --async-scheduling --max-num-seqs 8
```

```bash
vllm serve /models/Qwen3-4B --no-async-scheduling --max-num-batched-tokens 4096
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/core/sched/async_scheduler.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/executor/abstract.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/v1/executor/uniproc_executor.py`
- `vllm/vllm/platforms/cpu.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
