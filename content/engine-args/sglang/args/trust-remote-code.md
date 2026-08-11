---
schema: 1
engine: sglang
primaryName: "--trust-remote-code"
title: "--trust-remote-code"
summary: Разрешает выполнять Python-код, лежащий в самом чекпойнте (`configuration_*.py`, `modeling_*.py`, `tokenization_*.py`, код процессора). Это граница доверия: код выполняется с правами процесса сервера при старте, до какой-либо изоляции.
group: model
related:
  - --model-path
  - --tokenizer-path
  - --model-impl
  - --model-config-parser
  - --revision
  - --quantization
  - --weight-cache-mode
  - --speculative-draft-model-path
---

# --trust-remote-code

## Кратко

Флаг снимает единственную защиту transformers от исполнения кода из чекпойнта. Когда он задан, `AutoConfig`, `AutoTokenizer`, `AutoProcessor` и `AutoModel*` получают право импортировать и выполнять `.py`-файлы, лежащие рядом с весами (или скачанные с Hub вместе с ними). Код выполняется в процессе сервера, при старте, с правами пользователя, от которого запущен процесс — до того, как что-либо начнет слушать порт. На хосте, где вы не контролируете происхождение каждого чекпойнта, это эквивалент запуска чужого скрипта.

## Оригинальная справка

```text
Whether or not to allow for custom models defined on the Hub in their own modeling files.
```

## Паспорт аргумента

- Флаги: `--trust-remote-code`
- Группа: `model`
- Тип значения: булев переключатель (`store_true`); парной формы `--no-trust-remote-code` нет
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется ни одним `_handle_*`
- Где объявлен: `ServerArgs.trust_remote_code`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но это граница безопасности, а не настройка производительности
- Этап применения: построение `ModelConfig` (чтение `config.json`), инициализация токенизатора/процессора в tokenizer manager, detokenizer и TP-воркерах, определение чат-шаблона, разбор конфигов драфт-моделей; при `--weight-cache-mode daemon` — проброс в порожденные процессы демона

## Что меняет в движке

Значение расходится по всем местам, где SGLang обращается к HuggingFace-объектам чекпойнта:

- `ModelConfig.__init__` → `get_config(...)` (`sglang/python/sglang/srt/utils/hf_transformers/config.py`) — чтение `config.json`, включая пользовательские классы конфигурации из чекпойнта;
- `TokenizerManager`, `DetokenizerManager`, `TpModelWorker` → `get_tokenizer`/`get_processor` (`sglang/python/sglang/srt/utils/hf_transformers/tokenizer.py`, `processor.py`) — загрузка токенизатора и мультимодального процессора. В `tokenizer.py` флаг дополнительно разрешает резолв класса токенизатора через `auto_map` и `get_class_from_dynamic_module`, то есть прямой импорт модуля из чекпойнта;
- определение чат-шаблона (`sglang/python/sglang/srt/parser/template_detection.py`);
- разбор конфигов драфт-модели (`sglang/python/sglang/srt/arg_groups/speculative_hook.py`) и специализированных путей вроде dSpark;
- PD-развертывание: encode-сервер и encode-receiver читают конфиг и токенизатор с тем же флагом;
- `--weight-cache-mode daemon`: `--trust-remote-code` добавляется в командную строку каждого порожденного процесса демона (`sglang/python/sglang/srt/entrypoints/engine.py`), то есть право исполнять код чекпойнта получают и они.

Если флаг не задан, а чекпойнт требует собственного класса модели, transformers падает с обычным для себя сообщением о необходимости `trust_remote_code=True` — то есть отказ явный, не тихий.

**Асимметрия, о которой надо знать.** Несколько путей в SGLang передают `trust_remote_code=True` жестко, независимо от флага:

- ModelOpt-загрузчик: `AutoConfig.from_pretrained(..., trust_remote_code=True)`, `AutoModelForCausalLM.from_config(..., trust_remote_code=True)` и `from_pretrained(..., trust_remote_code=True)` в `DefaultModelLoader._load_modelopt_base_model` (`sglang/python/sglang/srt/model_loader/loader.py`);
- экспорт токенизатора в `_export_modelopt_checkpoint` — параметр по умолчанию `trust_remote_code: bool = True`;
- отдельные конфиги моделей, например `sglang/python/sglang/srt/configs/qwen3_asr.py`, где `kwargs.pop("trust_remote_code", True)`.

