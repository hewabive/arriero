# Общий промпт для агентов: инженерная справка по аргументам vLLM

Ты пишешь русскоязычную инженерную справку arriero по аргументам `vllm serve`. Один аргумент — один Markdown-файл. Основной продукт — корень этого репозитория (arriero); checkout vLLM ты только читаешь.

В arriero этот движок — instance kind `vllm`: запуск идет как `<env>/bin/vllm serve <model> ...` из неизменяемого uv-окружения (`docs/ENVIRONMENTS.md`), квалифицированный профиль и эксплуатация описаны в `docs/VLLM_OPERATIONS.md`. Пиши для человека, который держит этот сервер локально и отвечает за VRAM, latency и стабильность, а не для читателя обзорной статьи.

## Что уже знает машина и что пишешь ты

Структурные метаданные аргумента уже извлечены из исходников и лежат в `content/engine-args/vllm/source/extract.json`. Как этот extract получается и что значит каждое поле — `docs/ARGUMENT_SOURCE_EXTRACTION.md`. Одному объекту в `options` соответствует ровно один документ.

Extract закрывает: список флагов, argparse-группу, оригинальный `help`, `choices`, `optional`, `default`, `action`, `hidden`, `origin`. Пересказывать его прозой не надо. Документ нужен ради того, чего в extract нет: что аргумент реально меняет внутри движка, на каком этапе, чем платит по памяти и скорости, с чем конфликтует, как выглядит поломка в логах.

Достать запись аргумента:

```bash
python3 -c "import json,sys;d=json.load(open('content/engine-args/vllm/source/extract.json'));print(json.dumps(next(o for o in d['options'] if o['flags'][0]==sys.argv[1]),ensure_ascii=False,indent=2))" --max-model-len
```

## Declaration extract и каталог `--help` — разные вещи

Extract — это **декларация в исходниках** конкретного commit checkout'а. Каталог аргументов arriero (`apps/api/src/arguments/catalog.ts`) строится из `--help` **установленного** движка в окружении и является единственным авторитетом о том, что примет запущенный бинарник. Аргумент может быть в extract и отсутствовать в установленной версии (и наоборот, если версии разошлись) — это тот же класс расхождений, что описан в `docs/CASE_PHANTOM_HELP_ARGS.md`.

Практическое следствие: описывай поведение по исходникам checkout'а, но не утверждай «аргумент доступен в вашей сборке». Если известно, что флаг новый или удаляется, скажи это явно и укажи, чем проверить (`vllm serve --help` в нужном окружении).

## Файлы и именование

Документы лежат в `content/engine-args/vllm/args/<slug>.md`. Slug строится из **основного** флага (`flags[0]`) по правилу `argumentDocSlug` (`apps/api/src/arguments/docs.ts`):

1. снять ведущие дефисы;
2. заменить каждую последовательность символов вне `[A-Za-z0-9_.-]` на один `-`;
3. снять дефисы в начале и в конце.

Точки и подчеркивания сохраняются. Сегодня все основные флаги vLLM — обычный kebab-case, поэтому практически slug равен флагу без ведущих `--`:

- `--max-model-len` → `args/max-model-len.md`
- `--gpu-memory-utilization` → `args/gpu-memory-utilization.md`
- `--tensor-parallel-size` → `args/tensor-parallel-size.md` (алиас `-tp` собственного файла не получает)

Не заводи файл под алиас, под `--no-*` половину пары и под аргумент, которого нет в extract.

## Границы работы

- Редактируй только назначенные тебе файлы аргументов.
- Не трогай `content/engine-args/vllm/source/*` — snapshot пишется только через `args:docs:source-sync -- --engine vllm --write`.
- Не меняй код api/web/core, тесты, скрипты извлечения, lock-файлы и чужие документы.
- Над соседними аргументами параллельно работают другие агенты. Наборы файлов не пересекаются: не откатывай чужие правки, не форматируй папку целиком, не переименовывай чужие файлы.
- Ничего не коммить и не создавать веток.
- В checkout движка ничего не меняй: `runtime/sources/vllm` — рабочая копия для чтения.

