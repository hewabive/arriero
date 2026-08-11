---
schema: 1
engine: sglang
primaryName: "--dynamic-batch-tokenizer-batch-size"
title: "--dynamic-batch-tokenizer-batch-size"
summary: Верхняя граница числа запросов, которые динамический батчер токенизации соберет в один вызов. Действует только вместе с --enable-dynamic-batch-tokenizer и почти никогда не является ограничивающим фактором — им обычно оказывается таймаут.
group: serving
related:
  - --enable-dynamic-batch-tokenizer
  - --dynamic-batch-tokenizer-batch-timeout
  - --enable-tokenizer-batch-encode
  - --tokenizer-worker-num
  - --max-running-requests
---

# --dynamic-batch-tokenizer-batch-size

## Кратко

`--dynamic-batch-tokenizer-batch-size` — максимальный размер батча, который соберет `AsyncDynamicbatchTokenizer`. Цикл добора элементов прекращается, как только набрано это число либо истекло окно `--dynamic-batch-tokenizer-batch-timeout`.

Практически ограничивающим оказывается второй параметр: при окне в 2 миллисекунды набрать 32 запроса можно только на очень высокой частоте обращений. Поэтому увеличение размера батча без увеличения таймаута обычно ничего не меняет.

Аргумент не действует, если не задан `--enable-dynamic-batch-tokenizer` — об этом прямо сказано в самой справке.

## Оригинальная справка

```text
[Only used if --enable-dynamic-batch-tokenizer is set] Maximum batch size for dynamic batch tokenizer.
```

## Паспорт аргумента

- Флаги: `--dynamic-batch-tokenizer-batch-size`
- Группа: `serving`
- Тип значения: int
- Допустимые значения: `choices` нет; отдельной проверки в `check_server_args` тоже нет. Осмысленный диапазон — от единиц до сотен
- Значение по умолчанию: `32`
- Эффективное значение: совпадает с заданным. Ни один `_handle_*` его не переписывает; при выключенном `--enable-dynamic-batch-tokenizer` значение просто никуда не попадает, потому что объект батчера не создается
- Где объявлен: `ServerArgs.dynamic_batch_tokenizer_batch_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация `TokenizerManager` — передается в конструктор `AsyncDynamicbatchTokenizer(tokenizer, max_batch_size=..., batch_wait_timeout_s=...)`

## Что меняет в движке

Значение становится полем `max_batch_size` батчера и используется ровно в одном условии цикла (`managers/async_dynamic_batch_tokenizer.py`):

```python
while len(prompts) < self.max_batch_size:
    elapsed = loop.time() - start_time
    if elapsed >= self.batch_wait_timeout_s:
        break
    remaining_time = self.batch_wait_timeout_s - elapsed
    try:
        prompt, kwargs, fut = await asyncio.wait_for(self._queue.get(), remaining_time)
        ...
    except asyncio.TimeoutError:
        break
