# Общий промпт для агентов: инженерная справка по аргументам SGLang

Ты пишешь русскоязычную инженерную справку arriero по аргументам сервера SGLang (`python -m sglang.launch_server`). Один аргумент — один Markdown-файл. Основной продукт — корень этого репозитория (arriero); checkout SGLang ты только читаешь.

В arriero этот движок — instance kind `ktransformers` (SGLang-KT): запуск идет как `<env>/bin/python -m sglang.launch_server ...` из неизменяемого uv-окружения (`docs/ENVIRONMENTS.md`), квалифицированный профиль и эксплуатация — `docs/KTRANSFORMERS_OPERATIONS.md`, архитектурные контракты — `docs/ENGINE_ADAPTERS.md`. Пиши для человека, который держит этот сервер локально и отвечает за VRAM, RAM, latency и стабильность.

## Что уже знает машина и что пишешь ты

Структурные метаданные аргумента уже извлечены из исходников и лежат в `content/engine-args/sglang/source/extract.json`. Как этот extract получается и что значит каждое поле — `docs/ARGUMENT_SOURCE_EXTRACTION.md`. Одному объекту в `options` соответствует ровно один документ.

Extract закрывает: список флагов (включая алиасы и `--no-*` пары), группу, оригинальный `help`, `choices`, `optional`, `default`, `action`, `hidden`, `origin`. Пересказывать его прозой не надо. Документ нужен ради того, чего в extract нет: что аргумент реально меняет внутри движка, на каком этапе, чем платит по памяти и скорости, с чем конфликтует, как выглядит поломка в логах.

Достать запись аргумента:

```bash
python3 -c "import json,sys;d=json.load(open('content/engine-args/sglang/source/extract.json'));print(json.dumps(next(o for o in d['options'] if o['flags'][0]==sys.argv[1]),ensure_ascii=False,indent=2))" --mem-fraction-static
```

## Declaration extract и каталог `--help` — разные вещи

Extract — это **декларация в исходниках** конкретного commit checkout'а. Каталог аргументов arriero (`apps/api/src/arguments/catalog.ts`) строится из `--help` **установленного** движка в окружении и является единственным авторитетом о том, что примет запущенный процесс. Аргумент может быть в extract и отсутствовать в установленном пакете (и наоборот, если версии разошлись) — тот же класс расхождений, что описан в `docs/CASE_PHANTOM_HELP_ARGS.md`.

Для SGLang это особенно важно: arriero работает с закрепленной парой пакетов `sglang-kt` + `kt-kernel`, которая может отставать от upstream-checkout'а. Описывай поведение по исходникам checkout'а, но не утверждай «аргумент доступен в вашей сборке»; если флаг новый или помечен как deprecated, скажи это явно и укажи, чем проверить.

## Файлы и именование

Документы лежат в `content/engine-args/sglang/args/<slug>.md`. Slug строится из **основного** флага (`flags[0]`) по правилу `argumentDocSlug` (`apps/api/src/arguments/docs.ts`):

1. снять ведущие дефисы;
2. заменить каждую последовательность символов вне `[A-Za-z0-9_.-]` на один `-`;
3. снять дефисы в начале и в конце.

Точки и подчеркивания сохраняются. Сегодня все основные флаги SGLang — обычный kebab-case, поэтому практически slug равен флагу без ведущих `--`:

- `--mem-fraction-static` → `args/mem-fraction-static.md`
- `--attention-backend` → `args/attention-backend.md`
- `--tp-size` → `args/tp-size.md` (алиас `--tensor-parallel-size` собственного файла не получает)
- `--kt-num-gpu-experts` → `args/kt-num-gpu-experts.md`

Не заводи файл под алиас, под `--no-*` половину пары и под аргумент, которого нет в extract.

## Границы работы

