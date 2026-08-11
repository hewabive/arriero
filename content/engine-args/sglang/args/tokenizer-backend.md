---
schema: 1
engine: sglang
primaryName: "--tokenizer-backend"
title: "--tokenizer-backend"
summary: Выбор библиотеки токенизации: штатная transformers или fastokens, который глобально патчит transformers ради скорости. Требует отдельно установленного пакета и поддерживается не всеми моделями.
group: serving
related:
  - --tokenizer-mode
  - --tokenizer-path
  - --skip-tokenizer-init
  - --enable-dynamic-batch-tokenizer
  - --enable-tokenizer-batch-encode
  - --tokenizer-worker-num
  - --trust-remote-code
---

# --tokenizer-backend

## Кратко

`--tokenizer-backend` выбирает, чья реализация будет токенизировать: штатная `transformers`/`tokenizers` (`huggingface`) или сторонний пакет `fastokens` (`fastokens`).

Механика второго варианта важна: это не отдельный объект токенизатора, а **глобальный monkey-patch** библиотеки `transformers`, выполняемый один раз при первой загрузке (`fastokens.patch_transformers()`). Пакет не входит в базовую установку SGLang и требует `pip install 'sglang[fastokens]'`, а поддерживает не каждый токенизатор — при сбое загрузки SGLang выдает отдельное сообщение со ссылкой на апстрим-репозиторий и советом вернуться на дефолт.

## Оригинальная справка

```text
Tokenizer backend. 'huggingface' uses the default HuggingFace tokenizers library, and 'fastokens' uses the fastokens library for faster tokenization. Requires the fastokens package to be installed.
```

## Паспорт аргумента