Значит `--trust-remote-code` **не** является полным выключателем исполнения кода чекпойнта: он управляет основным путем, но ModelOpt-путь доверяет чекпойнту всегда.

## Значения и формат

Переключатель без значения. Не задан — transformers откажется исполнять код из чекпойнта и потребует явного согласия. Задан — согласие дано на весь процесс и на все дочерние процессы, порожденные движком; выборочно (например «только токенизатор») его ограничить нельзя.

## Когда использовать

- Модель, чья архитектура не реализована ни в transformers, ни в SGLang, и поставляется вместе с `modeling_*.py`. Типичные примеры из туториалов KTransformers — MiniMax-M3 и подобные новые MoE-архитектуры, где строка запуска содержит `--trust-remote-code`.
- Токенизатор с собственным классом, объявленным через `auto_map`.
- Не включайте «на всякий случай» и не держите постоянно во всех инстансах. Флаг ничего не ускоряет и ничего не разрешает, кроме исполнения кода.
- Прежде чем включить на модели из непроверенного источника — прочитайте `.py`-файлы чекпойнта. Другого барьера нет.

## Влияние на производительность и память

На производительность и память практически не влияет: разница — разовый импорт нескольких Python-модулей при старте. Косвенный эффект в другом: пользовательский `modeling_*.py` может увести модель на реализацию transformers вместо оптимизированной реализации SGLang (см. `--model-impl`), и вот это уже меняет и скорость, и расход памяти.

## Взаимодействие с другими аргументами

- `--model-impl`: при `auto` SGLang использует свою реализацию, если она есть; кастомный код чекпойнта нужен именно тогда, когда своей реализации нет и нужен путь `transformers`.
- `--model-config-parser`: `hf`-парсер и есть тот путь, через который читается `config.json` кастомного класса.
- `--tokenizer-path`: флаг распространяется и на токенизатор из отдельного каталога.
- `--revision`: определяет, какая ревизия кода будет исполнена при загрузке с Hub (`code_revision` в резолве класса токенизатора). Пара «доверяю коду» + «беру произвольную ветку» опаснее, чем каждая часть по отдельности.
- `--weight-cache-mode daemon`: флаг наследуется порожденными демонами.
- `--quantization modelopt*`: ModelOpt-путь доверяет коду чекпойнта независимо от флага.
- `--speculative-draft-model-path`: конфиг драфт-модели читается с тем же флагом; отдельного переключателя для драфта нет.

## Типовые проблемы и диагностика

- `ValueError: Loading <repo> requires you to execute the configuration file in that repo on your local machine... Please pass the argument trust_remote_code=True to allow custom code to be run.` — чекпойнт требует своего кода, флаг не задан. Решение: либо задать флаг, предварительно прочитав код, либо взять чекпойнт с архитектурой, поддерживаемой SGLang нативно.
- Ошибка импорта внутри `modeling_*.py` (несовместимая версия transformers, отсутствующий пакет) — код чекпойнта уже исполняется; трассировка будет указывать на файлы внутри каталога модели или на кеш динамических модулей HuggingFace.
- Строка `Loading tokenizer for <name> directly as <class> (bypassing AutoTokenizer)` в DEBUG-логе означает, что сработал путь резолва класса, в том числе через `auto_map`.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).
- Про общедоступный сервер: сам флаг не открывает сетевую поверхность, но он снимает барьер на этапе, когда содержимое каталога модели превращается в исполняемый код. Если каталоги моделей доступны на запись кому-то помимо владельца сервиса, включенный `--trust-remote-code` превращает запись в каталог модели в удаленное исполнение кода при следующем старте. В arriero каталоги моделей — это хостовые пути инстанса (`docs/RESOURCE_MANAGEMENT.md`, `docs/KTRANSFORMERS_OPERATIONS.md`); права на них надо считать частью периметра.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/MiniMax-M3-MXFP8 --trust-remote-code --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/MiniMax-M3-MXFP8 --kt-weight-path /models/MiniMax-M3-MXFP8 --kt-method MXFP8 --kt-cpuinfer 64 --kt-threadpool-count 2 --kt-num-gpu-experts 4 --quantization mxfp8 --moe-runner-backend triton --trust-remote-code --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/tokenizer.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/parser/template_detection.py`
- `ktransformers/doc/en/kt-kernel/MiniMax-M3-Tutorial.md`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
