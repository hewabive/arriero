---
schema: 1
engine: sglang
primaryName: "--dynamic-batch-tokenizer-batch-timeout"
title: "--dynamic-batch-tokenizer-batch-timeout"
summary: Окно ожидания в секундах, в течение которого динамический батчер добирает соседние запросы. Это и есть верхняя граница добавленной задержки — и практически именно она, а не размер батча, определяет, сколько запросов соберется.
group: serving
related:
  - --enable-dynamic-batch-tokenizer
  - --dynamic-batch-tokenizer-batch-size
  - --enable-tokenizer-batch-encode
  - --tokenizer-worker-num
  - --max-running-requests
  - --stream-interval
---

# --dynamic-batch-tokenizer-batch-timeout

## Кратко

`--dynamic-batch-tokenizer-batch-timeout` задает, сколько секунд динамический батчер готов ждать соседей после того, как забрал из очереди первый запрос. Значение по умолчанию — `0.002`, то есть 2 миллисекунды.

Два свойства делают этот параметр безопасным по умолчанию и одновременно малополезным при низкой нагрузке:

1. Ожидание **не начинается**, если очередь пуста в момент забора первого элемента, — такой запрос токенизируется немедленно.
2. Ожидание прерывается досрочно, как только набрано `--dynamic-batch-tokenizer-batch-size`.

Поэтому окно — это гарантированный потолок добавленной задержки, а не постоянная надбавка.

## Оригинальная справка

```text
[Only used if --enable-dynamic-batch-tokenizer is set] Timeout in seconds for batching tokenization requests.
```

## Паспорт аргумента

- Флаги: `--dynamic-batch-tokenizer-batch-timeout`
- Группа: `serving`
- Тип значения: float, **секунды**
- Допустимые значения: `choices` нет; отдельной проверки диапазона в `check_server_args` нет
- Значение по умолчанию: `0.002` (2 мс)
- Эффективное значение: совпадает с заданным; переписывания нет. При выключенном `--enable-dynamic-batch-tokenizer` значение никуда не попадает — объект батчера не создается
- Где объявлен: `ServerArgs.dynamic_batch_tokenizer_batch_timeout`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация `TokenizerManager` — передается в `AsyncDynamicbatchTokenizer(..., batch_wait_timeout_s=...)`

## Что меняет в движке

Значение становится полем `batch_wait_timeout_s` и участвует в двух местах цикла набора (`managers/async_dynamic_batch_tokenizer.py`):

```python
if self._queue.empty():
    pass                                  # очередь пуста — обрабатываем сразу
else:
    start_time = loop.time()
    while len(prompts) < self.max_batch_size:
        elapsed = loop.time() - start_time
        if elapsed >= self.batch_wait_timeout_s:
            break
        remaining_time = self.batch_wait_timeout_s - elapsed
        try:
            ... = await asyncio.wait_for(self._queue.get(), remaining_time)
        except asyncio.TimeoutError:
            break
```

Окно измеряется от момента, когда стало известно, что очередь непуста, и делится на все последующие ожидания — то есть суммарное ожидание никогда не превышает заданного значения, сколько бы элементов ни пришло.

Собранный набор уходит в `_process_dynamic_batch`, где батч сохраняется одним вызовом токенизатора только при однородных kwargs; иначе элементы обрабатываются подряд в том же потоке исполнителя.

## Значения и формат

- Число с плавающей точкой в **секундах**, не в миллисекундах. `--dynamic-batch-tokenizer-batch-timeout 2` означает две секунды ожидания, а не две миллисекунды — это самая вероятная ошибка в этом аргументе.
- `0` или отрицательное значение: первое же сравнение `elapsed >= batch_wait_timeout_s` окажется истинным, добор не выполнится, и батчинг фактически выключится. Ошибки при этом не будет.
- Осмысленный диапазон для чат-нагрузки — от `0.001` до `0.01`. Больше `0.02` заметно на времени до первого токена.
- Значение сравнивается с показаниями `loop.time()` цикла событий, то есть с монотонными часами; точность ограничена гранулярностью планировщика asyncio, и очень малые значения (микросекунды) не дадут предсказуемого поведения.

## Когда использовать

