---
schema: 1
engine: sglang
primaryName: "--watchdog-timeout"
title: "--watchdog-timeout"
summary: Сколько секунд scheduler может не завершать ни одного forward, прежде чем сторожевой поток убьет весь сервер. Это единственный аргумент, который превращает зависание в падение.
group: device
related:
  - --soft-watchdog-timeout
  - --chunked-prefill-size
  - --max-running-requests
  - --context-length
  - --dist-timeout
  - --cuda-graph-max-bs-decode
  - --tp-size
  - --pp-size
---

# --watchdog-timeout

## Кратко

В каждом scheduler-процессе живет демон-поток, который раз в `timeout/2` секунд смотрит на счетчик выполненных forward-шагов. Если счетчик не двигается дольше `--watchdog-timeout` секунд, поток печатает дамп состояния, запускает `py-spy dump` по своему процессу, ждет 5 секунд и посылает **родительскому** процессу `SIGQUIT` — тот убивает все дерево процессов. Значение по умолчанию `300` секунд: это верхняя оценка «самого длинного законного forward», и на очень больших prefill или на медленном железе ее приходится поднимать, иначе живой сервер убьет сам себя.

## Оригинальная справка

```text
Set watchdog timeout in seconds. If a forward batch takes longer than this, the server will crash to prevent hanging.
```

## Паспорт аргумента

- Флаги: `--watchdog-timeout`
- Группа: `device`
- Тип значения: float (секунды)
- Допустимые значения: `choices` нет, границы не проверяются. Значение делится пополам как интервал опроса, поэтому очень маленькое значение превращает поток в busy-loop
- Значение по умолчанию: `300`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает. Отключить сторожевой пес нельзя — в отличие от `--soft-watchdog-timeout`, здесь нет значения «выключено»
- Где объявлен: `ServerArgs.watchdog_timeout`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `Scheduler` (`init_watch_dog_memory_saver_input_blocker`), сразу после инициализации model worker; поток живет весь срок жизни процесса

## Что меняет в движке

### Что именно наблюдается

`create_scheduler_watchdog` (`sglang/python/sglang/srt/managers/scheduler_components/invariant_checker.py`) создает `WatchdogRaw` с тремя ручками:

- счетчик — `scheduler.forward_ct`, то есть число запущенных forward-шагов;
- признак активности — `scheduler.is_initializing or scheduler.cur_batch_for_debug is not None`. Когда очереди пусты и батча нет, счетчик не проверяется: **простой сервера сторожевой пес не считает зависанием**. Зато фаза инициализации считается активной, и зависший старт (например, сбор distributed-группы) тоже попадет под таймаут;
- дамп — размер и содержимое текущего батча плюс проверка инвариантов всех пулов памяти.

Цикл (`sglang/python/sglang/srt/utils/watchdog.py`) прост: спит `watchdog_timeout / 2`, сравнивает счетчик с предыдущим; если счетчик не менялся дольше таймаута — срабатывает. Из этого следует, что реальная задержка срабатывания лежит между `timeout` и `1.5 × timeout`.

### Что происходит при срабатывании

1. `logger.error("Scheduler debug info:\n…")` — размер текущего батча, список запросов и результат проверки инвариантов KV/SWA/mamba-пулов;
2. `pyspy_dump_schedulers()` — `py-spy dump --native --pid <свой pid>`, при неудаче повтор без `--native`. Результат уходит в лог как `Pyspy dump for PID …`; если `py-spy` не установлен — `Pyspy failed (…)`;
3. `logger.error("Scheduler watchdog timeout (self.watchdog_timeout=…, self.soft=False)")`;
4. пауза 5 секунд, затем `SIGQUIT` родителю.

Родитель — это процесс, запустивший scheduler. На фазе старта обработчик `launch_phase_sigquit_handler` печатает `Received sigquit from a child process. It usually means the child failed.` и вызывает `kill_process_tree`. После запуска HTTP-сервера обработчик заменяется на `SignalHandler.running_phase_sigquit_handler`: `SIGQUIT received. signum=…, frame=…. It usually means one child failed.`, затем дамп незавершенных запросов (`dump_requests_before_crash`) и `kill_process_tree`. То есть срабатывание пса — это гарантированное завершение **всего** сервера, а не одного ранга.

## Значения и формат

