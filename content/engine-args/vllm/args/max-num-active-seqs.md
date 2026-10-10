---
schema: 1
engine: vllm
primaryName: "--max-num-active-seqs"
title: "--max-num-active-seqs"
summary: Отдельный потолок впуска запросов в running-очередь, не меняющий размеры model runner'а и сетку CUDA graphs. Нужен, когда decode-батч надо держать уже, чем `--max-num-seqs`, без перекомпиляции и перезахвата графов.
group: SchedulerConfig
related:
  - --max-num-seqs
  - --max-num-batched-tokens
  - --max-num-queued-reqs
  - --max-cudagraph-capture-size
  - --scheduling-policy
  - --data-parallel-size
  - --performance-mode
---

# --max-num-active-seqs

## Кратко

До этого флага `--max-num-seqs` делал две вещи сразу: задавал размер model runner'а (буферы на запрос, ширина персистентного батча, сетка CUDA graphs) и был лимитом впуска в RUNNING. `--max-num-active-seqs` разделяет эти роли: впуск можно сделать уже, а runner и графы остаются рассчитанными на `--max-num-seqs`.

Не задан (`None`) — лимит впуска равен `--max-num-seqs`, поведение прежнее. Задан — в running-очереди одновременно не больше указанного числа запросов, остальные ждут в waiting-очереди движка.

## Оригинальная справка

```text
Maximum number of requests the scheduler admits into RUNNING.

``max_num_seqs`` sizes the model runner (per-request buffers and CUDA
graph capture) and is also the default admission limit. Setting this
lowers only the number of requests that may occupy RUNNING, so decode
batches stay smaller without shrinking runner or graph capacity. Must
be ``<= max_num_seqs``. ``None`` (default) keeps current behavior.
```

## Паспорт аргумента

