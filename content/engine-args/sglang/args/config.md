---
schema: 1
engine: sglang
primaryName: "--config"
title: "--config"
summary: Читает аргументы запуска из YAML-файла. Это не отдельный слой конфигурации, а препроцессор командной строки — ключи файла разворачиваются в флаги и подставляются перед CLI, поэтому явный флаг всегда побеждает.
group: null
related:
  - --model-path
  - --mm-process-config
  - --cuda-graph-config
  - --cuda-graph-backend-prefill
  - --cuda-graph-max-bs-decode
  - --lora-paths
  - --incremental-streaming-output
  - --mamba-radix-cache-strategy
  - --dsa-prefill-backend
---

# --config

## Кратко

`--config` не создает второй источник настроек внутри `ServerArgs`. Перед разбором CLI `prepare_server_args` читает YAML, превращает каждую пару ключ-значение в argparse-токены и склеивает список как `<аргументы из файла> + <аргументы командной строки>`. Дальше работает обычный argparse: для `store`-аргументов побеждает последнее вхождение, то есть командная строка. Механизм поддерживает только два вида argparse-действий — `store` и `store_true`; ключ, попадающий в аргумент с любым другим действием, отвергается с ошибкой на старте. Из-за этого часть вполне обычных настроек (включая `cuda-graph-backend-prefill` и `cuda-graph-max-bs-decode`) в YAML задать нельзя.

## Оригинальная справка

```text
Read CLI options from a config file. Must be a YAML file with configuration options.
```

## Паспорт аргумента

- Флаги: `--config`
- Группа: `null` — аргумент не принадлежит ни одной argparse-группе, потому что это не поле `ServerArgs`, а мета-аргумент, объявленный литеральным `parser.add_argument` в `add_cli_args`
- Тип значения: str — путь к файлу
- Допустимые значения: путь к существующему файлу с расширением `.yaml` или `.yml`
- Значение по умолчанию: `null` (файл не читается)
- Эффективное значение: значение никуда не сохраняется — в `ServerArgs` нет поля `config`, и `from_cli_args` его отбрасывает. Единственный эффект — подстановка аргументов до разбора
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; вся логика слияния — `sglang/python/sglang/srt/server_args_config_parser.py`
- Статус: обычный
- Этап применения: до разбора CLI, в `prepare_server_args`; на `__post_init__` и дальше уже никак не влияет

## Что меняет в движке

### Порядок слияния

```python
if "--config" in argv:
    config_merger = ConfigArgumentMerger(parser)
    argv = config_merger.merge_config_with_args(argv)
raw_args = parser.parse_args(argv)
```

`merge_config_with_args` возвращает `config_args + before_config + after_config`, где `before_config`/`after_config` — куски исходной командной строки вокруг пары `--config <path>`. Аргументы из файла идут **первыми**, поэтому:

- для обычного `store`-аргумента (`--tp-size`, `--mem-fraction-static`, `--attention-backend`) значение из CLI перезаписывает значение из файла — это и есть заявленный приоритет `CLI > config > defaults`;
- для `store_true`-флага файл может только **включить** его (`value: true` добавляет флаг, `value: false` не добавляет ничего). Выключить в CLI то, что включено в файле, невозможно — парного `--no-*` у таких флагов нет;
- для списочного аргумента (`nargs="+"`, например `--cuda-graph-bs-decode`) повторное вхождение из CLI полностью заменяет список из файла, а не дополняет его.

### Преобразование значений

`_convert_config_to_args` обрабатывает значение по его YAML-типу:

- `bool` → флаг (`store_true`) либо пара `--key true/false`;
- `list` → `--key v1 v2 v3` (пустой список пропускается целиком);
- `dict` → `--key '<json>'` через `json.dumps` — так задаются JSON-аргументы вроде `--cuda-graph-config`, `--mm-process-config`, `--default-chat-template-kwargs`;
- всё остальное → `--key <str(value)>`.

Имя флага собирается как `f"--{key}"` из **сырого** ключа. Нормализация дефисов в подчеркивания используется только для внутренних проверок, поэтому ключ `model_path` превратится в несуществующий флаг `--model_path`, и argparse завершит запуск с `error: unrecognized arguments: --model_path …`. **Ключи в YAML пишутся через дефис**, ровно как флаги без ведущих `--`.

### Отвергаемые ключи

Конструктор `ConfigArgumentMerger` собирает множество «неподдерживаемых» аргументов: всё, что не является `argparse._StoreAction` или `argparse._StoreTrueAction` (кроме `--config`, `-h`, `--help`). Ключ, попавший в такой аргумент, приводит к отказу:

```text
ValueError: Unsupported config option 'cuda_graph_backend_prefill' with action 'DeprecatedStoreConstAction'
```

Ловушка в том, что множество индексируется по `dest`, а устаревшие алиасы объявлены на тот же `dest`, что и актуальные флаги. Поэтому в YAML **нельзя** задать: `cuda-graph-backend-prefill`, `cuda-graph-max-bs-decode`, `cuda-graph-bs-decode`, `cuda-graph-max-bs-prefill`, `cuda-graph-bs-prefill`, `cuda-graph-tc-compiler`, `mamba-radix-cache-strategy`, `dsa-prefill-backend`, `dsa-decode-backend`, `speculative-draft-window-size`, `incremental-streaming-output`, `enable-linear-replayssm-spec`. Плюс аргументы с `BooleanOptionalAction` (`dcp-replicate-q-proj`, `dllm-fdfo`, `experts-shared-outer-loras`, `lora-strict-loading`) и `lora-paths` с собственным `LoRAPathAction`.