```

Обратите внимание на структуру: окно ожидания вообще не открывается, если в момент забора первого элемента очередь пуста — такой запрос обрабатывается немедленно. Значит, размер батча начинает играть роль только тогда, когда запросы уже стоят в очереди.

Собранный набор передается в один вызов токенизатора при условии однородности kwargs; иначе распадается на последовательные вызовы, и размер батча становится просто числом обработанных подряд элементов.

## Значения и формат

- Целое. Отрицательное или нулевое значение сделает условие `len(prompts) < max_batch_size` ложным сразу, и каждый элемент будет обрабатываться поодиночке — то есть фактически отключит батчинг, не выдав никакой ошибки. Проверок на это в коде нет.
- Дефолт `32` соответствует типичной глубине очереди при окне в 2 миллисекунды и коротких промптах.
- Верхней границы нет, но набрать батч больше того, что успевает прийти за окно, невозможно. Увеличивать этот аргумент имеет смысл только вместе с `--dynamic-batch-tokenizer-batch-timeout`.
- Размер батча ограничен и сверху общей конкурентностью: больше, чем одновременно обрабатываемых запросов, в очереди не появится.

## Когда использовать

- Вы увеличили `--dynamic-batch-tokenizer-batch-timeout` и в отладочных логах видите, что батчи стабильно упираются в 32 — тогда есть смысл поднять и размер.
- Очень высокая частота коротких запросов при большом `--max-running-requests`.
- Не трогайте, пока не измерили. Диагностическая строка `AsyncDynamicbatchTokenizer: Processing dynamic batch of size N` пишется на уровне DEBUG — именно она показывает, достигается ли текущий предел.
- Не задавайте без `--enable-dynamic-batch-tokenizer`: значение будет принято argparse и никуда не попадет.

## Влияние на производительность и память

- **CPU:** больший батч амортизирует фиксированную стоимость вызова токенизатора на большее число запросов. Зависимость убывающая — основной выигрыш дают первые несколько элементов в батче.
- **Latency:** сам по себе размер задержку не увеличивает. Ожидание ограничено таймаутом, а не размером: цикл прекращает набор по истечении окна независимо от того, сколько собрано.
- **RAM:** в памяти одновременно держатся тексты батча, их kwargs и объекты future. При батче в сотни длинных промптов это заметный, хотя и короткоживущий, пик в HTTP-процессе.
- **VRAM и время старта:** не затрагиваются.

## Взаимодействие с другими аргументами

- `--enable-dynamic-batch-tokenizer`: обязательное условие применения.
- `--dynamic-batch-tokenizer-batch-timeout`: фактический ограничитель набора; эти два аргумента настраиваются только вместе.
- `--enable-tokenizer-batch-encode`: взаимоисключающий с самим механизмом динамического батчинга.
- `--tokenizer-worker-num`: делит поток запросов между воркерами, поэтому очередь в каждом короче и предел размера достигается реже.
- `--max-running-requests`: верхняя граница числа запросов в работе, а значит и практический потолок глубины очереди токенизации.

## Типовые проблемы и диагностика

- **Симптом:** увеличили размер, ничего не изменилось. **Причина:** ограничивает таймаут, а не размер. **Проверка:** DEBUG-строки `Processing dynamic batch of size N` — если N устойчиво меньше предела, увеличивать нечего.
- **Симптом:** батчинг фактически не работает при явно заданном значении. **Причина:** значение `0` или отрицательное — цикл добора не выполняется ни разу. **Лечение:** задать положительное.
- **Симптом:** всплески RSS HTTP-процесса. **Причина:** большой батч длинных промптов. **Лечение:** уменьшить размер.
- **Симптом:** значение задано, а батчера нет. **Причина:** не задан `--enable-dynamic-batch-tokenizer` либо задан `--skip-tokenizer-init`, который его выключает. **Подтверждение:** дамп `server_args=` покажет `enable_dynamic_batch_tokenizer=False`.

## В arriero

Аргумент имеет смысл только вместе с `--enable-dynamic-batch-tokenizer`, а тот для профиля KTransformers не оправдан: конкурентность инстанса ограничена снаружи (`concurrency: "sglang-max-running-requests"` в дескрипторе движка), конкурирующие запросы выстраиваются в очередь координатора домена, а квалифицированный профиль (`docs/KTRANSFORMERS_OPERATIONS.md`) проверен на двух одновременных запросах. При такой глубине очереди батч размером 32 недостижим в принципе.

Оставляйте значение по умолчанию и не добавляйте аргумент в конфигурацию инстанса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --host 127.0.0.1 --port 30000 --enable-dynamic-batch-tokenizer --dynamic-batch-tokenizer-batch-size 64
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --host 127.0.0.1 --port 30000 --enable-dynamic-batch-tokenizer --dynamic-batch-tokenizer-batch-size 128 --dynamic-batch-tokenizer-batch-timeout 0.01 --max-running-requests 256
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/async_dynamic_batch_tokenizer.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`
