---
schema: 1
engine: sglang
primaryName: "--enable-dynamic-batch-tokenizer"
title: "--enable-dynamic-batch-tokenizer"
summary: Собирает одиночные текстовые промпты от разных одновременных запросов в общий батч токенизации через очередь с окном ожидания. Помогает при высокой частоте коротких запросов и добавляет до пары миллисекунд задержки, когда очередь непуста.
group: serving
related:
  - --dynamic-batch-tokenizer-batch-size
  - --dynamic-batch-tokenizer-batch-timeout
  - --enable-tokenizer-batch-encode
  - --skip-tokenizer-init
  - --tokenizer-worker-num
  - --tokenizer-mode
  - --tokenizer-backend
---

# --enable-dynamic-batch-tokenizer

## Кратко

Флаг создает в `TokenizerManager` объект `AsyncDynamicbatchTokenizer` — асинхронную очередь, в которую складываются запросы на токенизацию **одиночной строки**, приходящие от разных клиентов. Фоновый цикл забирает первый элемент, добирает соседей до `--dynamic-batch-tokenizer-batch-size` или до истечения `--dynamic-batch-tokenizer-batch-timeout`, и токенизирует их одним вызовом в отдельном потоке.

Ключевое отличие от `--enable-tokenizer-batch-encode`: тот батчит входы **внутри одного запроса**, этот — **между разными запросами**. Включить оба сразу нельзя, `__post_init__` бросает `ValueError`.

Важно, что задержка не начисляется впустую: если очередь пуста в момент забора элемента, он обрабатывается немедленно, без ожидания окна.

## Оригинальная справка

```text
Enable async dynamic batch tokenizer for improved performance when multiple requests arrive concurrently.
```

## Паспорт аргумента

- Флаги: `--enable-dynamic-batch-tokenizer`
- Группа: `serving`
- Тип значения: bool; поле объявлено как `bool`, argparse получает `action="store_true"`, парного `--no-*` нет
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False`
- Эффективное значение: **принудительно `False`** при `--skip-tokenizer-init` (предупреждение `skip_tokenizer_init=True ignores --enable-dynamic-batch-tokenizer; disabling it.`). Кроме того, объект не создается, если `skip_tokenizer_init` истинно, даже минуя этот сброс: условие в `TokenizerManager` — `enable_dynamic_batch_tokenizer and not skip_tokenizer_init`
- Где объявлен: `ServerArgs.enable_dynamic_batch_tokenizer`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_tokenizer_batching`) → инициализация `TokenizerManager` в каждом HTTP-процессе → обработка каждого запроса в `_tokenize_texts`

## Что меняет в движке

### Где включается путь

`_tokenize_texts` (`managers/tokenizer_manager.py`) выбирает батчер только при выполнении двух условий:

```python
use_async_tokenizer = (
    self.async_dynamic_batch_tokenizer is not None
    and input_format == InputFormat.SINGLE_STRING
)
```

То есть батчер работает исключительно для формата «одна строка на запрос» — самого распространенного в чат-нагрузке. Список текстов, готовые `input_ids` и мультимодальные входы идут обычным путем.

### Как устроен батчер

`AsyncDynamicbatchTokenizer` (`managers/async_dynamic_batch_tokenizer.py`):

- одна `asyncio.Queue` на все запросы, создается лениво при первом обращении, потому что объект конструируется до старта цикла событий;
- один фоновый таск `_dynamic_batch_loop`;
- один `ThreadPoolExecutor(max_workers=1)` — блокирующие вызовы токенизатора уходят туда, чтобы не блокировать цикл событий.

Цикл работает так: берется первый элемент; если очередь пуста — он обрабатывается сразу; иначе запускается окно ожидания, в течение которого добираются элементы, пока не набрано `max_batch_size` или не истекло `batch_wait_timeout_s`.

### Условие настоящего батчинга

`_process_dynamic_batch` сначала проверяет, что у всех собранных запросов **одинаковые kwargs**:

```python
can_batch = all(kw == first_kw for kw in kwargs_list[1:])
```

Единственный kwarg, который сюда попадает, — `return_token_type_ids` для cross-encoder-запросов. Если набор неоднородный, батч распадается на последовательные вызовы в том же потоке, а в лог идет предупреждение `Dynamic batching disabled for batch of N requests due to differing kwargs. This reduces performance benefits.` То есть смешанная нагрузка «обычные эмбеддинги + cross-encoder» получит ожидание окна без выигрыша от батча.

### Обработка ошибок

Исключение внутри цикла логируется как `Error in dynamic batch loop: <e>` и цикл продолжается; исключение при обработке батча проставляется всем ожидающим future через `set_exception`. То есть отказ токенизации одного запроса в батче отражается на всех его соседях.

## Значения и формат

- Флаг без значения; параметры окна задаются двумя соседними аргументами.
- Взаимно исключающий с `--enable-tokenizer-batch-encode` — `ValueError: Cannot enable both --enable-tokenizer-batch-encode and --enable-dynamic-batch-tokenizer. Please choose one tokenizer batching approach.`
- При `--tokenizer-worker-num N` батчер создается **в каждом воркере** со своей очередью. Батчинг локален для воркера: с ростом N поток запросов делится, и средний размер батча падает. Два аргумента работают друг против друга.

