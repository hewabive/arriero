---
schema: 1
engine: sglang
primaryName: "--tokenizer-mode"
title: "--tokenizer-mode"
summary: Выбор между быстрым (Rust) и медленным (Python) токенизатором. Значение slow нужно только как обходной путь для сломанного fast-токенизатора и обходится очень дорого на длинных промптах.
group: serving
related:
  - --tokenizer-path
  - --tokenizer-backend
  - --skip-tokenizer-init
  - --trust-remote-code
  - --image-processor-backend
  - --enable-dynamic-batch-tokenizer
  - --enable-tokenizer-batch-encode
---

# --tokenizer-mode

## Кратко

`--tokenizer-mode` определяет, какую реализацию токенизатора попросит `transformers`: `auto` — быструю (`use_fast=True`, реализация на Rust), `slow` — эталонную питоновскую (`use_fast=False`).

Практически это аварийный переключатель: fast-токенизатор быстрее на порядок, и переключаться на slow имеет смысл только тогда, когда fast-вариант конкретной модели дает неправильную токенизацию. Обратите внимание на комментарий в коде: в `transformers` v5 `AutoTokenizer` игнорирует `use_fast` и всегда возвращает быструю реализацию, поэтому на новых версиях библиотеки `slow` может оказаться бездействующим — проверять надо на своей сборке.

## Оригинальная справка

```text
Tokenizer mode. 'auto' will use the fast tokenizer if available, and 'slow' will always use the slow tokenizer.
```

## Паспорт аргумента

- Флаги: `--tokenizer-mode`
- Группа: `serving`
- Тип значения: str
- Допустимые значения: `auto`, `slow` (список закрыт `choices`, argparse отвергнет любое другое значение)
- Значение по умолчанию: `auto`
- Эффективное значение: совпадает с заданным; `__post_init__` его не трогает. Но фактическая реализация может отличаться от запрошенной: для мультимодальных моделей `get_processor_wrapper` перехватывает `ValueError` с текстом «does not have a slow version», логирует `Processor <путь> does not have a slow version. Automatically use fast version` и повторяет загрузку с `use_fast=True`
- Где объявлен: `ServerArgs.tokenizer_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация процессов — `TokenizerManager`, `DetokenizerManager`, `Scheduler`, `TpWorker` и мультимодальный процессор, каждый вызывает `get_tokenizer(...)` со своим экземпляром

## Что меняет в движке

Вся логика — в `get_tokenizer` (`sglang/python/sglang/srt/utils/hf_transformers/tokenizer.py`):

```python
if tokenizer_mode == "slow":
    if kwargs.get("use_fast", False):
        raise ValueError("Cannot use the fast tokenizer in slow tokenizer mode.")
    kwargs["use_fast"] = False
elif tokenizer_mode == "auto":
    if "use_fast" not in kwargs:
        kwargs["use_fast"] = True