Асимметрия здесь не логическая, а историческая: `cuda-graph-backend-decode` в YAML работает, потому что на этот `dest` не повешен ни один устаревший алиас, а `cuda-graph-backend-prefill` — нет, потому что на нем висят `--enable-breakable-cuda-graph`, `--disable-piecewise-cuda-graph` и `--enforce-piecewise-cuda-graph`. Обходной путь для CUDA graph один: класть настройку в `cuda-graph-config` как вложенный словарь.

## Значения и формат

- Файл обязан иметь расширение `.yaml` или `.yml`, иначе `ValueError: Config file must be YAML format, got: .json`.
- Файл обязан существовать: `ValueError: Config file not found: …`.
- Корень файла — словарь; список или скаляр дают `ValueError: Config file must contain a dictionary at root level`. Пустой файл эквивалентен пустому словарю и просто ничего не добавляет.
- Ровно один `--config` на запуск: два и больше → `ValueError: Multiple config files specified! Only one allowed.`
- Форма `--config=/path/file.yaml` **не работает**: слияние включается проверкой `if "--config" in argv`, то есть точным совпадением токена. С формой через знак равенства файл молча не читается — argparse просто положит путь в `namespace.config`, а `ServerArgs.from_cli_args` его выбросит. Пишите `--config /path/file.yaml` через пробел.
- Пути внутри файла не разрешаются относительно самого файла — они попадают в argparse как есть, то есть трактуются относительно рабочего каталога процесса.

## Когда использовать

- Длинная воспроизводимая конфигурация под git: модель, параллелизм, лимиты планировщика, метрики. Файл читается человеком лучше, чем строка из сорока флагов.
- Один базовый файл плюс точечные переопределения в командной строке для экспериментов — рабочая схема, потому что CLI гарантированно побеждает.
- Не использовать как источник «дефолтов, которые можно выключить»: булев флаг, включенный в файле, из CLI не отключается.
- В arriero смысла в `--config` немного: аргументы инстанса и так хранятся в `config/instances/<name>.json` и версионируются через Configuration Git (`docs/CONFIG_GIT.md`). Второй файл вне этого дерева усложняет диагностику: в дампе `server_args=` не видно, откуда пришло значение, а drift-детекция менеджера сравнивает только аргументы запуска, а не содержимое внешнего YAML.

## Влияние на производительность и память

На память и скорость не влияет: аргумент только переписывает список токенов командной строки до разбора. Стоимость — одно чтение файла и один `yaml.safe_load` на старте.

## Взаимодействие с другими аргументами

- `--cuda-graph-config`: единственный практичный способ настроить CUDA graph из YAML — вложенный словарь превращается в JSON-строку. Пример: `cuda-graph-config: {decode: {backend: full, max_bs: 128}, prefill: {backend: breakable}}`.
- `--cuda-graph-backend-prefill`, `--cuda-graph-max-bs-decode`, `--mamba-radix-cache-strategy`, `--dsa-prefill-backend`, `--incremental-streaming-output`, `--lora-paths`: в YAML отвергаются (см. выше), задаются только в командной строке.
- `--mm-process-config`, `--default-chat-template-kwargs`: словарь в YAML корректно превращается в JSON — это проверено регрессионным тестом апстрима.
- `--model-path`: обычно задается именно в файле; ключ пишется как `model-path` (алиас `model` тоже допустим, так как это отдельная строка опции).

## Типовые проблемы и диагностика

- `error: unrecognized arguments: --model_path /models/x` — ключ в YAML написан через подчеркивание. Переименуйте в `model-path`.
- `ValueError: Unsupported config option '<dest>' with action '<Action>'` — ключ бьет в аргумент с нестандартным argparse-действием. Перенесите его в командную строку или, для CUDA graph, в `cuda-graph-config`.
- Файл указан, а настройки не применились — почти всегда это форма `--config=file.yaml`. Проверьте дамп `server_args=` в логе: если значения совпадают с дефолтами, файл не читался.
- `ValueError: Config file must be YAML format, got: .txt` / `Config file not found: …` — расширение или путь.
- Значение из файла «не сработало», хотя ключ верный — посмотрите, нет ли того же флага в командной строке: он победит без всякого предупреждения.
- Чем подтвердить итог: единственный авторитет — дамп `server_args=…` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) и `GET /server_info` у поднятого сервера.

## Примеры

```bash
python -m sglang.launch_server --config /etc/sglang/qwen3.yaml
```

```bash
python -m sglang.launch_server --config /etc/sglang/qwen3.yaml --mem-fraction-static 0.78 --max-running-requests 8
```

Содержимое `/etc/sglang/qwen3.yaml` для второго примера:

```yaml
model-path: /models/Qwen3-30B-A3B
host: 127.0.0.1
port: 30000
tensor-parallel-size: 1
mem-fraction-static: 0.85
max-running-requests: 16
enable-metrics: true
cuda-graph-config: {decode: {backend: full, max_bs: 32}}
```

## Источники

- `sglang/python/sglang/srt/server_args_config_parser.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/CONFIG_GIT.md`
