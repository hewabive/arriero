---
schema: 1
engine: vllm
primaryName: "--logging-config"
title: "--logging-config"
summary: JSON-объект `LoggingConfig` — уровень встроенного логирования vLLM, путь к собственному файлу `dictConfig` и выключатель настройки логирования. Заменяет переменные `VLLM_LOGGING_LEVEL`, `VLLM_CONFIGURE_LOGGING`, `VLLM_LOGGING_CONFIG_PATH`, которые остаются лишь значениями по умолчанию.
group: LoggingConfig
related:
  - --log-level
  - --log-config-file
  - --uvicorn-log-level
  - --disable-access-log-for-endpoints
  - --enable-log-requests
  - --config
---

# --logging-config

## Кратко

`--logging-config` заполняет датакласс `LoggingConfig` (`vllm/config/logging.py`) из трёх полей: `log_level`, `configure_logging` и `pylogging_config_file`. Раньше то же самое задавалось только переменными окружения и применялось при импорте модуля `vllm.logger`; теперь логирование настраивается после разбора CLI и тем же объектом передаётся во все процессы движка.

Переменные `VLLM_LOGGING_LEVEL`, `VLLM_CONFIGURE_LOGGING` и `VLLM_LOGGING_CONFIG_PATH` продолжают работать, но только как значения полей по умолчанию: всё, что задано флагом или ключом в `--config`, их перекрывает. Для уровня есть короткая форма `--log-level`, для пути к файлу — устаревший `--log-config-file`.

## Оригинальная справка

```text

```

Справка в extract пуста: аргумент объявлен как `logging_group.add_argument("--logging-config", **logging_config_kwargs)`, где `logging_config_kwargs` — локальная копия `get_kwargs(VllmConfig)["logging_config"]` с подменённым `default`, и статический разбор её не прослеживает. В `vllm serve --help` выводятся docstring поля (`Logging configuration.`), ссылка на API-документацию `LoggingConfig` и подсказка `Should either be a valid JSON string or JSON keys passed individually.`; описание группы `LoggingConfig` берётся из docstring класса.

## Паспорт аргумента

- Флаги: `--logging-config`
- Группа argparse: `LoggingConfig`
- Тип значения: JSON-объект `LoggingConfig`, либо точечные под-флаги `--logging-config.<поле> <значение>`; строка разбирается `TypeAdapter(LoggingConfig).validate_json` прямо в argparse
- Допустимые значения: поля `log_level` (`CRITICAL`, `ERROR`, `WARNING`, `INFO`, `DEBUG`, `NOTSET`, регистр важен), `configure_logging` (bool), `pylogging_config_file` (путь или `null`); лишний ключ отвергается, датакласс объявлен с `extra="forbid"`
- Значение по умолчанию: `argparse.SUPPRESS`, выставленный явно в `add_cli_args`. Без флага атрибута в namespace нет, и используется `LoggingConfig()`, поля которого берутся из окружения: `log_level` ← `VLLM_LOGGING_LEVEL` (по умолчанию `INFO`, приводится к верхнему регистру), `configure_logging` ← `VLLM_CONFIGURE_LOGGING` (по умолчанию `1`), `pylogging_config_file` ← `VLLM_LOGGING_CONFIG_PATH` (по умолчанию не задан)
- Эффективное значение: `--log-level` перекрывает `log_level`, `--log-config-file` перекрывает `pylogging_config_file` — и в `configure_logging_from_args`, и в `EngineArgs.create_logging_config()`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: сразу после разбора CLI (`configure_logging_from_args` в `vllm/entrypoints/cli/main.py`) → `create_engine_config` → `VllmConfig.logging_config` → дочерние процессы engine core, worker'ов и API-сервера → HTTP-слой (файл для uvicorn)

## Что меняет в движке

