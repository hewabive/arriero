---
schema: 1
engine: vllm
primaryName: "--log-level"
title: "--log-level"
summary: Уровень встроенного логирования vLLM — короткая форма `--logging-config.log_level`, перекрывающая её. Заменяет переменную `VLLM_LOGGING_LEVEL`, которая остаётся только значением по умолчанию; на uvicorn и на собственный файл `dictConfig` не действует.
group: LoggingConfig
related:
  - --logging-config
  - --log-config-file
  - --uvicorn-log-level
  - --enable-log-requests
  - --max-log-len
  - --disable-log-stats
---

# --log-level

## Кратко

`--log-level` задаёт поле `log_level` конфига `LoggingConfig` — уровень обработчика и логгера `vllm` во встроенной конфигурации логирования. Это самый короткий способ включить `DEBUG` на время расследования или, наоборот, приглушить информационные сообщения. Раньше для этого была только переменная окружения `VLLM_LOGGING_LEVEL`; теперь она лишь значение по умолчанию.

Флаг действует на встроенный `dictConfig`. Если задан собственный файл (`--logging-config.pylogging_config_file`, устаревший `--log-config-file` или `VLLM_LOGGING_CONFIG_PATH`), файл заменяет встроенную конфигурацию целиком, и уровни берутся из него.

## Оригинальная справка

```text
Shortcut for --logging-config.log_level. Overrides that field if both are specified.
```

## Паспорт аргумента

- Флаги: `--log-level`
- Группа argparse: `LoggingConfig`
- Тип значения: строка
- Допустимые значения: `CRITICAL`, `ERROR`, `WARNING`, `INFO`, `DEBUG`, `NOTSET` — настоящие `choices` argparse из `get_args(LogLevel)` (`vllm/config/logging.py`). Регистр важен
- Значение по умолчанию: `argparse.SUPPRESS` — без флага атрибута в namespace нет, и уровень берётся из `--logging-config`, а при его отсутствии из `VLLM_LOGGING_LEVEL` (по умолчанию `INFO`)
- Эффективное значение: перекрывает `log_level` из `--logging-config` (`dataclasses.replace` в `EngineArgs.create_logging_config()` и `replace` в `configure_logging_from_args`)
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: сразу после разбора CLI (`configure_logging_from_args`) → `VllmConfig.logging_config` → повторное применение в процессах engine core, worker'ов и API-сервера

## Что меняет в движке

`_configure_vllm_root_logger` (`vllm/logger.py`) при включённом `configure_logging` копирует встроенный `DEFAULT_LOGGING_CONFIG` и выставляет `log_level` в трёх местах: уровень обработчика `vllm`, уровень логгера `vllm` и поле `log_level` форматтеров. При значении `INFO` дополнительно поднимает логгеры `httpx` и `httpx2` до `WARNING`, чтобы обращения к Hugging Face Hub не засоряли лог.

Итоговый `LoggingConfig` уходит в `VllmConfig.logging_config`, и тот же уровень применяют процессы engine core, worker'ы `multiproc_executor` и процессы API-сервера при `--api-server-count > 1`.

Уровень проверяют и потребители: `RequestLogger` смотрит `logger.isEnabledFor(logging.DEBUG)` и при более высоком уровне пишет сообщение с подсказкой `` To view more details, set `--log-level DEBUG`. ``

Что флаг **не** меняет: включение runtime-assert'ов inductor на torch младше 2.12 (`vllm/config/compilation.py`) по-прежнему смотрит на `envs.VLLM_LOGGING_LEVEL == "DEBUG"`, то есть на переменную окружения, а не на этот флаг.

## Значения и формат

- Одно из шести имён заглавными буквами: `--log-level DEBUG`. Нижний регистр argparse отвергает как `invalid choice`.
- `NOTSET` не означает «всё подряд»: логгер `vllm` с уровнем `NOTSET` наследует эффективный уровень от корневого логгера, а встроенная конфигурация корневой не трогает, так что по умолчанию это `WARNING`.
- Без флага действует `--logging-config.log_level`, затем `VLLM_LOGGING_LEVEL`.

