---
schema: 1
engine: sglang
primaryName: "--show-time-cost"
title: "--show-time-cost"
summary: Включает глобальный флаг для ручных таймеров mark_start/mark_end. В checkout'е, на котором снят extract, у этих таймеров нет ни одного места вызова, поэтому аргумент ничего не печатает.
group: observability
related:
  - --enable-request-time-stats-logging
  - --enable-metrics
  - --enable-mfu-metrics
  - --export-metrics-to-file
  - --decode-log-interval
---

# --show-time-cost

## Кратко

Флаг делает ровно одно: `ModelRunner.__init__` вызывает `enable_show_time_cost()`, а та выставляет модульную глобальную переменную `show_time_cost = True` в `sglang/python/sglang/srt/utils/common.py`. Эту переменную читают только две функции — `mark_start` и `mark_end`, — которые накапливают время между «метками» и печатают накопленное, когда прирост превысил порог.

В checkout'е, на котором снят extract (commit `b20c375c`), **ни одного вызова `mark_start` или `mark_end` в дереве нет**. Проверяется одной командой:

```bash
grep -rn "mark_start\|mark_end" --include=*.py runtime/sources/sglang | grep -v "def mark_"
```

То есть аргумент включает механизм, у которого не осталось точек измерения. Он не ломает ничего и не печатает ничего.

## Оригинальная справка

```text
Show time cost of custom marks.
```

## Паспорт аргумента

- Флаги: `--show-time-cost`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — парной формы `--no-show-time-cost` нет
- Допустимые значения: флаг присутствует или отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; никакой `_handle_*` его не трогает
- Где объявлен: `ServerArgs.show_time_cost`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но фактически нерабочий в этом дереве (см. «Кратко»)
- Этап применения: инициализация `ModelRunner`, то есть в процессах scheduler/TP-воркеров, до захвата CUDA graph

## Что меняет в движке

`mark_start(name, interval=0.1, color=0, indent=0)` и `mark_end(name)` реализуют примитивный накопительный таймер:

- обе функции сразу выходят, если `show_time_cost` ложно;
- обе вызывают `torch.cuda.synchronize()` — то есть измерение принудительно синхронизирует GPU;
- `mark_end` печатает накопленное время через `print()` с ANSI-раскраской, когда прирост с прошлой печати превысил `interval` (по умолчанию 0.1 с).

Вывод идет через `print`, а не через логгер, поэтому у строк нет ни метки времени, ни префикса ранга — они попадают в stdout процесса как есть.

Флаг устанавливается в `ModelRunner`, значит глобальная переменная становится истинной только в процессах, где живет модель. В tokenizer-процессе она остается ложной.

Отдельно существует декоратор `calculate_time(show=..., min_cost_ms=...)` в том же файле; он не читает `show_time_cost` и от этого аргумента не зависит. Мест вызова у него в дереве тоже нет.

## Значения и формат

- Флаг без значения: `--show-time-cost`.
- Выключить обратно в командной строке нечем.
- Никакой настройки порога, цвета или отступа через CLI нет — это параметры функции `mark_start`, доступные только из кода.

## Когда использовать

- Практически — не использовать: в текущем дереве он не производит вывода.
- Единственный осмысленный сценарий: вы сами добавили `mark_start`/`mark_end` в форк или патч и хотите включить их без правки кода.
- Для реальных измерений в этой версии есть работающие инструменты: `--enable-request-time-stats-logging` (потайминговая статистика по запросу), `--enable-metrics` и `--enable-mfu-metrics` (Prometheus), `--export-metrics-to-file` (пофайловая выгрузка метрик запроса), эндпоинты `/start_profile` и `/stop_profile` (torch-профилировщик) и строки `Decode batch` с частотой `--decode-log-interval`.

## Влияние на производительность и память

В текущем дереве влияния нет: точек измерения не осталось, ни одна ветка кода не выполняется. Если точки измерения появятся (форк, будущий релиз), цена станет заметной: каждый `mark_start`/`mark_end` выполняет `torch.cuda.synchronize()`, что уничтожает асинхронность запуска ядер и способно ощутимо просадить throughput. На VRAM не влияет в любом случае.

## Взаимодействие с другими аргументами

- `--enable-request-time-stats-logging`: независимый и работающий канал таймингов по запросу.
- `--enable-metrics` / `--enable-mfu-metrics`: Prometheus-метрики, включая гистограммы latency; это штатная замена.
- `--export-metrics-to-file` (вместе с `--export-metrics-to-file-dir`): выгрузка метрик каждого запроса в файлы.
- `--decode-log-interval`: частота периодических строк со статистикой decode-батча.
- С аргументами памяти и планировщика не связан никак.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, в логе ничего нового. **Причина:** в дереве нет вызовов `mark_start`/`mark_end`. **Проверка:** команда `grep` из раздела «Кратко». **Лечение:** использовать работающие инструменты из списка выше.
- **Симптом:** ожидали строки в файле лога, но их нет даже после добавления меток в форк. **Причина:** вывод идет через `print()` в stdout процесса scheduler, а не через логгер; если stdout перенаправлен иначе, строки уйдут туда.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `show_time_cost=`.

## В arriero

Аргумент безвреден: он не добавляет строк в лог инстанса и, соответственно, не влияет на классификацию лога (`apps/api/src/process/log-parsers/sglang.ts`) и на состояние здоровья. Но и пользы от него нет — в списке аргументов инстанса это мертвый вес.

Для наблюдения за задержками управляемого инстанса arriero дает более прямой источник: трассы запросов прокси (`#/proxy/traces`, `docs/API_PROXY_FOUNDATION.md`, arriero) с посекундной разбивкой и 30-дневной историей, плюс `--enable-metrics` на стороне движка, если нужны гистограммы TTFT и inter-token latency.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --show-time-cost
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics --enable-request-time-stats-logging
```

## Источники

- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `apps/api/src/process/log-parsers/sglang.ts`