- Редактируй только назначенные тебе файлы аргументов.
- Не трогай `content/engine-args/sglang/source/*` — snapshot пишется только через `args:docs:source-sync -- --engine sglang --write`.
- Не меняй код api/web/core, тесты, скрипты извлечения, lock-файлы и чужие документы.
- Над соседними аргументами параллельно работают другие агенты. Наборы файлов не пересекаются: не откатывай чужие правки, не форматируй папку целиком, не переименовывай чужие файлы.
- Ничего не коммить и не создавать веток.
- В checkout движка ничего не меняй: `runtime/sources/sglang` и `runtime/sources/ktransformers` — рабочие копии для чтения.

## Где читать реальное поведение

Checkout: `runtime/sources/sglang`. Commit, на котором снят extract, — в `content/engine-args/sglang/source/help-source.json` (`commit`); текущий — `git -C runtime/sources/sglang rev-parse HEAD`. При расхождении ориентируйся на код checkout'а и упомяни это в ответе, а не в документе.

Пути ниже даны относительно корня checkout'а. В разделе `## Источники` готового документа тот же файл пишется с префиксом каталога checkout'а (`sglang/…`, `ktransformers/…`) — см. «Источники» в конце промпта.

Объявление и разбор аргументов:

- `python/sglang/srt/server_args.py` — единственное место объявления: поля датакласса `ServerArgs` вида `A[тип, Arg(...), NS("группа")]` плюс несколько литеральных `parser.add_argument` в `add_cli_args`. Файл больше девяти тысяч строк, ищи по имени поля.
- `python/sglang/srt/arg_groups/arg_utils.py` — как аннотация превращается в argparse-аргумент (`Arg(help=..., aliases=..., cli_name=..., choices=..., action=..., no_cli=...)`, вывод имени флага из имени поля).
- `python/sglang/srt/arg_groups/argparse_actions.py` — `LoRAPathAction` и семейство `Deprecated*Action`.
- `python/sglang/srt/arg_groups/overrides.py` — групповые переопределения.
- `python/sglang/srt/server_args_config_parser.py` — слияние YAML-конфига (`--config`) с командной строкой.
- `python/sglang/launch_server.py` — точка входа.

**Самое важное для SGLang:** `ServerArgs.__post_init__` и несколько десятков методов `_handle_*` в том же файле переписывают значения после разбора CLI — по объему GPU-памяти, по архитектуре модели, по остальным флагам, по платформе. Смотри как минимум `_handle_gpu_memory_settings`, `_handle_model_specific_adjustments`, `_handle_attention_backend_compatibility`, `_handle_cuda_graph_config`, `_handle_page_size`, `_handle_deprecated_args`, `_handle_missing_default_values`. Объявленный default здесь регулярно не равен эффективному значению, и документ обязан это показывать.

Исполнение и подсистемы:

- Планирование: `python/sglang/srt/managers/scheduler.py`, `schedule_policy.py`, `schedule_batch.py`, `scheduler_components/`, `tokenizer_manager.py`, `data_parallel_controller.py`, `tp_worker.py`.
- Память и кеш префиксов: `python/sglang/srt/mem_cache/memory_pool.py`, `mem_cache/allocator/`, `mem_cache/radix_cache.py`, `mem_cache/hiradix_cache.py`, `managers/cache_controller.py`.
- Прогон модели: `python/sglang/srt/model_executor/model_runner.py`, `forward_batch_info.py`, `cuda_graph_config.py`.
- Внимание: `python/sglang/srt/layers/attention/attention_registry.py` и конкретные backend-файлы рядом (`flashinfer_backend.py`, `flashattention_backend.py`, `triton_backend.py`, `trtllm_mla_backend.py`, `nsa/`, `dsa/` и другие).
- Квантизация: `python/sglang/srt/layers/quantization/`.
- MoE и экспертный параллелизм: `python/sglang/srt/layers/moe/` (`ep_moe/`, `token_dispatcher/`, `topk.py`, `kt_ep_wrapper.py`), `python/sglang/srt/eplb/`.
- Спекулятивное декодирование: `python/sglang/srt/speculative/`.
- PD/EPD disaggregation: `python/sglang/srt/disaggregation/`.
- HTTP и протоколы: `python/sglang/srt/entrypoints/http_server.py`, `entrypoints/engine.py`, `entrypoints/openai/`, `entrypoints/anthropic/`.
- Парсеры: `python/sglang/srt/parser/reasoning_parser.py`, `python/sglang/srt/function_call/function_call_parser.py`.
- LoRA: `python/sglang/srt/lora/`. Распределенный слой: `python/sglang/srt/distributed/`.
- Переменные окружения — отдельный слой, не CLI: `python/sglang/srt/environ.py`.
- Апстрим-документация как вторичный источник: `docs/docs/advanced_features/server_arguments.mdx`, `hyperparameter_tuning.mdx`, `attention_backend.mdx`, `quantization.mdx`, `speculative_decoding.mdx`, `pd_disaggregation.mdx`, `hicache.mdx`, `lora.mdx`, `tool_parser.mdx`, `separate_reasoning.mdx`; тесты — `test/srt/`. При расхождении с кодом прав код.

