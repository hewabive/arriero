---
schema: 1
engine: vllm
primaryName: "--reasoning-parser-plugin"
title: "--reasoning-parser-plugin"
summary: Путь к своему Python-файлу, который на старте импортируется и регистрирует дополнительные reasoning-парсеры в общем реестре. Ошибка импорта не роняет сервер — она превращается в отказ на валидации имени парсера.
group: StructuredOutputsConfig
related:
  - --reasoning-parser
  - --structured-outputs-config
  - --tool-parser-plugin
  - --tool-call-parser
---

# --reasoning-parser-plugin

## Кратко

Реестр reasoning-парсеров расширяемый: файл, указанный этим аргументом, импортируется по абсолютному пути до валидации `--reasoning-parser`, и всё, что он зарегистрировал через `ReasoningParserManager.register_module(...)`, становится доступным по имени.

Аргумент нужен ровно тогда, когда модель размечает рассуждение маркерами, для которых в `vllm/reasoning/` нет готового парсера. Сам по себе он ничего не включает — он только пополняет список допустимых значений `--reasoning-parser`.

## Оригинальная справка

```text
Path to a dynamically reasoning parser plugin that can be dynamically
loaded and registered.
```

## Паспорт аргумента

- Флаги: `--reasoning-parser-plugin`
- Группа argparse: `StructuredOutputsConfig`
- Тип значения: строка — путь к `.py`-файлу
- Допустимые значения: не ограничены парсером аргументов; существование файла на этапе разбора CLI не проверяется
- Значение по умолчанию: `""` — плагин не загружается
- Эффективное значение: не переопределяется. Загрузка выполняется только при длине строки **больше трёх символов** (`if args.reasoning_parser_plugin and len(args.reasoning_parser_plugin) > 3`); путь короче четырёх символов молча игнорируется во всех трёх местах загрузки
- Где объявлен: `vllm/config/structured_outputs.py:StructuredOutputsConfig.reasoning_parser_plugin`
- Этап применения: `setup_server()` и `run_server_worker()` API-сервера — до валидации имени парсера и до подъёма движка; независимо от них — инициализация `StructuredOutputManager` в процессе engine core

## Что меняет в движке

`ReasoningParserManager.import_reasoning_parser(plugin_path)` берёт basename файла как имя модуля и импортирует его через `import_from_path` — то есть исполняет файл. Побочный эффект импорта и есть регистрация: декоратор `@ReasoningParserManager.register_module("my_parser")` кладёт `(module_path, class_name)` в таблицу ленивых парсеров, прямой вызов `register_module(name=..., module=...)` регистрирует класс сразу. Класс обязан наследовать `ReasoningParser`, иначе регистрация поднимает `TypeError`.

Загрузка выполняется трижды и в разных процессах:

1. `setup_server()` — до `validate_api_server_args()`, поэтому имя из плагина проходит проверку `list_registered()`;
2. `run_server_worker()` — в каждом воркере API-сервера (актуально при `--api-server-count > 1`);
3. `StructuredOutputManager.__init__` в процессе engine core — чтобы парсер был доступен и на пути структурированного вывода, где он гасит грамматику внутри блока рассуждения.

Важная деталь надёжности: `import_reasoning_parser` ловит любое исключение импорта, пишет `Failed to load module '<name>' from <path>.` с трейсбеком и **возвращается нормально**. Сервер не падает на плохом плагине — он падает позже, на `KeyError: invalid reasoning parser: ...`, потому что имя так и не появилось в реестре.

## Значения и формат

- Путь к одному файлу, не к пакету и не к модулю в `sys.path`: `import_from_path` загружает файл по спецификации. Относительный путь резолвится относительно рабочего каталога процесса движка, поэтому под supervisor'ом надёжнее абсолютный.
- Регистрируется столько парсеров, сколько файл зарегистрировал, — соответствие «один файл — одно имя» ниоткуда не следует.
- Строка длиной 1–3 символа игнорируется без единого сообщения. Это защита от заглушек вроде `"-"`, но она же прячет опечатки в очень коротких путях.
- Пустая строка (значение по умолчанию) означает «плагин не загружать».
- Плагин загружается всегда, независимо от того, задан ли `--reasoning-parser`: можно зарегистрировать парсеры и не использовать их.

## Когда использовать

