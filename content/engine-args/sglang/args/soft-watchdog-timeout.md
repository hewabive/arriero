---
schema: 1
engine: sglang
primaryName: "--soft-watchdog-timeout"
title: "--soft-watchdog-timeout"
summary: Диагностический таймаут: при застревании печатает дамп батча и стек через py-spy, но процесс не убивает. Не задан — мягкие сторожевые псы вообще не создаются.
group: device
related:
  - --watchdog-timeout
  - --tokenizer-worker-num
  - --dp-size
  - --chunked-prefill-size
  - --enable-metrics
---

# --soft-watchdog-timeout

## Кратко

`--soft-watchdog-timeout` включает второй, ненасильственный слой наблюдения. В отличие от `--watchdog-timeout`, он работает не только в scheduler'е, но и в tokenizer manager, detokenizer manager и (при `--dp-size > 1`) в data-parallel-контроллере, и при срабатывании только пишет в лог: дамп состояния, `py-spy dump` и строку `… watchdog timeout (…, self.soft=True)`. Сигнал никому не посылается, сервер продолжает работать. Значение по умолчанию — `null`, то есть мягкие псы **не создаются вовсе** (`Watchdog.create` возвращает no-op).

## Оригинальная справка

```text
Set soft watchdog timeout in seconds. If a forward batch takes longer than this, the server will dump information for debugging.
```

## Паспорт аргумента

- Флаги: `--soft-watchdog-timeout`
- Группа: `device`
- Тип значения: float (секунды), `Optional[float]`
- Допустимые значения: `choices` нет, границы не проверяются
- Значение по умолчанию: `null` — мягкое наблюдение выключено
- Эффективное значение: совпадает с заданным. `Watchdog.create` при `watchdog_timeout is None` отдает `_WatchdogNoop`, у которого `feed()` и `disable()` — пустышки, поэтому невключенный мягкий пес не стоит ничего
- Где объявлен: `ServerArgs.soft_watchdog_timeout`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструкторы `Scheduler` (`init_soft_watchdog`, до основной инициализации), `TokenizerManager`, `DetokenizerManager` и `DataParallelController`

## Что меняет в движке

### Четыре процесса, четыре счетчика

Одно значение включает мягкие псы сразу в нескольких ролях; отличается только то, что считается «прогрессом»:

| `debug_name` | Где создается | Что считается прогрессом |
|---|---|---|
| `Scheduler` | `scheduler.py:init_soft_watchdog` | `forward_ct` — завершенные forward-шаги |
| `TokenizerManager` | `tokenizer_manager.py:init_metric_collector_watchdog` | итерация цикла обработки входящих объектов |
| `DetokenizerManager` | `detokenizer_manager.py` | обработанное сообщение от scheduler'а |
| `DataParallelController` | `data_parallel_controller.py` | обработанное управляющее сообщение |

В трех последних наблюдение построено на паре `disable()` / `feed()`: пока цикл ждет данных из сокета, пес **выключен** (`with self.soft_watchdog.disable():`), и ожидание пустой очереди не считается зависанием; после обработки сообщения вызывается `feed()`. У scheduler'а роль `is_active` играет наличие текущего батча — та же логика, что у жесткого пса.

### Что печатается

Общий код — `WatchdogRaw._watchdog_once` (`sglang/python/sglang/srt/utils/watchdog.py`). При срабатывании:

1. только для scheduler'а — `logger.error("Scheduler debug info:\n…")` с размером текущего батча, списком запросов и результатом проверки инвариантов пулов памяти;
2. `pyspy_dump_schedulers()` → `Pyspy dump for PID <pid> (py-spy dump --native --pid <pid>):` с полным стеком **собственного** процесса (при неудаче — повтор без `--native`, затем `All pyspy dump attempts failed for PID …`);
3. `logger.error("<debug_name> watchdog timeout (self.watchdog_timeout=…, self.soft=True)")`.

Ветка `if not self.soft:` пропускается — ни задержки в 5 секунд, ни `SIGQUIT` нет. После этого внешний `while True` заходит на новый круг, поэтому при длительном зависании дампы будут повторяться примерно каждые `timeout … 1.5 × timeout` секунд: на боевом сервере это способно быстро распухнуть в логах.

### Тестовые переменные