### Шесть аргументов `kt_*`

`--kt-weight-path`, `--kt-method`, `--kt-cpuinfer`, `--kt-threadpool-count`, `--kt-num-gpu-experts`, `--kt-max-deferred-experts-per-token` (группа `exec.moe`) — это интеграция KTransformers: SGLang их только объявляет и передает дальше. На стороне SGLang читай `python/sglang/srt/layers/moe/kt_ep_wrapper.py` (`KTConfig`, обертка над `kt_kernel.KTMoEWrapper`), реальная семантика — в checkout'е KTransformers `runtime/sources/ktransformers`:

- `kt-kernel/README.md` — разделы про интеграцию с SGLang и параметры kt-kernel;
- `doc/en/AMX.md` — AMX-путь и требования к CPU;
- `doc/en/kt-kernel/` — `kt-kernel_intro.md`, `experts-sched-Tutorial.md`, `Native-Precision-Tutorial.md`, `AVX2-Tutorial.md`, `amd_blis.md`, `deepseek-v3.2-sglang-tutorial.md` и туториалы по конкретным моделям с реальными строками запуска;
- `kt-kernel/scripts/convert_cpu_weights.py` — как готовятся CPU-веса для `--kt-weight-path`;
- `kt-kernel/cpu_backend/`, `kt-kernel/operators/{amx,avx2,llamafile}`, `kt-kernel/python/experts.py` — что именно делают потоки, пулы и выбранный метод.

Если каталог `runtime/sources/ktransformers` еще не склонирован, это не повод фантазировать: опиши поведение только в той части, которую подтверждает `kt_ep_wrapper.py`, и укажи, что остальное проверяется по указанным файлам KTransformers.

Учитывай, что `--kt-threadpool-count` привязан к числу NUMA-узлов, а `--kt-cpuinfer` — к числу CPU-потоков; для arriero это пересекается с NUMA-политикой инстанса (`docs/NUMA_PINNING.md`) и с хостовым резервом памяти (`docs/RESOURCE_MANAGEMENT.md`).

Команды держи точечными: `grep -n "mem_fraction_static" runtime/sources/sglang/python/sglang/srt/server_args.py` полезнее полнотекстового поиска по checkout'у.

## Frontmatter

Схема фиксирована, лишних ключей не добавляй:

```yaml
---
schema: 1
engine: sglang
primaryName: "--mem-fraction-static"
title: "--mem-fraction-static"
summary: Одно-два практичных предложения без шаблонных формулировок.
group: schedule
related:
  - --max-running-requests
---
```

- `primaryName` — точно `flags[0]` из extract, вместе с ведущими дефисами.
- `title` — обычно то же значение.
- `summary` — 1-2 предложения о том, что аргумент делает и когда его трогают.
- `group` — точно `group` из extract (`schedule`, `memory`, `exec.moe`, `disagg`, ...); если там `null`, пиши `group: null`.
- `related` — только флаги, реально существующие в extract этого же движка (проверяются по всем `flags`, не только по основным). Пустой список — `related: []`.
- Ключей `estimation`, `valueType`, `aliases`, `allowedValues`, `env` здесь нет. Эти данные живут в extract; дублировать их во frontmatter — гарантированно протухнуть.

