---
schema: 1
engine: vllm
primaryName: "--log-config-file"
title: "--log-config-file"
summary: Устаревший флаг пути к JSON-конфигурации логирования, оставленный для совместимости до v0.33.0. Значение переносится в `--logging-config.pylogging_config_file` и теперь применяется и к логам vLLM, и к uvicorn; в новых командах задавайте именно его.
group: LoggingConfig
related:
  - --logging-config
  - --log-level
  - --disable-access-log-for-endpoints
  - --uvicorn-log-level
  - --disable-uvicorn-access-log
---

# --log-config-file

## Кратко

Флаг **устарел**: логирование vLLM теперь описывается конфигом `LoggingConfig` (`--logging-config`), а путь к файлу `dictConfig` — его полем `pylogging_config_file`. `--log-config-file` пока разбирается, печатает предупреждение об устаревании и молча переносит значение в это поле. По комментарию в `add_cli_args` флаг и его трансляция живут в v0.31.0 и v0.32.0 и удаляются в v0.33.0.

Поведение по сравнению с прежним флагом изменилось: раньше файл доходил только до uvicorn, а логи vLLM настраивались переменной `VLLM_LOGGING_CONFIG_PATH` при импорте. Теперь один и тот же файл применяется к логгерам vLLM во всех процессах движка и передаётся uvicorn, а отсутствующий файл останавливает старт, а не просто пишет предупреждение.

## Оригинальная справка

```text
--log-config-file is deprecated and will be removed in v0.33.0. Use --logging-config.pylogging_config_file instead.
```

Текст задан модульной константой `_LOG_CONFIG_FILE_DEPRECATION_MESSAGE` в `vllm/engine/arg_utils.py`; то же сообщение `DeprecatedLogConfigFileAction` выдает предупреждением при каждом использовании флага.

## Паспорт аргумента

- Флаги: `--log-config-file`
- Группа argparse: `LoggingConfig`
- Тип значения: строка (путь к JSON-файлу), `metavar` — `PYLOGGING_CONFIG_FILE`
- Допустимые значения: путь к JSON-файлу со схемой `logging.config.dictConfig`; список не ограничен
- Значение по умолчанию: `argparse.SUPPRESS` — без флага атрибут в namespace не появляется вовсе, и путь берётся из `--logging-config.pylogging_config_file`, а при его отсутствии из `VLLM_LOGGING_CONFIG_PATH`
- Эффективное значение: переносится в `LoggingConfig.pylogging_config_file` и **перекрывает** значение из `--logging-config`, если заданы оба
- Обработчик: `action=DeprecatedLogConfigFileAction` — при разборе вызывает `warnings.warn(...)` и сохраняет значение как обычный `store`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Статус: устаревший, удаление запланировано на v0.33.0
- Этап применения: разбор CLI → `configure_logging_from_args` сразу после разбора в `vllm/entrypoints/cli/main.py` → дочерние процессы движка → HTTP-слой (`get_uvicorn_log_config`)

## Что меняет в движке

Трансляция выполняется в двух местах с одинаковой логикой «флаг перекрывает поле»:

1. `configure_logging_from_args(args)` (`vllm/logger.py`) берёт `args.logging_config` или `LoggingConfig()` и, если в namespace есть `log_config_file`, делает `replace(config, pylogging_config_file=args.log_config_file)`. Затем конфигурация применяется в текущем процессе, а результат записывается обратно в `args.logging_config` и `args.log_config_file`.
2. `EngineArgs.create_logging_config()` (`vllm/engine/arg_utils.py`) повторяет то же самое при сборке `VllmConfig`, и итоговый `LoggingConfig` уезжает в `VllmConfig.logging_config`. Из него логирование заново настраивают процессы engine core, worker'ы `multiproc_executor` и процессы API-сервера при `--api-server-count > 1`.

Применение файла — `_configure_vllm_root_logger`: при включённом `configure_logging` сначала строится встроенный `dictConfig` vLLM, затем, если путь задан, файл читается через `json.loads` и **заменяет** встроенную конфигурацию целиком, без слияния. Поэтому `--log-level` при заданном файле не действует: уровни логгеров и обработчиков задаёт сам файл.

Для uvicorn путь берётся из того же `logging_config.pylogging_config_file` в `get_uvicorn_log_config()` (`vllm/entrypoints/launchers/utils/server_utils.py`). Если файл загрузился, он становится `log_config` uvicorn, и фильтр `--disable-access-log-for-endpoints` не строится.

## Значения и формат