- Увеличивать до `0.005`–`0.01`, если измерения показывают, что батчи стабильно малы (DEBUG-строка `AsyncDynamicbatchTokenizer: Processing dynamic batch of size N`), а токенизация действительно узкое место.
- Уменьшать до `0.001`, если критично время до первого токена и вы готовы получить меньшие батчи.
- Не трогать, если `--enable-dynamic-batch-tokenizer` не включен: значение будет принято и не применится.
- Не выставлять заметные величины (десятые доли секунды) в интерактивной нагрузке: 100 мс — это столько же, сколько занимает вся генерация нескольких токенов.

## Влияние на производительность и память

- **Latency — единственная прямая статья.** Добавка ограничена сверху значением аргумента и начисляется только при непустой очереди. При однопоточной нагрузке добавка равна нулю.
- **CPU:** косвенно. Больше окно — больше средний батч — меньше вызовов токенизатора на запрос.
- **RAM:** косвенно. Больше окно — больше текстов и future одновременно в памяти.
- **VRAM и время старта:** не затрагиваются.
- Взаимодействие с общей задержкой конвейера: окно токенизации складывается со временем ожидания в очереди планировщика и с шагом выдачи `--stream-interval`. Оптимизировать имеет смысл ту составляющую, которая доминирует.

## Взаимодействие с другими аргументами

- `--enable-dynamic-batch-tokenizer`: обязательное условие применения.
- `--dynamic-batch-tokenizer-batch-size`: вторая граница набора; из двух почти всегда срабатывает таймаут, поэтому размер поднимают только после увеличения окна.
- `--enable-tokenizer-batch-encode`: взаимоисключающий с самим механизмом.
- `--tokenizer-worker-num`: делит поток запросов, из-за чего очередь в каждом воркере короче и одно и то же окно собирает меньший батч.
- `--max-running-requests`: ограничивает, сколько запросов вообще может стоять в очереди.

## Типовые проблемы и диагностика

- **Симптом:** время до первого токена выросло на секунды. **Причина:** значение задано в миллисекундах по ошибке (`2` вместо `0.002`). **Проверка:** `dynamic_batch_tokenizer_batch_timeout=2.0` в дампе `server_args=`.
- **Симптом:** батчи всегда размера 1. **Причины:** очередь пуста (низкая конкурентность); значение `0` или отрицательное; слишком много tokenizer-воркеров. **Проверка:** DEBUG-строки `Processing dynamic batch of size N`.
- **Симптом:** батчи стабильно упираются в предел размера. **Причина:** окно щедрое, а размер мал. **Лечение:** поднять `--dynamic-batch-tokenizer-batch-size`.
- **Симптом:** окно увеличили, а выигрыша нет; в логе предупреждение про `differing kwargs`. **Причина:** смешанная нагрузка из обычных и cross-encoder-запросов — батч распадается на последовательные вызовы, и ожидание оказывается потраченным впустую.
- **Подтверждение значения:** `dynamic_batch_tokenizer_batch_timeout=...` в дампе `server_args=` при старте.

## В arriero

Как и остальные параметры динамического батчера, аргумент применим только вместе с `--enable-dynamic-batch-tokenizer`, а тот не оправдан для инстанса kind `ktransformers`: конкурентность выводится менеджером из `--max-running-requests` (`concurrency: "sglang-max-running-requests"` в дескрипторе движка), конкурирующие запросы становятся в очередь координатора домена, а не приходят во движок всплеском (`docs/RESOURCE_MANAGEMENT.md`). Очередь токенизации в такой схеме почти всегда пуста, и окно ожидания не открывается.

Если вы все же экспериментируете с батчером на этом профиле, помните, что добавленная задержка попадет в общее время запроса, видимое в трассировках прокси (`#/proxy/traces`), и будет выглядеть как медленный upstream, а не как задержка токенизации: отдельной метрики на этот этап у SGLang нет.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --host 127.0.0.1 --port 30000 --enable-dynamic-batch-tokenizer --dynamic-batch-tokenizer-batch-timeout 0.002
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --host 127.0.0.1 --port 30000 --enable-dynamic-batch-tokenizer --dynamic-batch-tokenizer-batch-timeout 0.01 --dynamic-batch-tokenizer-batch-size 128
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/async_dynamic_batch_tokenizer.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`, `docs/API_PROXY_FOUNDATION.md`, `packages/core/src/engine-descriptor.ts`