## Когда использовать

- `DEBUG` — на время расследования: строки `Request ... details` у `--enable-log-requests`, отладочные сообщения загрузчиков и планировщика. На сервере, доступном не только с localhost, `DEBUG` вместе с `--enable-log-requests` пишет промпты в лог.
- `WARNING` — когда информационные строки мешают. Учтите, что в arriero индикатор старта инстанса строится по INFO-строкам vLLM (процент загрузки весов, инициализация KV-cache, захват CUDA graphs): на `WARNING` этапов не будет, останется только переход в готовность по строке uvicorn `Application startup complete.` Ошибки и предупреждения по-прежнему распознаются.
- Не используйте для приглушения access-лога: это `--uvicorn-log-level`, `--disable-uvicorn-access-log` и `--disable-access-log-for-endpoints`.
- Если команда уже задаёт собственный файл `dictConfig`, меняйте уровни в файле — флаг там не действует.

## Влияние на производительность и память

На VRAM и throughput не влияет. На `DEBUG` объём лога растёт на порядки, и вместе с `--enable-log-requests` в него попадает полный текст промптов — диск и утечка данных. Повышение уровня выше `INFO` сокращает лог, но не ускоряет инференс заметно: периодическая статистика выключается отдельно, `--disable-log-stats`.

## Взаимодействие с другими аргументами

- `--logging-config`: полный конфиг; поле `log_level` этот флаг перекрывает, а `pylogging_config_file` из него делает флаг бессильным.
- `--log-config-file`: устаревший путь к тому же файлу `dictConfig`; при заданном файле уровень берётся из файла.
- `--uvicorn-log-level`: отдельный уровень для логгеров uvicorn; `--log-level` их не затрагивает.
- `--enable-log-requests`: промпты пишутся только на `DEBUG`.
- `--max-log-len`: обрезает промпты в DEBUG-строках `RequestLogger`.
- `--disable-log-stats`: периодическая статистика пишется на `INFO`; на `WARNING` и выше её строк не видно, даже если флаг не задан.

## Типовые проблемы и диагностика

- **Симптом:** `argument --log-level: invalid choice: 'debug'`. **Причина:** регистр. **Лечение:** `--log-level DEBUG`.
- **Симптом:** `--log-level DEBUG`, а отладочных строк нет. **Причина:** задан собственный файл конфигурации (в том числе через `VLLM_LOGGING_CONFIG_PATH`) либо `--logging-config.configure_logging false`. **Проверка:** окружение инстанса и итоговая команда.
- **Симптом:** строка `` `--enable-log-requests` is set but the minimum log level is higher than DEBUG. `` **Причина:** уровень `INFO` или выше. **Лечение:** `--log-level DEBUG`, взвесив риск утечки промптов.
- **Симптом:** в arriero индикатор старта не показывает этапы загрузки. **Причина:** уровень `WARNING` или выше. **Лечение:** вернуть `INFO`, если нужен прогресс старта.
- **Подтверждение принятого значения:** на `DEBUG` появляются строки уровня `DEBUG` от логгеров `vllm.*`; список допустимых значений установленной версии — `vllm serve --help=LoggingConfig`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --log-level DEBUG --enable-log-requests --max-log-len 200
```

```bash
vllm serve /models/Qwen3-4B --log-level WARNING --uvicorn-log-level warning
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/logging.py`
- `vllm/vllm/logger.py`
- `vllm/vllm/entrypoints/cli/main.py`
- `vllm/vllm/entrypoints/serve/utils/request_logger.py`
- `vllm/vllm/config/compilation.py`
- `vllm/vllm/envs.py`
- `vllm/examples/features/logging_configuration.md`
- upstream-коммит `45d56c0ba` «[Core] Model console logging as CLI configuration (#57205)» в checkout'е
- `apps/api/src/process/log-parsers/vllm.ts` (arriero)