```

Дальше значение уходит в `AutoTokenizer.from_pretrained`. Две ветки обходят этот выбор целиком:

- путь, оканчивающийся на `.json`, загружается как `TiktokenTokenizer` — `tokenizer_mode` не применяется;
- «голый» tekken-чекпойнт (есть `tekken.json`, нет `tokenizer.json`) загружается через `MistralCommonTokenizer`, и в логе явно пишется, что `tokenizer_backend` игнорируется.

Значение читают все процессы, которым нужен токенизатор, а также `get_processor` для мультимодальных моделей.

## Значения и формат

- `auto` — быстрый токенизатор, если он есть; иначе `transformers` сам вернет медленный.
- `slow` — принудительно медленный. Если у модели нет медленной реализации, `transformers` выбросит ошибку; для процессоров SGLang это перехватывает и откатывается на fast, для чистого токенизатора — нет.
- Других значений argparse не примет: `choices=["auto", "slow"]`.
- Флаг **не** влияет на выбор реализации image processor'а — за это отвечает отдельный `--image-processor-backend`.

## Когда использовать

- `slow` — когда доказано, что fast-токенизатор конкретной модели токенизирует иначе, чем эталон. Признак: расхождение `tokenizer.encode(text)` между `use_fast=True` и `use_fast=False` на характерных строках (спецтокены, эмодзи, смешанные алфавиты).
- `slow` — при отладке проблем с чат-шаблоном и спецтокенами, когда нужно исключить fast-реализацию из подозреваемых.
- Во всех остальных случаях `auto`. Медленный токенизатор — это чистый Python-цикл, и на длинных промптах он превращается в заметную долю времени prefill.
- Не используйте `slow` как «более безопасный» вариант по умолчанию: цена высокая, а выигрыша в типичном случае нет.

## Влияние на производительность и память

- **CPU и latency prefill.** Fast-токенизатор — нативный код с параллельной обработкой батча; slow — интерпретируемый Python. На промпте в десятки тысяч токенов разница измеряется десятками и сотнями миллисекунд на запрос, и она целиком ложится на время до первого токена.
- **Батчевые оптимизации теряют смысл.** `_tokenize_texts` (`managers/tokenizer_manager.py`) явно ветвится: если токенизатор не помечен как `is_fast`, батч разбирается построчно циклом `[self.tokenizer.encode(t) for t in tokenizer_input]` вместо одного батчевого вызова. То есть с `slow` и `--enable-tokenizer-batch-encode` вы получите батч без батчевой токенизации.
- **RAM:** slow-реализация обычно легче по памяти, но разница не того порядка, чтобы на нее ориентироваться.
- **VRAM и время старта:** не затрагиваются заметно.

## Взаимодействие с другими аргументами

- `--tokenizer-path`: путь, к которому применяется режим.
- `--tokenizer-backend`: ортогональный выбор библиотеки; `fastokens` патчит `transformers` и по смыслу противоположен `slow`.
- `--skip-tokenizer-init`: токенизатор не загружается, режим не применяется.
- `--enable-tokenizer-batch-encode` и `--enable-dynamic-batch-tokenizer`: обе оптимизации рассчитаны на батчевый вызов быстрого токенизатора; со `slow` выигрыш пропадает (см. выше).
- `--image-processor-backend`: отдельный выбор image processor'а, с `--tokenizer-mode` не связан. Legacy `--disable-fast-image-processor` deprecated.
- `--trust-remote-code`: нужен, если токенизатор модели реализован собственным кодом.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Cannot use the fast tokenizer in slow tokenizer mode.` **Причина:** внутренний конфликт — `use_fast=True` пришел в kwargs при `tokenizer_mode="slow"`. **Лечение:** снять `slow`.
- **Симптом:** в логе `Processor <путь> does not have a slow version. Automatically use fast version`. **Причина:** мультимодальная модель без slow-процессора. **Последствие:** запрошенный режим фактически не применен к процессору. Это информационное сообщение.
- **Симптом:** заметно выросло время до первого токена после включения `slow`. **Причина:** ожидаемая цена режима. **Проверка:** сравнить время prefill на одном и том же промпте в `auto` и `slow`.
- **Симптом:** `slow` задан, а поведение не изменилось. **Причина:** возможен вариант с `transformers` v5, где `AutoTokenizer` игнорирует `use_fast`; либо путь ведет на `.json` (tiktoken) или на bare-tekken-чекпойнт. **Проверка:** `<env>/bin/python -c "from transformers import AutoTokenizer as A; t=A.from_pretrained('<путь>', use_fast=False); print(type(t), t.is_fast)"`.
- **Подтверждение принятого значения:** строка `server_args=` в логе старта.

## В arriero

Дефолт `auto` — правильный выбор для квалифицированного профиля (`docs/KTRANSFORMERS_OPERATIONS.md`), где узкое место — CPU-эксперты KTransformers и пропускная способность памяти, а не токенизация.

Есть отдельная причина не трогать этот аргумент в arriero: хост KT-профиля уже загружен CPU-инференсом экспертов (`--kt-cpuinfer` потоков), а медленный токенизатор добавит питоновскую работу ровно в тот же процессорный бюджет. Хостовой резерв под это в `config/resources.json` не заложен (`docs/RESOURCE_MANAGEMENT.md` описывает память, а не CPU-время), поэтому эффект проявится как рост latency под конкурентной нагрузкой без единого сигнала в учете ресурсов.

Ключ не зарезервирован за конфигурацией движка и может быть задан в сырых `args`, если понадобится диагностика.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tokenizer-mode auto --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tokenizer-mode slow --host 127.0.0.1 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/hf_transformers/tokenizer.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`
