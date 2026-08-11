---
schema: 1
engine: sglang
primaryName: "--gc-threshold"
title: "--gc-threshold"
summary: Пороги поколений сборщика мусора Python для главного процесса. Применяется только там, где живут HTTP-слой и tokenizer manager, — на scheduler-процессы не распространяется.
group: device
related:
  - --gc-warning-threshold-secs
  - --enable-cudagraph-gc
  - --tokenizer-worker-num
  - --soft-watchdog-timeout
  - --enable-metrics
---

# --gc-threshold

## Кратко

`--gc-threshold` — прямой проброс в `gc.set_threshold(*values)`: от одного до трех целых, задающих, как часто Python запускает сборку мусора по поколениям. Аргумент трогают, когда паузы GC в главном процессе начинают попадать в хвост latency: главный процесс — это HTTP-сервер, tokenizer manager и весь разбор запросов, и на высоком RPS он создает много короткоживущих объектов. Важное ограничение области действия: вызов выполняется в `_set_envs_and_config`, то есть **только в главном процессе**; scheduler'ы и detokenizer запускаются методом `spawn` как новые интерпретаторы и порогов не наследуют.

## Оригинальная справка

```text
Set the garbage collection thresholds (the collection frequency). Accepts 1 to 3 integers.
```

## Паспорт аргумента

- Флаги: `--gc-threshold`
- Группа: `device`
- Тип значения: список int (`Optional[List[int]]`, argparse `nargs="+"` — значения через пробел)
- Допустимые значения: длина от 1 до 3, проверяется в `check_server_args`: `ValueError: When setting gc_threshold, it must contain 1 to 3 integers.` Значения элементов не проверяются
- Значение по умолчанию: `null` — пороги CPython остаются как есть (`(700, 10, 10)`, если их не менял никто другой; текущее значение можно посмотреть через `python -c "import gc; print(gc.get_threshold())"`)
- Эффективное значение: совпадает с заданным; автоподбора нет
- Где объявлен: `ServerArgs.gc_threshold`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `_set_envs_and_config` в главном процессе, до запуска scheduler-подпроцессов

## Что меняет в движке

Единственная точка применения (`sglang/python/sglang/srt/entrypoints/engine.py`):

```python
if gc_threshold := server_args.gc_threshold:
    gc.set_threshold(*gc_threshold)
```

Семантика — стандартная для CPython: первый элемент — порог числа «чистых» аллокаций нулевого поколения, второй и третий — сколько сборок младшего поколения должно пройти перед сборкой старшего. Увеличение первого числа откладывает частые дешевые сборки; увеличение второго и третьего — редкие, но дорогие обходы старших поколений, которые и дают заметные паузы.

Обратите внимание на порядок в `_set_envs_and_config`: сразу перед этим вызывается `mp.set_start_method("spawn", force=True)`. Поскольку `spawn` не копирует состояние интерпретатора, дочерние процессы (scheduler, detokenizer) стартуют с порогами по умолчанию. Соседние GC-механизмы движка имеют собственные области действия:

- `--gc-warning-threshold-secs` включает `configure_gc_warning` в `TokenizerManager` — предупреждение о долгих паузах, тоже в главном процессе;
- `SGLANG_LOG_GC=1` включает `configure_gc_logger()` уже внутри `Scheduler`;
- `POST /freeze_gc` (и `Engine.freeze_gc`) вызывает `gc.freeze()` в scheduler'е и detokenizer'е — перемещает уже живые объекты в «постоянное» поколение, чтобы они не обходились при каждой сборке;
- `--enable-cudagraph-gc` управляет тем, разрешена ли сборка во время захвата CUDA graph (по умолчанию она на это время заморожена).

## Значения и формат

- От одного до трех целых через пробел: `--gc-threshold 100000`, `--gc-threshold 20000 50 50`.
- Запятые не поддерживаются: argparse отдаст `invalid int value`.
- Четыре и более значений — `ValueError: When setting gc_threshold, it must contain 1 to 3 integers.` на этапе `check_server_args`, то есть отказ на старте.
- `0` в первой позиции **отключает** сборку циклического мусора (стандартное поведение `gc.set_threshold(0)`). Утечки при этом станут неизбежны, поскольку ссылки в циклах не освобождаются; счетчик ссылок продолжит работать.
- Указанные позиции применяются слева направо; неуказанные остаются прежними.

## Когда использовать

- Высокий RPS и хвост latency, коррелирующий с паузами GC в главном процессе. Сначала подтвердите гипотезу: включите `--gc-warning-threshold-secs 0.1` и посмотрите, появляются ли предупреждения о долгих сборках.
- Много одновременно открытых стриминговых соединений: главный процесс держит состояние каждого запроса, старшие поколения растут, и обход второго поколения дорожает.
- Не трогать «профилактически». Значения по умолчанию CPython адекватны, а слишком большой первый порог просто переносит ту же работу в более редкие и более длинные паузы.
- Не ожидать эффекта на GPU-стороне: паузы внутри forward-шага к этому аргументу отношения не имеют — там работает `SGLANG_LOG_GC` для диагностики и `freeze_gc` для лечения.

## Влияние на производительность и память

- RAM хоста: более высокие пороги означают, что недостижимые циклические структуры живут дольше, и RSS главного процесса растет. При `0` в первой позиции циклический мусор не собирается вовсе.
- Latency: цель аргумента — убрать паузы из хвоста распределения. Эффект измеряется p99 TTFT, а не средним.
- Throughput: заметного влияния нет.
- VRAM: не затрагивается.
- Время старта: не меняется.

## Взаимодействие с другими аргументами

- `--gc-warning-threshold-secs`: инструмент измерения для этого же процесса — сначала он, потом настройка порогов.
- `--tokenizer-worker-num` (> 1): нагрузка на главный процесс перераспределяется по воркерам; часто это лечит проблему без настройки GC.
- `--enable-cudagraph-gc`: другой процесс и другая фаза (захват графов в scheduler'е).
- `--soft-watchdog-timeout`: если пауза GC настолько велика, что цикл tokenizer manager'а замирает, сработает именно мягкий пес с именем `TokenizerManager`.
- `--enable-metrics`: латентностные гистограммы — способ увидеть, изменился ли хвост после правки порогов.

## Типовые проблемы и диагностика

- `ValueError: When setting gc_threshold, it must contain 1 to 3 integers.` — передано больше трех значений, либо значения разделены запятыми и разобрались как одно.
- `argparse: invalid int value: '700,10,10'` — использован запятой-разделитель вместо пробелов.
- Пороги заданы, а паузы внутри forward остались — ожидаемо: аргумент не действует на scheduler-процессы. Диагностика там — `SGLANG_LOG_GC=1` (строка `Enable GC Logger` при старте scheduler'а), лечение — `POST /freeze_gc` после прогрева.
- Рост RSS главного процесса после увеличения порогов — прямое следствие; верните значения ближе к умолчанию или ограничьте только первый порог.
- Что смотреть в логе: `gc_threshold=` в дампе `server_args=`; предупреждения от `configure_gc_warning`; `Freezing GC in <context> process. gen0: …` после вызова `/freeze_gc`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --gc-threshold 100000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --gc-threshold 50000 20 20 --gc-warning-threshold-secs 0.1
```

## Источники

- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