- Только JSON: YAML не поддерживается, файл разбирается `json.loads`.
- Корень файла обязан быть объектом, иначе `ValueError: ('Invalid logging config. Expected dict, got %s.', ...)`.
- Схема — стандартный `dictConfig` с `"version": 1`. Раз файл получают и vLLM, и uvicorn, в нём стоит описать логгеры `vllm`, `uvicorn`, `uvicorn.error`, `uvicorn.access`.
- Несуществующий путь — `RuntimeError` на старте (`Could not load logging config. File does not exist: ...`). Это проверка vLLM, а не uvicorn, и теперь она срабатывает и для значения флага.
- В связке с `--logging-config.configure_logging false` старт падает: `Logging configuration is disabled, but a Python logging config file was given. pylogging_config_file requires configure_logging to be enabled.`

## Когда использовать

- В новых командах — не использовать. Пишите `--logging-config.pylogging_config_file <путь>`: поведение то же, но без предупреждения и без перехода на удаляемый флаг.
- Допустимо временно оставить в существующей команде запуска при переходе на v0.31.0/v0.32.0, понимая, что файл теперь действует и на логи vLLM.
- Перед v0.33.0 флаг из аргументов инстанса нужно убрать: после удаления argparse отвергнет его как неизвестный, и инстанс перестанет стартовать.
- В arriero stdout и stderr управляемого процесса пишутся в `runtime/logs/`, а разбор лога ищет записи, начинающиеся с `ERROR`/`WARNING`, и строки прогресса загрузки. Свой формат сообщений (например, JSON-форматтер) ломает подсветку ошибок и индикатор этапов старта, хотя готовность по строке uvicorn `Application startup complete.` продолжает определяться.

## Влияние на производительность и память

Сам флаг ничего не стоит: файл читается один раз в каждом процессе при старте. Стоимость определяет конфигурация внутри файла — синхронная запись в файл или в сеть на каждую строку становится заметной под нагрузкой.

## Взаимодействие с другими аргументами

- `--logging-config`: каноническое место для того же пути (`pylogging_config_file`) и для `configure_logging`. Если заданы и поле, и этот флаг, побеждает флаг — так проверяет тест `test_logging_config_cli_args`.
- `--log-level`: не действует при заданном файле — файл заменяет встроенную конфигурацию, а не дополняет её.
- `--disable-access-log-for-endpoints`: не применяется, если файл загрузился для uvicorn.
- `--uvicorn-log-level`: значение передаётся в `uvicorn.Config`, но уровни логгеров из файла имеют приоритет.
- `--disable-uvicorn-access-log`: конфигурация из файла задаёт обработчики целиком и может вернуть access-лог.

## Типовые проблемы и диагностика

- **Симптом:** в stderr при старте `UserWarning: --log-config-file is deprecated and will be removed in v0.33.0. Use --logging-config.pylogging_config_file instead.` **Причина:** используется устаревший флаг. **Лечение:** заменить на `--logging-config.pylogging_config_file`.
- **Симптом:** процесс падает на старте с `RuntimeError: ('Could not load logging config. File does not exist: %s', '<путь>')`. **Причина:** путь не существует; проверка выполняется до загрузки модели. **Лечение:** исправить путь в флаге, в `--logging-config` или в `VLLM_LOGGING_CONFIG_PATH` — проверяется итоговое значение.
- **Симптом:** после перехода на v0.31.0 изменился формат или уровень сообщений самого vLLM, хотя команда та же. **Причина:** файл, раньше влиявший только на uvicorn, теперь применяется и к логгерам vLLM. **Лечение:** описать в файле логгер `vllm` явно или убрать файл.
- **Симптом:** `--log-level DEBUG` не дал отладочных строк. **Причина:** задан файл конфигурации, он перекрывает встроенный `dictConfig`. **Лечение:** выставить уровни в самом файле.
- **Симптом:** после обновления vLLM инстанс не стартует с `unrecognized arguments: --log-config-file`. **Причина:** флаг удалён (запланировано на v0.33.0). **Лечение:** перейти на `--logging-config.pylogging_config_file`; проверить, какой флаг принимает установленная версия, можно через `vllm serve --help=LoggingConfig`.

## Примеры

Устаревшая форма, работает с предупреждением:

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --log-config-file /etc/vllm/log-config.json
```

Каноническая замена:

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --logging-config.pylogging_config_file /etc/vllm/log-config.json
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/logging.py`
- `vllm/vllm/logger.py`
- `vllm/vllm/entrypoints/cli/main.py`
- `vllm/vllm/entrypoints/launchers/utils/server_utils.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/examples/features/logging_configuration.md`
- `vllm/tests/entrypoints/launchers/test_cli_args.py`
- upstream-коммит `45d56c0ba` «[Core] Model console logging as CLI configuration (#57205)» в checkout'е
- `apps/api/src/process/log-parsers/vllm.ts` (arriero)