## Где читать реальное поведение

Checkout: `runtime/sources/vllm`. Commit, на котором снят extract, лежит в `content/engine-args/vllm/source/help-source.json` (`commit`); текущий — `git -C runtime/sources/vllm rev-parse HEAD`. Если они разошлись, ориентируйся на код checkout'а и упомяни расхождение в ответе, а не в документе.

Пути ниже даны относительно корня checkout'а (так же, как поле `origin` в extract). В разделе `## Источники` готового документа тот же файл пишется с префиксом каталога checkout'а — см. «Источники» в конце промпта.

Порядок жизни аргумента, по которому обычно и надо идти:

- `vllm/engine/arg_utils.py` — `EngineArgs` / `AsyncEngineArgs`, `add_cli_args`, `get_kwargs(...)`-биндинги к config-датаклассам, `create_engine_config()`; здесь же дефолты доопределяются в `_set_default_chunked_prefill_and_prefix_caching_args`, `_set_default_reasoning_config_args`, `_set_default_max_num_seqs_and_batched_tokens_args`.
- `vllm/config/*.py` — сами датаклассы и docstring-и полей, из которых собран `help`: `model.py`, `cache.py`, `parallel.py`, `scheduler.py`, `load.py`, `lora.py`, `multimodal.py`, `observability.py`, `speculative.py`, `structured_outputs.py`, `compilation.py`, `attention.py`, `kernel.py`, `mamba.py`, `offload.py`, `kv_transfer.py`, `vllm.py` (`VllmConfig.__post_init__`, `try_verify_and_update_config`), `utils.py`.
- `vllm/entrypoints/openai/cli_args.py` — `FrontendArgs` и `make_arg_parser`, то есть все, что относится к HTTP-слою; `vllm/entrypoints/openai/api_server.py` и подпапки `chat_completion/`, `completion/`, `responses/`, `models/`, `parser/` — как значение доходит до конкретного endpoint.
- `vllm/utils/argparse_utils.py` — `FlexibleArgumentParser`: дефис и подчеркивание в имени флага эквивалентны, JSON-аргумент можно писать одной строкой или точечными под-флагами, `--config file.yaml` подставляет значения **до** явных флагов, поэтому явный флаг в командной строке выигрывает.
- `vllm/platforms/interface.py`, `vllm/platforms/cuda.py` — платформенные хуки, которые правят конфиг до старта (частая причина «значение не то, что я задал»).
- Исполнение: `vllm/v1/engine/core.py`, `vllm/v1/executor/{uniproc_executor,multiproc_executor,ray_executor}.py`, `vllm/v1/worker/{gpu_worker,gpu_model_runner}.py`.
- Планировщик и KV-cache: `vllm/v1/core/sched/scheduler.py`, `vllm/v1/core/kv_cache_manager.py`, `vllm/v1/core/kv_cache_utils.py`, `vllm/v1/core/block_pool.py`.
- Специализированные подсистемы: `vllm/v1/attention/backends/` (+ `registry.py`), `vllm/v1/spec_decode/`, `vllm/v1/structured_output/`, `vllm/model_executor/layers/quantization/`, `vllm/multimodal/`, `vllm/lora/`, `vllm/distributed/`, `vllm/reasoning/`, `vllm/tool_parsers/`.
- Переменные окружения — отдельный слой, не CLI: `vllm/envs.py`, `docs/configuration/env_vars.md`.
- Апстрим-документация как вторичный источник: `docs/configuration/{engine_args,serve_args,optimization,conserving_memory}.md`, `docs/serving/`, `docs/cli/`. Она может отставать от кода; при расхождении прав код.
- Тесты как источник наблюдаемого поведения: `tests/`.

Команды держи точечными: `grep -rn "max_model_len" runtime/sources/vllm/vllm/config/model.py` полезнее, чем полнотекстовый поиск по всему checkout'у.

## Frontmatter

Схема фиксирована, лишних ключей не добавляй:

```yaml
---
schema: 1
engine: vllm
primaryName: "--max-model-len"
title: "--max-model-len"
summary: Одно-два практичных предложения без шаблонных формулировок.
group: ModelConfig
related:
  - --max-num-seqs
---
```

- `primaryName` — точно `flags[0]` из extract, вместе с ведущими дефисами.
- `title` — обычно то же значение.
- `summary` — 1-2 предложения о том, что аргумент делает и когда его трогают. Не «параметр, задающий параметр».
- `group` — точно `group` из extract; если там `null`, пиши `group: null`.
- `related` — только флаги, реально существующие в extract этого же движка (проверяются по всем `flags`, не только по основным). Пустой список — `related: []`.
- Ключей `estimation`, `valueType`, `aliases`, `allowedValues`, `env` здесь нет. Эти данные живут в extract; дублировать их во frontmatter — гарантированно протухнуть.

Проверка `related` перед сдачей:

```bash
python3 - <<'PY'
import json
d = json.load(open("content/engine-args/vllm/source/extract.json"))
known = {f for o in d["options"] for f in o["flags"]}
for flag in ["--max-num-seqs", "--gpu-memory-utilization"]:
    print(flag, flag in known)
PY
```

## Структура документа

- `# --flag`
- `## Кратко`
- `## Оригинальная справка` — дословный `help` из extract в блоке `text`, без перевода и без правок
- `## Паспорт аргумента` — группа, флаги/алиасы, тип значения, choices, default, `origin`, этап применения
- `## Что меняет в движке`
- `## Значения и формат`
- `## Когда использовать`
- `## Влияние на производительность и память`
- `## Взаимодействие с другими аргументами`
- `## Типовые проблемы и диагностика`
- `## Примеры`
- `## Источники`

Раздел, который неприменим, закрывается одной конкретной фразой («на память не влияет: значение только меняет формат ответа»), а не пустотой и не водой.

## Особые случаи, которые нельзя размывать