- Секунды, дробные допустимы (`--watchdog-timeout 7.5`).
- Значения «выключено» нет. Практический способ отключить — задать заведомо большое число (апстрим в примерах pipeline-parallelism использует `--watchdog-timeout 3600`, а в Ascend-конфигурациях встречается `9000`).
- Значение должно превышать самый долгий законный forward. Ориентир — время полного chunk'а prefill при заданном `--chunked-prefill-size` на самой длинной поддерживаемой последовательности, плюс запас.
- Слишком маленькое значение опасно вдвойне: помимо ложных срабатываний, интервал опроса `timeout/2` заставляет поток просыпаться часто.

## Когда использовать

- Поднимать, когда сервер падает с `Scheduler watchdog timeout` под легальной нагрузкой: очень длинный контекст, отключенный chunked prefill (`--chunked-prefill-size -1`), медленный CPU-оффлоад, большой `--pp-size` с длинными межстадийными ожиданиями. Апстрим-документация по pipeline parallelism ставит `3600` во всех примерах.
- Поднимать на профиле KTransformers: часть MoE-слоя считается на CPU, и forward под конкурентной нагрузкой длится в разы дольше, чем на чистом GPU.
- Опускать имеет смысл только там, где зависший сервер дороже ложного перезапуска и есть внешний супервизор, который поднимет процесс.
- Не трогать при отладке дедлоков — вместо этого включите `--soft-watchdog-timeout` с меньшим значением: получите дамп и стек без убийства сервера.

## Влияние на производительность и память

- На производительность не влияет: поток спит `timeout/2` и читает одно целое число. При очень маленьком значении заметен только рост числа пробуждений.
- На память не влияет.
- В момент срабатывания добавляется задержка: сбор дампа, `py-spy dump --native` (может занять секунды на большом процессе) и фиксированные 5 секунд ожидания перед `SIGQUIT`.

## Взаимодействие с другими аргументами

- `--soft-watchdog-timeout`: тот же механизм, но `soft=True` — только лог и дамп, без `SIGQUIT`. Осмысленная пара: мягкий таймаут заметно меньше жесткого, чтобы получить диагностику до падения.
- `--chunked-prefill-size`: главный регулятор длительности одного forward. Отключение chunked prefill (`-1`) — самая частая причина, по которой дефолтных 300 с перестает хватать.
- `--max-running-requests` / `--cuda-graph-max-bs-decode`: большие батчи удлиняют шаг decode.
- `--context-length`: определяет верхнюю границу длины prefill-запроса.
- `--dist-timeout`: соседний, но независимый таймаут. Он про сбор `torch.distributed` и коллективы; зависание в NCCL после старта увидит именно сторожевой пес scheduler'а, а не он.
- `--pp-size`: при pipeline parallelism ожидание микробатча от соседней стадии тоже входит в «время между forward».

## Типовые проблемы и диагностика

- `Scheduler watchdog timeout (self.watchdog_timeout=300.0, self.soft=False)` с последующим `SIGQUIT received. …` и обрывом всех соединений — либо реальный дедлок, либо законный, но слишком долгий forward. Различить помогает предшествующий `Scheduler debug info:` (какой батч висел) и `Pyspy dump for PID …` (в каком кадре стоит поток).
- Сервер падает ровно через ~300 с после первого большого запроса — почти наверняка легальный долгий forward. Поднимайте таймаут или уменьшайте `--chunked-prefill-size`.
- Падение на старте с тем же сообщением — сторожевой пес считает фазу инициализации активной. Смотрите, на чем встал старт: чаще всего `Init torch distributed begin.` без парной строки `Init torch distributed ends.`
- Нет строк `Pyspy dump` — `py-spy` не установлен в окружении. Установка (`pip install py-spy`) заметно улучшает диагностику, но не влияет на само срабатывание.
- В логе нет ни одного упоминания сторожевого пса при старте — проверьте `Watchdog Scheduler initialized.`: строка печатается при создании и подтверждает, что поток запущен.
- **В arriero:** убийство дерева процессов выглядит как неожиданная смерть инстанса. Процесс закроется с `stopReason: "crash"`, а причину придется искать в `runtime/logs/` — фильтрованный лог сохраняет строки `watchdog timeout` и `SIGQUIT received`, так как они не относятся к отфильтрованным probe-запросам.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --watchdog-timeout 900
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --watchdog-timeout 3600 --soft-watchdog-timeout 120 --chunked-prefill-size 4096
```

## Источники

- `sglang/python/sglang/srt/utils/watchdog.py`
- `sglang/python/sglang/srt/managers/scheduler_components/invariant_checker.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/utils/cudacore_pyspy_dump_utils.py`
- `sglang/docs/docs/advanced_features/pipeline_parallelism.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