**Где применяется.** `vllm/entrypoints/cli/main.py` вызывает `configure_logging_from_args(args)` для любой подкоманды до её `validate`. Функция собирает итоговый `LoggingConfig`, применяет его в текущем процессе и записывает обратно в `args.logging_config`. `EngineArgs.create_engine_config()` первым делом строит тот же объект через `create_logging_config()` и вызывает `configure_logging_if_needed` — повторная настройка пропускается, если объект не изменился. Затем конфиг уходит в `VllmConfig`, и его заново применяют `EngineCoreProc.run_engine_core`, `WorkerProc.worker_main` (`multiproc_executor`) и `run_api_server_worker_proc` при `--api-server-count > 1`. Импорт `vllm.logger` больше ничего не настраивает.

**Что делает каждое поле** (`_configure_vllm_root_logger` в `vllm/logger.py`):

| Поле | Что делает |
| --- | --- |
| `log_level` | уровень обработчика и логгера `vllm` во встроенном `dictConfig`. При `INFO` логгеры `httpx` и `httpx2` дополнительно поднимаются до `WARNING` |
| `configure_logging` | `false` — vLLM не применяет никакой `dictConfig` и не ставит свою фабрику записей. Это то же, что прежний `VLLM_CONFIGURE_LOGGING=0` |
| `pylogging_config_file` | JSON-файл `dictConfig`, который **заменяет** встроенную конфигурацию целиком, без слияния; при нём `log_level` на логгеры и обработчики не влияет. Тот же путь `get_uvicorn_log_config()` отдаёт uvicorn как `log_config` |

Поток, префикс и цвет встроенного обработчика по-прежнему задаются только окружением: `VLLM_LOGGING_STREAM`, `VLLM_LOGGING_PREFIX`, `VLLM_LOGGING_COLOR`.

Не всё, что зависит от уровня логирования, читает этот конфиг. Включение runtime-assert'ов inductor на torch младше 2.12 (`CompilationConfig`) по-прежнему проверяет `envs.VLLM_LOGGING_LEVEL == "DEBUG"`, то есть переменную окружения, а не `log_level`.

## Значения и формат

Обе формы записи равнозначны:

```bash
--logging-config '{"log_level": "DEBUG", "configure_logging": true}'
--logging-config.log_level DEBUG --logging-config.pylogging_config_file /etc/vllm/log-config.json
```

- `log_level` сравнивается с `Literal` буквально: `debug` в нижнем регистре — ошибка валидации ещё на разборе CLI.
- `pylogging_config_file` не проверяется на разборе: существование файла проверяет `_configure_vllm_root_logger` и при отсутствии поднимает `RuntimeError`. Файл должен быть JSON-объектом со схемой `dictConfig`.
- `configure_logging: false` вместе с непустым `pylogging_config_file` — ошибка старта. Помните, что `pylogging_config_file` может прийти и из `VLLM_LOGGING_CONFIG_PATH`.
- При `configure_logging: false` у логгера `vllm` нет обработчиков: INFO-сообщения пропадают, а предупреждения и ошибки, если корневой логгер никто не настроил, печатаются запасным обработчиком Python (`logging.lastResort`) одним текстом — без уровня, времени и имени файла.
- Значения из YAML-файла `--config` и из командной строки перекрывают переменные окружения; явный флаг командной строки перекрывает `--config`.

## Когда использовать

- Нужен отладочный уровень vLLM на время расследования — проще `--log-level DEBUG`; через этот флаг — когда настраиваете сразу несколько полей.
- Логи должны уходить в сборщик в структурированном виде — `pylogging_config_file` с JSON-форматтером (`python-json-logger` входит в зависимости vLLM). Опишите в файле и `vllm`, и логгеры uvicorn: файл получают оба.
- Нужно полностью отдать логирование внешнему коду — `configure_logging: false`. Для `vllm serve` это обычно не нужно.
- В arriero stdout и stderr инстанса пишутся в `runtime/logs/`, а разбор лога ищет записи, начинающиеся с `ERROR`/`WARNING`, и строки прогресса загрузки (процент загрузки весов, KV-cache, захват CUDA graphs). Уровень выше `INFO` убирает этапы из индикатора старта, свой формат сообщений ломает подсветку ошибок, а `configure_logging: false` — и то и другое. Готовность по строке uvicorn `Application startup complete.` это не затрагивает.
- Не путайте с `--uvicorn-log-level`: тот управляет только логгерами uvicorn.