Для проверки самого механизма есть переменные окружения `SGLANG_TEST_STUCK_TOKENIZER`, `SGLANG_TEST_STUCK_DETOKENIZER`, `SGLANG_TEST_STUCK_DP_CONTROLLER` — они заставляют соответствующий цикл один раз уснуть на заданное число секунд. `Watchdog.create` разрешает их только вместе с включенным мягким псом (иначе ассерт `stuck tester can be enabled only if soft watchdog is enabled.`).

## Значения и формат

- Секунды, дробные допустимы.
- Не задавать — и есть «выключено»; значения `0` или `-1` как «выключено» не предусмотрены. `0` создаст реального пса с нулевым таймаутом: интервал опроса `0/2 = 0` превратит поток в busy-loop, а срабатывание будет мгновенным и постоянным. Не делайте так.
- Осмысленный диапазон — заметно меньше `--watchdog-timeout`: смысл в том, чтобы получить диагностику до убийства сервера.
- Значение одно на все четыре роли; раздельной настройки нет.

## Когда использовать

- Расследование зависаний, которые заканчиваются срабатыванием жесткого пса: поставьте мягкий на треть-половину жесткого и получите стек и состав батча за минуты до падения.
- Подозрение, что тормозит не scheduler, а tokenizer или detokenizer: мягкий пес — единственный способ отличить эти случаи по логу, поскольку жесткий следит только за scheduler'ом.
- Не оставлять включенным на постоянной эксплуатации со значением, сравнимым с длительностью нормального forward: каждое срабатывание — это `py-spy dump --native`, который останавливает процесс на время снятия стека.
- Не использовать как замену метрикам: для наблюдения за нормальной работой есть `--enable-metrics`, а это инструмент разбора аварии.

## Влияние на производительность и память

- Пока не задан — влияния ровно ноль: создаются no-op объекты, `feed()` не делает ничего.
- Когда задан и не срабатывает — по одному демон-потоку на процесс, просыпающемуся раз в `timeout/2`.
- Когда срабатывает — `py-spy dump` кратковременно приостанавливает целевой процесс; на большом процессе с `--native` это может занять несколько секунд. При зацикленном зависании это повторяется постоянно.
- На память не влияет.

## Взаимодействие с другими аргументами

- `--watchdog-timeout`: жесткая пара. Мягкий должен быть меньше, иначе он никогда не успеет сработать до `SIGQUIT`.
- `--dp-size` (> 1): добавляет мягкого пса в data-parallel-контроллере.
- `--tokenizer-worker-num` (> 1): цикл `multi_http_worker_event_loop` использует того же мягкого пса detokenizer'а с той же парой `disable()`/`feed()`.
- `--chunked-prefill-size`: определяет длительность нормального forward, то есть нижнюю границу разумного значения.
- `--enable-metrics`: соседний, независимый механизм наблюдения; мягкий пес не публикует метрик.

## Типовые проблемы и диагностика

- `TokenizerManager watchdog timeout (self.watchdog_timeout=30.0, self.soft=True)` без сообщений от scheduler'а — застревание в HTTP/токенизации, а не в forward. Смотрите приложенный `Pyspy dump`.
- Мягкий пес молчит, жесткий срабатывает — значение мягкого больше или равно жесткому либо мягкий не задан.
- Лог заливает повторяющимися `Pyspy dump for PID …` — зависание не разрешилось, а мягкий пес перезапускает цикл. Это ожидаемое поведение; для однократной диагностики поднимите значение.
- Постоянные ложные срабатывания на detokenizer'е — не бывает при простое: цикл ожидания обернут в `disable()`, счетчик замирает только при реальной обработке сообщения.
- Что смотреть в логе: `Watchdog <debug_name> initialized.` подтверждает, что пес создан; отсутствие этих строк означает, что аргумент не задан.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --soft-watchdog-timeout 60
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --soft-watchdog-timeout 90 --watchdog-timeout 600
```

## Источники

- `sglang/python/sglang/srt/utils/watchdog.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/detokenizer_manager.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/managers/multi_tokenizer_mixin.py`
- `sglang/python/sglang/srt/managers/scheduler_components/invariant_checker.py`
- `sglang/python/sglang/srt/utils/cudacore_pyspy_dump_utils.py`