- **Своя или очень свежая модель.** Маркеры рассуждения не совпадают ни с одним парсером из `ReasoningParserManager.list_registered()`, но структурно это те же «начало/конец блока» — наследуйте `BaseThinkingReasoningParser` и переопределите `start_token` / `end_token`.
- **Локальная правка поведения готового парсера.** Плагин может перерегистрировать существующее имя (`register_module` по умолчанию `force=True`), заменив штатный класс своим, — удобнее, чем патчить установленный пакет в неизменяемом uv-окружении.
- **Не используйте, если подходит штатный парсер.** Каждый плагин — это код, исполняемый на старте сервера, и ещё одна вещь, которую нужно нести через обновления движка.
- **Не кладите плагин внутрь окружения.** Окружения arriero неизменяемы (`docs/ENVIRONMENTS.md`); файл плагина должен лежать рядом с конфигурацией инстанса, а не в `site-packages`.

## Влияние на производительность и память

Один импорт Python-модуля на процесс. На VRAM, на throughput и на latency не влияет; на время старта — на величину импорта самого файла и его зависимостей. Стоимость самого разбора описана в `--reasoning-parser`.

## Взаимодействие с другими аргументами

- `--reasoning-parser`: единственный потребитель. Плагин без него ничего не включает; имя из плагина без плагина не пройдёт валидацию.
- `--structured-outputs-config`: содержит то же поле; верхнеуровневый флаг перекрывает значение из JSON при непустой строке.
- `--tool-parser-plugin`: полный аналог для реестра tool-парсеров, с той же проверкой длины `> 3` и той же схемой загрузки. Аргументы независимы, один файл может при желании регистрировать оба вида парсеров.
- `--api-server-count`: при нескольких воркерах файл импортируется в каждом; он должен быть читаем из всех процессов и не должен иметь неидемпотентных побочных эффектов.

## Типовые проблемы и диагностика

- **Симптом:** `KeyError: invalid reasoning parser: my_parser (chose from { ... })`, хотя плагин указан. **Причина:** файл не импортировался или не зарегистрировал имя. **Проверка:** выше в логе должно быть `Failed to load module 'my_parser' from /path/my_parser.py.` с трейсбеком; если этой строки нет — файл вообще не читался (путь короче четырёх символов либо флаг не дошёл до сервера).
- **Симптом:** плагин указан, ошибок нет, но имя всё равно неизвестно. **Причина:** класс зарегистрирован под другим именем (при `register_module()` без имени берётся имя класса). **Лечение:** сверить с `ReasoningParserManager.list_registered()`.
- **Симптом:** `TypeError: module must be subclass of ReasoningParser, but got <class ...>`. **Причина:** зарегистрирован класс не того базового типа. **Лечение:** наследовать `vllm.reasoning.ReasoningParser` (или `BaseThinkingReasoningParser`).
- **Симптом:** парсер работает в HTTP-ответах, но structured outputs всё равно принуждает грамматику внутри рассуждения. **Причина:** в процессе engine core плагин не загрузился — это отдельная точка загрузки со своим логом. **Проверка:** искать `Failed to load module` в логах именно процесса движка.
- **Симптом:** после обновления vLLM плагин перестал импортироваться. **Причина:** внутренний API `ReasoningParser` не является стабильным контрактом. **Лечение:** сверить сигнатуры `extract_reasoning` / `extract_reasoning_streaming` / `is_reasoning_end` с `vllm/reasoning/abs_reasoning_parsers.py` установленной версии.
- **Подтверждение принятого значения:** отдельной строки об успешной загрузке нет. Практическая проверка — сервер стартовал с `--reasoning-parser <имя из плагина>` и не упал на валидации.

## Примеры

```bash
vllm serve /models/custom-reasoner --reasoning-parser-plugin /opt/arriero/plugins/my_reasoning_parser.py --reasoning-parser my_parser
```

```bash
vllm serve /models/custom-reasoner --reasoning-parser-plugin /opt/arriero/plugins/my_reasoning_parser.py --reasoning-parser my_parser --structured-outputs-config '{"backend": "xgrammar"}'
```

## Источники

- `vllm/vllm/config/structured_outputs.py`
- `vllm/vllm/reasoning/abs_reasoning_parsers.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/v1/structured_output/__init__.py`
- `vllm/vllm/utils/import_utils.py`
- `docs/ENVIRONMENTS.md` (arriero)