- Флаги: `--tokenizer-backend`
- Группа: `serving`
- Тип значения: str
- Допустимые значения: `huggingface`, `fastokens` (закрытый список `choices`)
- Значение по умолчанию: `huggingface`
- Эффективное значение: совпадает с заданным; `__post_init__` его не трогает. Фактически игнорируется в двух случаях загрузки: путь на `.json` (tiktoken-формат) и «голый» tekken-чекпойнт — во втором случае в лог пишется явное `... ignoring tokenizer_backend=<значение>`
- Где объявлен: `ServerArgs.tokenizer_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация каждого процесса, которому нужен токенизатор (tokenizer manager, detokenizer, scheduler, tp-worker, мультимодальный процессор)

## Что меняет в движке

Вся логика — в `get_tokenizer` и `_ensure_fastokens_patched` (`sglang/python/sglang/srt/utils/hf_transformers/tokenizer.py`).

1. Если путь оканчивается на `.json`, возвращается `TiktokenTokenizer` — до выбора backend'а дело не доходит.
2. При `tokenizer_backend == "fastokens"` вызывается `_ensure_fastokens_patched()`: импортируется `fastokens`, вызывается `fastokens.patch_transformers()`, в лог пишется `fastokens backend enabled - transformers patched successfully`. Патч ставится **один раз на процесс** (глобальный флаг `_fastokens_patched`), то есть действует на всё, что этот процесс загрузит дальше.
3. Отсутствие пакета дает `ImportError: The fastokens package is required when --tokenizer-backend=fastokens. Install it with: pip install 'sglang[fastokens]'`.
4. После патча `AutoTokenizer.from_pretrained` возвращает объект, чей backend — shim `fastokens`. SGLang специально не переразрешает класс токенизатора в этом случае: обычная ветка для `huggingface` может пере-загрузить токенизатор через объявленный класс модели (например, `Qwen2Tokenizer`), а с `fastokens` это отбросило бы результат патча.
5. Любое исключение при загрузке в режиме `fastokens` заворачивается в

```text
fastokens failed to load tokenizer for '<путь>'. This model's tokenizer may not be supported by fastokens — see https://github.com/crusoecloud/fastokens. Re-run without --tokenizer-backend=fastokens to use the default backend.
```

## Значения и формат

- `huggingface` — дефолт, никаких дополнительных зависимостей.
- `fastokens` — требует установленного пакета в том же окружении, где запускается сервер.
- Другие значения argparse не примет.
- Проверка наличия пакета выполняется **лениво**, при первой загрузке токенизатора, а не при разборе аргументов: ошибка появится уже во время инициализации процессов, а не мгновенно.

Как посмотреть, доступен ли backend на вашей сборке:

```bash
<env>/bin/python -c "import fastokens; print(fastokens.__version__)"
```

## Когда использовать

- Высокая частота коротких запросов, где токенизация видна в профиле CPU HTTP-процесса. Именно там `fastokens` окупается.
- Не включайте без измерения. Для типичной генеративной нагрузки (сотни выходных токенов на запрос) доля токенизации в общем времени мала, а вы получаете глобальный патч `transformers` и еще одну зависимость, которую придется тянуть через квалификацию окружения.
- Не включайте вместе с `--tokenizer-mode slow`: это взаимно противоположные намерения — один аргумент требует медленную питоновскую реализацию, другой ускоряет быструю. Явного запрета в коде нет, поведение определяется тем, что вернет пропатченный `transformers`; проверяйте `tokenizer.is_fast` на своей сборке.
- Не используйте на моделях с нестандартным токенизатором (tekken, tiktoken-`.json`, собственный код через `--trust-remote-code`): в первых двух случаях backend игнорируется, в третьем совместимость не гарантирована.

## Влияние на производительность и память

- **CPU:** выигрыш ожидается на этапе `encode`; величина зависит от токенизатора и длины входа и в исходниках SGLang никак не заявлена. Измеряйте на своей нагрузке.
- **RAM:** дополнительный пакет и его структуры в каждом процессе, где загружается токенизатор. При `--tokenizer-worker-num N` это N копий.
- **VRAM:** не затрагивается.
- **Время старта:** плюс импорт и патч; величина незначительна.
- **Риск:** патч глобальный. Если в том же процессе используется `transformers` для чего-то еще, поведение меняется и для этого «чего-то еще».

## Взаимодействие с другими аргументами

- `--tokenizer-mode`: ортогональный выбор (fast/slow реализация внутри `transformers`) против выбора библиотеки. Комбинация `slow` + `fastokens` бессмысленна.
- `--tokenizer-path`: если он ведет на `.json` или bare-tekken-чекпойнт, backend не применяется.
- `--skip-tokenizer-init`: токенизатор не загружается, аргумент бездействует.
- `--enable-dynamic-batch-tokenizer` / `--enable-tokenizer-batch-encode`: обе оптимизации вызывают `self.tokenizer(...)`, то есть работают поверх выбранного backend'а; выигрыши складываются, но независимо.
- `--tokenizer-worker-num`: определяет, сколько раз патч будет применен (по разу на процесс).
- `--trust-remote-code`: модель с собственным классом токенизатора — зона повышенного риска для `fastokens`.

## Типовые проблемы и диагностика

- **Симптом:** `ImportError: The fastokens package is required when --tokenizer-backend=fastokens.` **Причина:** пакета нет в окружении. **Лечение:** установить или вернуть `huggingface`.
- **Симптом:** `RuntimeError: fastokens failed to load tokenizer for '<путь>' …`. **Причина:** токенизатор модели не поддерживается. **Лечение:** вернуть дефолт; сообщение прямо это и советует.
- **Симптом:** backend задан, а в логе нет строки `fastokens backend enabled - transformers patched successfully`. **Причина:** загрузка ушла в tiktoken- или tekken-ветку. **Проверка:** искать в логе `Detected bare-tekken checkpoint`.
- **Симптом:** различия в токенизации между `huggingface` и `fastokens` на одних и тех же строках. **Проверка:** сравнить `tokenizer.encode(...)` на характерных текстах в двух окружениях. Расхождение — повод откатиться, а не «настроить».
- **Подтверждение значения:** `tokenizer_backend='...'` в дампе `server_args=`.

## В arriero

Аргумент требует пакета, которого в квалифицированном окружении нет. Окружения движка неизменяемы (`docs/ENVIRONMENTS.md`): состав пакетов фиксируется на этапе установки, а профиль KT закреплен парой `sglang-kt` + `kt-kernel` с записанными хешами артефактов (`docs/KTRANSFORMERS_OPERATIONS.md`). Добавить `fastokens` в существующее окружение нельзя — нужно пересобрать окружение и заново пройти квалификационный прогон.

Проверить доступность в конкретном окружении:

```bash
<environment-bin>/python -c "import fastokens; print(fastokens.__version__)"
```

Если импорт не проходит, `--tokenizer-backend fastokens` уронит инстанс на инициализации токенизатора — то есть после запуска процесса, но до открытия HTTP-порта. В логе инстанса это будет виден как `ImportError` в трассировке, а preflight такую ошибку не поймает: он проверяет каталог аргументов установленного движка (`sglang-help`), а наличие сторонних пакетов — нет.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tokenizer-backend huggingface --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tokenizer-backend fastokens --host 127.0.0.1 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/hf_transformers/tokenizer.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- arriero: `docs/ENVIRONMENTS.md`, `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/CASE_PHANTOM_HELP_ARGS.md`