## Когда использовать

- Высокая частота одиночных чат-запросов с короткими промптами, где токенизация видна в профиле CPU HTTP-процесса. Признак: процесс с токенизатором стабильно нагружен, GPU недогружен, а промпты короткие.
- Эмбеддинговый сервис, куда клиенты шлют по одной строке на запрос (для списков в одном запросе нужен `--enable-tokenizer-batch-encode`).
- **Не** включайте на нагрузке с длинными промптами: один длинный текст токенизируется достаточно долго, чтобы накладные расходы на вызов были незначимы, а окно ожидания добавится к времени до первого токена.
- **Не** включайте при низкой конкурентности: очередь почти всегда пуста, батчей не будет, останутся только лишний таск, поток и очередь.
- Не включайте одновременно с ростом `--tokenizer-worker-num`: чем больше воркеров, тем меньше батчи в каждом.

## Влияние на производительность и память

- **CPU:** выигрыш пропорционален тому, какую долю времени занимает фиксированная стоимость вызова токенизатора относительно самой токенизации. Для промптов в десятки токенов доля велика, для промптов в десятки тысяч — ничтожна.
- **Latency:** дополнительное ожидание не больше `--dynamic-batch-tokenizer-batch-timeout` (по умолчанию 0.002 с) и только когда очередь непуста. Плюс перенос вызова в поток исполнителя.
- **RAM:** одна очередь, один поток и один таск на процесс с токенизатором; собранные тексты живут в памяти на время окна. Величины малые.
- **VRAM:** не затрагивается.
- **Пропускная способность:** узкое место переносится с числа вызовов токенизатора на единственный поток исполнителя (`max_workers=1`). Если после включения этот поток насыщается, дальше поможет только `--tokenizer-worker-num`.

## Взаимодействие с другими аргументами

- `--dynamic-batch-tokenizer-batch-size`: верхняя граница набора.
- `--dynamic-batch-tokenizer-batch-timeout`: длительность окна.
- `--enable-tokenizer-batch-encode`: взаимоисключающие, ошибка на старте.
- `--skip-tokenizer-init`: принудительно выключает флаг.
- `--tokenizer-worker-num`: дробит поток запросов между воркерами и уменьшает эффективный размер батчей.
- `--tokenizer-mode slow` / `--tokenizer-backend`: батчер вызывает `self.tokenizer(...)` как есть — выигрыш от батча складывается с тем, насколько быстра сама реализация; с медленным токенизатором пакетный вызов преимущества не дает.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Cannot enable both --enable-tokenizer-batch-encode and --enable-dynamic-batch-tokenizer.` **Лечение:** выбрать один механизм.
- **Симптом:** в логе `AsyncDynamicbatchTokenizer: Dynamic batching disabled for batch of N requests due to differing kwargs.` **Причина:** в окно попали и обычные, и cross-encoder-запросы. **Лечение:** разнести такие нагрузки по разным серверам либо отказаться от батчера.
- **Симптом:** выросло время до первого токена, выигрыша нет. **Причины:** длинные промпты; низкая конкурентность; слишком много tokenizer-воркеров. **Лечение:** снять флаг либо уменьшить `--dynamic-batch-tokenizer-batch-timeout`.
- **Симптом:** флаг задан, а батчер не работает. **Причины:** клиенты шлют списки, а не одиночные строки (формат не `SINGLE_STRING`); либо включен `--skip-tokenizer-init`. **Проверка:** уровень логирования DEBUG показывает строки `Using async dynamic batch tokenizer for single text` и `AsyncDynamicbatchTokenizer: Processing dynamic batch of size N`.
- **Симптом:** ошибка токенизации одного запроса вернулась нескольким клиентам. **Причина:** исключение батча проставляется всем future в наборе. **Замечание:** это заложенное поведение, а не дефект конфигурации.

## В arriero

Профиль KTransformers (`docs/KTRANSFORMERS_OPERATIONS.md`) квалифицирован на конкурентности 2 — при такой нагрузке очередь батчера почти всегда пуста, батчи не собираются, и флаг превращается в лишний поток и лишнюю очередь на каждый HTTP-процесс.

Есть и вторая причина не включать его именно в arriero: конкурентность инстанса ограничивается снаружи. Дескриптор движка объявляет `concurrency: "sglang-max-running-requests"` (`packages/core/src/engine-descriptor.ts`), то есть менеджер выводит допустимую параллельность из `--max-running-requests`, а конкурирующие запросы **выстраиваются в очередь** координатора домена, а не отбрасываются (`docs/RESOURCE_MANAGEMENT.md`). Поток запросов до движка уже сглажен, и всплесков, ради которых существует динамический батчер, движок просто не видит.

Ключ не зарезервирован за конфигурацией движка; схема его примет.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --host 127.0.0.1 --port 30000 --enable-dynamic-batch-tokenizer
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --host 127.0.0.1 --port 30000 --enable-dynamic-batch-tokenizer --dynamic-batch-tokenizer-batch-size 64 --dynamic-batch-tokenizer-batch-timeout 0.005
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/async_dynamic_batch_tokenizer.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`, `packages/core/src/engine-descriptor.ts`