- Флаги: `--max-num-active-seqs`
- Группа argparse: `SchedulerConfig`
- Тип значения: int (число запросов)
- Допустимые значения: `>= 1` (валидация `Field(default=None, ge=1)`) и не больше эффективного `max_num_seqs` (проверка `SchedulerConfig.verify_max_model_len`)
- Значение по умолчанию: `None` — отдельного лимита нет, впуск ограничен `max_num_seqs`
- Эффективное значение: движок значение не подбирает. Сравнение с `max_num_seqs` идет **после** автоподбора `_set_default_max_num_seqs_and_batched_tokens_args`, то есть при незаданном `--max-num-seqs` верхняя граница — автоподобранное число (256, 1024 и т. п., см. `--max-num-seqs`)
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.max_num_active_seqs`
- Этап применения: `create_engine_config` → валидация `SchedulerConfig` → планировщик, на каждом шаге при впуске из waiting-очереди

## Что меняет в движке

В `Scheduler.__init__` теперь два счетчика:

- `max_num_running_reqs = max_num_seqs` — число слотов model runner'а; на нем держится инвариант `assert len(self.running) <= self.max_num_running_reqs`;
- `max_num_active_reqs = max_num_active_seqs`, а если он `None` — тот же `max_num_running_reqs`.

В `Scheduler.schedule()` обход waiting-очереди прекращается, когда `len(self.running) + num_waiting_for_streaming_input >= max_num_active_reqs`. Приостановленные streaming-сессии (`WAITING_FOR_STREAMING_REQ`) в running не числятся, но держат слот runner'а и потому учитываются в этом счетчике.

Что **не** меняется: `GPUModelRunner` по-прежнему получает `max_num_reqs = max_num_seqs`, `max_cudagraph_capture_size` по-прежнему выводится из `max_num_seqs`, прогрев сэмплера идет на `min(max_num_seqs, max_num_batched_tokens)` запросов. Все, что `--max-num-seqs` резервирует по памяти, резервируется так же.

Хеш компиляции (`SchedulerConfig.compute_hash`) включает `max_num_batched_tokens` и `max_num_seqs`, но не `max_num_active_seqs`. Изменение этого флага не инвалидирует кэш `torch.compile`, в отличие от изменения `--max-num-seqs`.

Лимит действует на один экземпляр планировщика, то есть на один DP-ранг. Вытеснение (preemption) при нехватке KV-cache работает как раньше: вытесненный запрос возвращается в waiting-очередь и снова проходит через тот же лимит впуска.

## Значения и формат

- Целое число запросов, минимум 1.
- `None` (флаг не задан) — лимит впуска равен `max_num_seqs`.
- Значение больше эффективного `max_num_seqs` отвергается на старте: `max_num_active_seqs (N) cannot be greater than max_num_seqs (M).`
- `0` и отрицательные значения отвергает pydantic-валидация `ge=1` при сборке `SchedulerConfig`.
- Значение, равное `max_num_seqs`, эквивалентно незаданному флагу.

## Когда использовать

- Нужно сузить decode-батч ради ITL/TPOT, но не хочется перекомпилировать модель и перезахватывать CUDA graphs: смена `--max-num-active-seqs` не меняет ни хеш компиляции, ни сетку графов.
- Подбор рабочей конкурентности на одной и той же конфигурации runner'а: меняется только впуск, память под буферы и графы остается той же, поэтому замеры сравнимы.
- Не используйте ради экономии VRAM: память под буферы runner'а, графы и прогрев сэмплера определяет `--max-num-seqs`. Если цель — освободить память, понижайте `--max-num-seqs`.
- Не используйте как защиту от переполнения очереди: лимит впуска не отклоняет запросы, они копятся в waiting-очереди. Отказ с HTTP 503 дают `--max-num-queued-reqs` и `--max-num-queued-tokens`.

## Влияние на производительность и память

- **VRAM.** Прямого влияния нет: буферы runner'а, графы и прогрев сэмплера рассчитаны по `--max-num-seqs`. Косвенно меньше одновременных запросов претендует на KV-блоки, поэтому реже случаются вытеснения.
- **Latency.** Шаг декодирования короче при меньшем батче, ITL работающих запросов ниже. Ожидание в очереди (TTFT новых запросов) при нагрузке выше потолка растет.
- **Throughput.** При нагрузке выше потолка падает пропорционально сужению батча.
- **Время старта.** Не влияет: захват графов и прогрев идут по `--max-num-seqs`.

## Взаимодействие с другими аргументами

- `--max-num-seqs`: жесткая верхняя граница значения и источник размеров runner'а и графов. Пара `--max-num-seqs 64 --max-num-active-seqs 16` резервирует память на 64 запроса, а пускает в работу 16.
- `--max-num-batched-tokens`: бюджет токенов шага никак не связан с этим флагом; проверка `max_num_batched_tokens >= max_num_seqs` по-прежнему идет против `--max-num-seqs`.
- `--max-cudagraph-capture-size`: если декод-батч не превышает `--max-num-active-seqs`, графы на большие размеры захватываются, но не используются. Сузить сетку можно только этим флагом или понижением `--max-num-seqs`.
- `--scheduling-policy`: определяет, кто из waiting-очереди займет освободившееся место под лимитом.
- `--max-num-queued-reqs`: лимит API-сервера на все запросы в полете (waiting + running) по всем DP-рангам; срабатывает отказом 503, а не очередью.
- `--data-parallel-size`: лимит действует на каждый ранг, суммарно в работе может быть до `data_parallel_size × max_num_active_seqs` запросов.
- `--performance-mode`: `throughput` удваивает только автоподобранный `max_num_seqs`; `--max-num-active-seqs` он не трогает.

## Типовые проблемы и диагностика

- **Симптом:** `max_num_active_seqs (32) cannot be greater than max_num_seqs (16).` на старте. **Причина:** значение выше эффективного `max_num_seqs`, в том числе автоподобранного или зажатого `max_num_batched_tokens`. **Лечение:** понизить флаг или явно поднять `--max-num-seqs`.
- **Симптом:** VRAM после включения флага не освободилась. **Причина:** флаг не меняет размеры runner'а и графов. **Лечение:** понизить `--max-num-seqs`.
- **Симптом:** `Waiting: N reqs` стабильно больше 0 при низком `GPU KV cache usage`. **Причина:** лимит впуска ниже, чем позволяет память. **Проверка:** `Running: M reqs` в периодическом логе не поднимается выше заданного значения. **Лечение:** поднять флаг или убрать его.
- **Подтверждение принятого значения:** строка `non-default args: {...}` при старте API-сервера содержит `max_num_active_seqs`; периодический лог `Running: N reqs` не превышает значения.
- **Симптом (arriero):** движок держит часть запросов к vLLM-цели в своей waiting-очереди, хотя прокси должен был придержать их у себя. **Причина:** прокси ограничивает одновременные запросы на цель меньшим из `--max-num-seqs` и `--max-num-active-seqs`, но читает оба только из аргументов инстанса под этими именами: значение из `--config`-файла или в написании `--max_num_active_seqs` он не видит (`docs/RESOURCE_MANAGEMENT.md`, arriero). **Проверка:** сравнить `Running`/`Waiting` в логе движка со статусом модели в arriero. **Лечение:** задать флаг в аргументах инстанса под именем `--max-num-active-seqs`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --max-num-seqs 64 --max-num-active-seqs 16
```

```bash
vllm serve /models/Qwen3-4B --max-num-seqs 128 --max-num-batched-tokens 8192 --max-num-active-seqs 32 --max-model-len 16384
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/tests/v1/core/test_scheduler.py`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