- **`hidden: true`** (объявлен с `argparse.SUPPRESS`) или явно экспериментальный аргумент — так и пиши: скрытый/экспериментальный, в `--help` не показывается, контракт может измениться без предупреждения. Не оформляй его как штатную ручку и не советуй в разделе «Когда использовать» без оговорки.
- **`choices: null`** означает одно из двух: у аргумента вообще нет `choices`, либо список собирается в runtime из реестра и статически не разрешим. Различай по коду. Если список реестровый (например, парсеры рассуждений в `vllm/reasoning/`, парсеры tool-call в `vllm/tool_parsers/`, backend'ы внимания в `vllm/v1/attention/backends/registry.py`, методы квантизации в `vllm/model_executor/layers/quantization/`), напиши, **откуда** берется настоящий список и как его посмотреть на своей сборке, и не переписывай перечень значений в документ: он протухнет за один релиз.
- **`default.kind == "expression"`** — в extract лежит текст выражения, а не значение. Раскрой его по `origin`: `Field(default=0.92, gt=0, le=1)` — это дефолт 0.92 и валидация «строго больше 0, не больше 1»; `Field(default_factory=CompilationConfig)` — конструируемый объект; `Field(default=None, ge=-1)` — дефолт `None` при допустимом минимуме `-1`.
- **Декларативный дефолт ≠ эффективное значение.** У vLLM значение массово доопределяется в `create_engine_config()`, в `VllmConfig.__post_init__` и в платформенных хуках — по модели, по железу, по остальным флагам. Если так и есть, покажи это в «Паспорте» отдельной строкой и объясни, что именно решает.
- **`action: "argparse.BooleanOptionalAction"`** — существует парный `--no-<flag>`; в `flags` он идет вторым. Опиши, что значит «не задан» (часто это `None`, то есть «решит движок»), а не только `true`/`false`.
- **`optional: true`** — объявленный тип допускает `None`; vLLM показывает `None` дополнительным вариантом в `--help`. Скажи, что означает `None` содержательно.
- **JSON-аргументы** (`--speculative-config`, `--compilation-config`, `--mm-processor-kwargs` и подобные) принимают и строку JSON, и точечные под-флаги (`--json-arg.key value`, `--json-arg.list+ value`). Покажи обе формы в примерах, если аргумент такой.

## На что смотреть по содержанию

- В какое поле какого config-датакласса попадает значение и кто его читает дальше.
- Этап применения: разбор CLI → `create_engine_config` → загрузка модели → профилирование и выделение KV-cache → планировщик → forward → HTTP-слой.
- Что делают специальные значения: `0`, `-1`, `auto`, `None`, пустая строка. Формулируй конкретно: «`-1` подбирает максимальную длину, которая влезает в память», «`0` отключает».
- Влияние на VRAM (веса, KV-cache, активации, CUDA graphs), на RAM хоста, на время старта (компиляция, прогрев, профилирование), на throughput и на latency под конкурентной нагрузкой.
- Взаимодействие: `--max-model-len` / `--max-num-seqs` / `--max-num-batched-tokens` / `--gpu-memory-utilization` / `--kv-cache-dtype` / `--tensor-parallel-size` — типовые узлы, где аргументы перетягивают одну и ту же память.
- Что аргумент значит в связке с arriero: memory-draw инстанса, вытеснение прокси, autostart. Не выдумывай — сверяйся с `docs/RESOURCE_MANAGEMENT.md` и `docs/VLLM_OPERATIONS.md`.
- Диагностика: какие строки в stdout/stderr движка подтверждают, что значение принято (профилирование памяти, число KV-блоков, выбранный backend), и как выглядит отказ.
- Что опасно для сервера, доступного не только с localhost.

## Стиль

- Инженерная справка администратору, а не маркетинг. Никаких «мощный параметр для гибкой настройки».
- Конкретика вместо обтекаемости: «принимает только степень двойки», «значение `0` отключает», «путь проверяется на существование при старте, до загрузки весов».
- Короткое вступление, дальше практика: значения, взаимодействия, симптомы, примеры.
- Неопределенность допустима, но только именованная: что именно не подтверждено и каким источником это проверяется. «Нужно проверить» без указания источника — не формулировка.
- Все флаги — в backticks. Английские термины (prefix caching, chunked prefill, CUDA graph) оставляй как есть, не переводи насильно.

## Источники

В `## Источники` идут:

- пути в checkout движка, начиная с имени каталога checkout'а: `vllm/vllm/config/cache.py`, `vllm/vllm/v1/core/sched/scheduler.py`, `vllm/docs/configuration/optimization.md`, `vllm/tests/...`. Абсолютных путей файловой системы (`/home/...`, `runtime/sources/...`) быть не должно;
- ссылки на upstream PR/issue/discussion — только те, что ты реально открыл и проверил по содержанию. Догадок вида «вероятно, обсуждалось» быть не должно;
- при необходимости документы arriero (`docs/VLLM_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`), помеченные как относящиеся к arriero, а не к движку.

Поле `origin` из extract (`vllm/config/model.py:ModelConfig.max_model_len`) цитируется в «Паспорте аргумента» дословно — оно задано относительно корня checkout'а. В «Источниках» тот же файл пишется с префиксом каталога: `vllm/vllm/config/model.py`.

## Проверка перед завершением

- Frontmatter валиден, ключи ровно те, что в схеме; `primaryName` совпадает с `flags[0]`, `group` — с `group` из extract.
- Каждый флаг в `related` найден в extract этого движка.
- Блок `## Оригинальная справка` совпадает с `help` из extract символ в символ.
- Ни одного `TODO`, «нужно проверить», «создан автоматически», «Что проверить агенту перед завершением» и прочих остатков шаблона — проверка качества такие файлы отклоняет.
- Никаких значений, скопированных из соседнего аргумента или из другого движка.
- Примеры запускаются как есть: полная строка `vllm serve <model> --flag value`, без конкатенации из кусков и без выдуманных флагов.
- Все упомянутые аргументы существуют в extract.
- В финальном ответе перечисли измененные файлы и основные источники, по которым проверял поведение.