Проверка `related` перед сдачей:

```bash
python3 - <<'PY'
import json
d = json.load(open("content/engine-args/sglang/source/extract.json"))
known = {f for o in d["options"] for f in o["flags"]}
for flag in ["--max-running-requests", "--chunked-prefill-size"]:
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

Раздел, который неприменим, закрывается одной конкретной фразой («на память не влияет: значение только меняет формат логов»), а не пустотой и не водой.

## Особые случаи, которые нельзя размывать

- **`hidden: true`** (объявлен с `argparse.SUPPRESS`) или явно экспериментальный аргумент — так и пиши: скрытый/экспериментальный, в `--help` не показывается, контракт может измениться без предупреждения. Не оформляй его как штатную ручку. Пустой `help` в extract у скрытого аргумента — норма, а не повод придумать текст: тогда раздел «Оригинальная справка» так и фиксирует, что справки нет.
- **`choices: null`** означает одно из двух: у аргумента вообще нет `choices`, либо список собирается в runtime из реестра и статически не разрешим. Различай по коду. Реестровые случаи: `--reasoning-parser` (`python/sglang/srt/parser/reasoning_parser.py`), `--tool-call-parser` (`python/sglang/srt/function_call/function_call_parser.py`), `--speculative-algorithm` (встроенные имена плюс все зарегистрированные через `SpeculativeAlgorithm.register`), методы квантизации и backend'ы внимания, доступность которых зависит от железа и установленных пакетов. Пиши, **откуда** берется настоящий список и как посмотреть его на своей сборке; не переписывай перечень значений в документ — он протухнет за релиз.
- **`choices` есть, но значения выглядят странно** — доверяй extract: например, у `--disaggregation-mode` вариант по умолчанию — строка `"null"`, а не отсутствие значения. Это то, что реально принимает argparse.
- **`default.kind == "expression"`** — в extract лежит текст выражения, а не значение. Раскрой его по `origin`: `dataclasses.field(default_factory=list)` — пустой список; `ServerArgs.reasoning_parser` — значение берется из самого датакласса; `argparse.SUPPRESS` — аргумент вообще не попадает в namespace, если не задан; `10 * 1000 * 1000` — раскрой в число.
- **Декларативный default ≠ эффективное значение.** Для SGLang это правило, а не исключение: `__post_init__` подбирает значение по объему GPU-памяти, архитектуре модели и совместимости backend'ов. Если у аргумента `default: null`, почти всегда это означает «подберет движок» — покажи, где именно и по какой логике.
- **`action` из семейства `Deprecated*`** (`DeprecatedAction`, `DeprecatedAliasStoreAction`, `DeprecatedStoreTrueAction`, `DeprecatedStoreConstAction`) — аргумент устаревший: он печатает предупреждение и/или транслируется в актуальный флаг. Напиши, чем именно его заменили (смотри `_handle_deprecated_args`), и не рекомендуй его в примерах.
- **`action: "argparse.BooleanOptionalAction"`** — существует парный `--no-<flag>`; в `flags` он идет вторым. Опиши, что означает «не задан».
- **Несколько флагов в `flags`** — это алиасы одного поля (`--tp-size` / `--tensor-parallel-size`, `--model-path` / `--model`). Перечисли их в «Паспорте», но документ остается один, под `flags[0]`.

## На что смотреть по содержанию

- В какое поле `ServerArgs` попадает значение и кто читает его дальше: scheduler, memory pool, model runner, attention backend, tokenizer manager, HTTP-слой.
- Этап применения: разбор CLI → `__post_init__` и `_handle_*` → инициализация процессов (tokenizer / scheduler / detokenizer, TP/DP/PP-воркеры) → выделение KV-пула → захват CUDA graph → forward → HTTP.
- Что делают специальные значения: `0`, `-1`, `auto`, `null`, пустая строка. Формулируй конкретно: «`-1` отключает chunked prefill», «`0` отключает».
- Влияние на VRAM (веса, KV-пул через `--mem-fraction-static`, CUDA graphs, буферы спекуляции), на RAM хоста и CPU-потоки (особенно для `kt_*` и оффлоада), на время старта (захват графов, прогрев, конвертация весов), на throughput и latency под конкурентной нагрузкой.
- Взаимодействие: `--mem-fraction-static` / `--max-running-requests` / `--chunked-prefill-size` / `--max-total-tokens` / `--context-length` / `--page-size` / `--tp-size` — типовые узлы, где аргументы делят одну и ту же память и одну и ту же очередь.
- Что аргумент значит в связке с arriero: memory-draw инстанса, конкурентность (`sglang-max-running-requests`), политика вытеснения `idle-only`, NUMA-режим. Сверяйся с `docs/RESOURCE_MANAGEMENT.md`, `docs/NUMA_PINNING.md`, `docs/KTRANSFORMERS_OPERATIONS.md`, не выдумывай.
- Диагностика: какие строки в логе подтверждают, что значение принято (итоговый дамп `ServerArgs` при старте — `logger.info(f"{server_args=}")` в `python/sglang/srt/entrypoints/engine.py`, размер KV-пула, выбранный attention backend, предупреждения о deprecated-флагах), и как выглядит отказ.
- Что опасно для сервера, доступного не только с localhost.

## Стиль

- Инженерная справка администратору, а не маркетинг.
- Конкретика вместо обтекаемости: «принимает только степень двойки», «значение `0` отключает», «путь должен быть локальным каталогом, существующим на момент старта».
- Короткое вступление, дальше практика: значения, взаимодействия, симптомы, примеры.
- Неопределенность допустима, но только именованная: что именно не подтверждено и каким источником это проверяется. «Нужно проверить» без указания источника — не формулировка.
- Все флаги — в backticks. Английские термины (radix cache, chunked prefill, CUDA graph, disaggregation) оставляй как есть.

## Источники

В `## Источники` идут:

- пути в checkout'ах, начиная с имени каталога checkout'а: `sglang/python/sglang/srt/server_args.py`, `sglang/python/sglang/srt/managers/scheduler.py`, `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`, `ktransformers/kt-kernel/README.md`, `ktransformers/doc/en/AMX.md`. Абсолютных путей файловой системы (`/home/...`, `runtime/sources/...`) быть не должно;
- ссылки на upstream PR/issue/discussion — только те, что ты реально открыл и проверил по содержанию;
- при необходимости документы arriero (`docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`), помеченные как относящиеся к arriero, а не к движку.

Поле `origin` из extract у SGLang почти всегда имеет форму `ServerArgs.<field>` или `ServerArgs.add_cli_args` — это не путь, а место объявления; цитируй его в «Паспорте аргумента» дословно, а файл указывай отдельно в «Источниках».

## Проверка перед завершением

- Frontmatter валиден, ключи ровно те, что в схеме; `primaryName` совпадает с `flags[0]`, `group` — с `group` из extract.
- Каждый флаг в `related` найден в extract этого движка.
- Блок `## Оригинальная справка` совпадает с `help` из extract символ в символ.
- Ни одного `TODO`, «нужно проверить», «создан автоматически», «Что проверить агенту перед завершением» и прочих остатков шаблона — проверка качества такие файлы отклоняет.
- Никаких значений, скопированных из соседнего аргумента или из другого движка: одноименные флаги vLLM и SGLang ведут себя по-разному.
- Примеры запускаются как есть: полная строка `python -m sglang.launch_server --model-path <path> --flag value`, без конкатенации из кусков и без выдуманных флагов.
- Для `kt_*` аргументов проверено, что утверждения подтверждаются `kt_ep_wrapper.py` или документами KTransformers, а не догадкой по имени.
- В финальном ответе перечисли измененные файлы и основные источники, по которым проверял поведение.