## Влияние на производительность и память

На VRAM и throughput не влияет. На уровне `DEBUG` объём логов вырастает на порядки, а вместе с `--enable-log-requests` в лог попадают промпты целиком — это и нагрузка на диск, и утечка пользовательских данных. Синхронные обработчики из собственного файла, пишущие в сеть, добавляют задержку на каждую строку.

## Взаимодействие с другими аргументами

- `--log-level`: короткая форма для `log_level`, побеждает значение из этого флага.
- `--log-config-file`: устаревшая форма для `pylogging_config_file`, тоже побеждает; удаляется в v0.33.0.
- `--uvicorn-log-level`: независимый уровень uvicorn; при загруженном `pylogging_config_file` уровни uvicorn задаёт файл.
- `--disable-access-log-for-endpoints`: фильтр строится, только если для uvicorn не загрузился файл из `pylogging_config_file`.
- `--enable-log-requests`: промпты пишутся лишь на уровне `DEBUG`; без него флаг логирует только идентификатор, параметры и LoRA.
- `--config`: ключ `logging-config` в YAML принимается так же, как флаг, и перекрывает переменные окружения.

## Типовые проблемы и диагностика

- **Симптом:** ошибка разбора `argument --logging-config` с текстом pydantic `Input should be 'CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG' or 'NOTSET'`. **Причина:** уровень в нижнем регистре или с опечаткой. **Лечение:** писать уровень заглавными буквами.
- **Симптом:** ошибка разбора с `Extra inputs are not permitted`. **Причина:** ключ, которого нет в `LoggingConfig` (например, `stream`). **Лечение:** поток и префикс задаются `VLLM_LOGGING_STREAM` и `VLLM_LOGGING_PREFIX`.
- **Симптом:** `RuntimeError: ('Could not load logging config. File does not exist: %s', '<путь>')` до загрузки модели. **Причина:** неверный `pylogging_config_file`, в том числе унаследованный из `VLLM_LOGGING_CONFIG_PATH`. **Лечение:** исправить путь.
- **Симптом:** `RuntimeError: Logging configuration is disabled, but a Python logging config file was given. pylogging_config_file requires configure_logging to be enabled.` **Причина:** `configure_logging: false` при заданном файле. **Лечение:** убрать одно из двух, проверив и окружение.
- **Симптом:** `--logging-config.log_level DEBUG` не дал отладочных строк. **Причина:** одновременно задан `pylogging_config_file`, и уровни берутся из файла; либо `--log-level` с другим значением. **Проверка:** `vllm serve --help=LoggingConfig` и итоговая команда инстанса.
- **Подтверждение принятого значения:** на `DEBUG` появляются строки уровня `DEBUG` от логгеров `vllm.*`; при собственном файле — формат из него.

## Примеры

```bash
vllm serve /models/Qwen3-4B --logging-config.log_level WARNING
```

```bash
vllm serve /models/Qwen3-4B --logging-config '{"log_level": "INFO", "pylogging_config_file": "/etc/vllm/log-config.json"}'
```

## Источники

- `vllm/vllm/config/logging.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/logger.py`
- `vllm/vllm/entrypoints/cli/main.py`
- `vllm/vllm/entrypoints/launchers/utils/server_utils.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/v1/utils.py`
- `vllm/vllm/config/compilation.py`
- `vllm/vllm/envs.py`
- `vllm/examples/features/logging_configuration.md`
- upstream-коммит `45d56c0ba` «[Core] Model console logging as CLI configuration (#57205)» в checkout'е
- `apps/api/src/process/log-parsers/vllm.ts` (arriero)
