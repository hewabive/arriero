---
schema: 1
engine: vllm
primaryName: "--scheduler-cls"
title: "--scheduler-cls"
summary: Подменяет класс планировщика на свой — либо путем `mod.custom_class`, либо объектом класса при программном запуске. Интерфейс не публичный, а заданный класс отменяет автоматический выбор `AsyncScheduler`, поэтому наивная подмена стоит производительности.
group: SchedulerConfig
related:
  - --async-scheduling
  - --scheduling-policy
  - --max-num-seqs
  - --max-num-batched-tokens
  - --worker-cls
  - --worker-extension-cls
  - --additional-config
---

# --scheduler-cls

## Кратко

`--scheduler-cls` задает класс, который `EngineCore` инстанцирует вместо штатного планировщика. Это точка расширения для исследовательских политик планирования: свой порядок обхода очередей, своя эвристика вытеснения, свои квоты.

Два практических следствия, о которых легко забыть. Первое: интерфейс `SchedulerInterface` **не публичный**, движок сам об этом предупреждает и не гарантирует совместимость между версиями. Второе: как только значение задано, `get_scheduler_cls()` перестает выбирать `AsyncScheduler`, и если ваш класс унаследован от `Scheduler`, асинхронное планирование фактически отключается.

## Оригинальная справка

```text
The scheduler class to use. "vllm.v1.core.sched.scheduler.Scheduler" is
the default scheduler. Can be a class directly or the path to a class of
form "mod.custom_class".
```

## Паспорт аргумента

- Флаги: `--scheduler-cls`
- Группа argparse: `SchedulerConfig`
- Тип значения: str — путь вида `"mod.custom_class"`. Объявленный тип поля `str | type[object] | None` допускает и сам класс, но передать объект можно только программно, не через CLI
- Допустимые значения: `choices` нет; проверяется только импортируемость пути в момент старта
- Значение по умолчанию: `None` — то есть `vllm.v1.core.sched.scheduler.Scheduler` или `vllm.v1.core.sched.async_scheduler.AsyncScheduler`, в зависимости от `async_scheduling`
- Эффективное значение: не переопределяется; вместе с `async_scheduling` разрешается в `SchedulerConfig.get_scheduler_cls()`
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.scheduler_cls`
- Этап применения: инициализация `EngineCore`, один раз при старте

## Что меняет в движке

`SchedulerConfig.get_scheduler_cls()`:

- при `scheduler_cls is None` возвращает `AsyncScheduler`, если `async_scheduling` истинно, иначе `Scheduler`;
- при непустом значении печатает `warning_once`:

  ```text
  Using custom scheduler class %s. This scheduler interface is not public and
  compatibility may not be maintained. If you have subclassed Scheduler instead of
  AsyncScheduler, you will see degraded performance due to async scheduling being disabled.
  ```

- если значение не строка, возвращает его как есть; иначе резолвит через `resolve_obj_by_qualname` (`vllm/utils/import_utils.py`).

Полученный класс `EngineCore` вызывает с фиксированной сигнатурой: `vllm_config`, `kv_cache_config`, `structured_output_manager`, `include_finished_set`, `log_stats`, `block_size`, `hash_block_size`. Класс должен реализовать `SchedulerInterface` (`vllm/v1/core/sched/interface.py`), включая `schedule(throttle_prefills)`, `update_from_output`, работу с KV-connector и статистику.

Все остальные поля `SchedulerConfig` (`max_num_seqs`, `watermark`, `policy` и прочие) по-прежнему передаются в конфигурации, но соблюдать их обязан ваш класс — базовый движок никаких проверок за него не делает.

## Значения и формат

- Строка `модуль.Класс`, например `my_pkg.sched.MyScheduler`. Модуль должен быть импортируемым из процесса `vllm serve` — то есть лежать в `PYTHONPATH` или в самом окружении.
- Ошибка импорта или отсутствие атрибута приводят к исключению при старте, до загрузки весов.
- Пустая строка не является допустимым значением: пропускать аргумент нужно, а не задавать пустым.
- Наследование от `AsyncScheduler` сохраняет асинхронное планирование; наследование от `Scheduler` — нет, даже при `--async-scheduling`.

## Когда использовать

- Исследовательские и специальные политики планирования, которые нельзя выразить через `--scheduling-policy`, `--watermark` и лимиты: например, приоритеты по арендатору, честное распределение по группам, кастомные окна SLA.
- Отладка: подкласс, логирующий решения планировщика, — наименее инвазивный способ понять, почему запрос стоит в очереди.
- **Не используйте на управляемом продовом инстансе** без собственного плана сопровождения: интерфейс меняется между релизами движка без депрекации, а обновление окружения превратится в отказ старта или в тихую деградацию.
- Не используйте ради смены порядка FCFS/priority — для этого есть `--scheduling-policy`.

## Влияние на производительность и память

- **Throughput и latency.** Полностью определяются вашей реализацией. Гарантированная просадка одна: подкласс `Scheduler` (а не `AsyncScheduler`) выключает асинхронное планирование и возвращает «дыры» в загрузке GPU между шагами.
- **VRAM.** Сам аргумент память не выделяет, но реализация, игнорирующая `max_num_seqs` или проверки `allocate_slots`, способна довести KV-cache до постоянных вытеснений.
- **Время старта.** Добавляется импорт вашего модуля; величина незначимая.

## Взаимодействие с другими аргументами

- `--async-scheduling`: заданный класс перекрывает автоматический выбор. Чтобы сохранить async, наследуйтесь от `AsyncScheduler`.
- `--scheduling-policy`: значение по-прежнему попадает в `SchedulerConfig.policy`, но применяет его планировщик; ваш класс обязан сам создавать очереди через `create_request_queue(policy)`.
- `--max-num-seqs`, `--max-num-batched-tokens`, `--watermark`, `--long-prefill-token-threshold`: значения передаются, соблюдение — на вашей стороне.
- `--worker-cls`, `--worker-extension-cls`: аналогичные точки расширения на стороне воркера; планировщик и воркер подменяются независимо.
- `--additional-config`: удобный канал, чтобы передать своему планировщику собственные параметры без правки CLI движка.

## Типовые проблемы и диагностика

- **Симптом:** `ModuleNotFoundError` / `AttributeError` при старте. **Причина:** путь не резолвится `resolve_obj_by_qualname`. **Проверка:** `python -c "import my_pkg.sched"` в том же окружении (в arriero — из bin-каталога окружения инстанса).
- **Симптом:** заметная просадка throughput сразу после подмены класса. **Причина:** отключилось асинхронное планирование. **Проверка:** предупреждение `Using custom scheduler class ... you will see degraded performance due to async scheduling being disabled.` **Лечение:** наследоваться от `AsyncScheduler`.
- **Симптом:** `TypeError` о неожиданных аргументах конструктора. **Причина:** сигнатура `EngineCore` изменилась в новой версии движка. **Лечение:** сверить с `vllm/v1/engine/core.py` конкретного checkout'а.
- **Симптом:** запросы обслуживаются, но метрики пусты. **Причина:** реализация не заполняет `SchedulerStats`. **Проверка:** строка периодического лога `Running: N reqs, Waiting: M reqs`.
- **Подтверждение принятого значения:** ровно то предупреждение `Using custom scheduler class <ваш класс>` при старте. Его отсутствие означает, что аргумент не дошел до движка.

## Примеры

```bash
vllm serve /models/Qwen3-4B --scheduler-cls my_pkg.sched.MyAsyncScheduler
```

```bash
vllm serve /models/Qwen3-4B --scheduler-cls my_pkg.sched.MyAsyncScheduler --scheduling-policy priority --max-num-seqs 16
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/core/sched/interface.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/core/sched/async_scheduler.py`
- `vllm/vllm/utils/import_utils.py`
- `docs/ENVIRONMENTS.md` (arriero)
