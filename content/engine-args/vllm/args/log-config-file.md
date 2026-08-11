---
schema: 1
engine: vllm
primaryName: "--log-config-file"
title: "--log-config-file"
summary: Путь к JSON-конфигурации логирования. В этом коммите значение применяется к uvicorn, а логи самого vLLM настраиваются переменной VLLM_LOGGING_CONFIG_PATH.
group: Frontend
related:
  - --disable-access-log-for-endpoints
  - --uvicorn-log-level
  - --disable-uvicorn-access-log
---

# --log-config-file

## Кратко

Аргумент указывает файл в формате `logging.config.dictConfig`, сериализованный в **JSON** (не YAML). Загруженный словарь передается uvicorn как `log_config`.

Справка обещает «for both vllm and uvicorn», но фактически в коде значение читается один раз — в `get_uvicorn_log_config()`, то есть только для uvicorn. Логирование самого vLLM конфигурируется на импорте из переменной окружения `VLLM_LOGGING_CONFIG_PATH`; она же служит значением по умолчанию для этого аргумента. Практический вывод: чтобы переконфигурировать оба слоя, задавайте переменную окружения, а не только флаг.

## Оригинальная справка

```text
Path to logging config JSON file for both vllm and uvicorn
```

## Паспорт аргумента

- Флаги: `--log-config-file`
- Группа argparse: `Frontend`
- Тип значения: str (путь), допускается `None`
- Допустимые значения: путь к JSON-файлу со схемой `dictConfig`
- Значение по умолчанию: `envs.VLLM_LOGGING_CONFIG_PATH`, то есть значение переменной окружения (обычно `None`)
- Эффективное значение: применяется к uvicorn; при ошибке чтения тихо деградирует к настройкам uvicorn по умолчанию (`load_log_config` перехватывает исключение и пишет предупреждение)
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.log_config_file`
- Этап применения: HTTP-слой, `build_and_serve()` перед `serve_http()`

## Что меняет в движке

`get_uvicorn_log_config(args)` работает по приоритету:

1. если `log_config_file` задан и файл успешно разобран — используется он;
2. иначе, если задан `--disable-access-log-for-endpoints`, строится конфигурация с фильтром путей;
3. иначе возвращается `None` и uvicorn берет собственные настройки.

Ошибка чтения не останавливает старт: `load_log_config` ловит любое исключение и логирует `Failed to load log config from file %s: error %s`, после чего конфигурация считается отсутствующей. Опечатка в пути не заметна, если не смотреть лог.

Поведение для логов vLLM другое и строже: при непустой `VLLM_LOGGING_CONFIG_PATH` модуль `vllm/logger.py` требует существования файла и падает с `RuntimeError`, если его нет, а также требует включенной `VLLM_CONFIGURE_LOGGING`.

## Значения и формат

- Только JSON: файл читается через `json.load`, YAML не поддерживается.
- Схема — стандартный `dictConfig` с обязательным `"version": 1`.
- Для uvicorn обычно описывают логгеры `uvicorn`, `uvicorn.error`, `uvicorn.access`; за образец удобно взять словарь, который строит `create_uvicorn_log_config` в `vllm/logging_utils/access_log_filter.py`.
- Пакет `python-json-logger` входит в зависимости vLLM, поэтому конфигурация с JSON-форматтером работает без дополнительной установки.

## Когда использовать

- Когда логи инстанса должны уходить в структурированном виде (JSON) в сборщик.
- Когда нужен фильтр сложнее точного списка путей из `--disable-access-log-for-endpoints`.
- Не используйте ради простого приглушения опроса здоровья: точный список путей решает задачу и не отключается молча при опечатке.
- В arriero помните, что stdout и stderr управляемого процесса пишутся в файлы `runtime/logs/`, а панель логов и подсчет ошибок разбирают именно эти строки. Экзотический формат сообщений ухудшит распознавание готовности и ошибок.

## Влияние на производительность и память

Определяется самой конфигурацией: синхронная запись в файл или в сеть на каждый запрос может стать заметной под нагрузкой. Сам аргумент стоимости не имеет.

## Взаимодействие с другими аргументами

- `--disable-access-log-for-endpoints`: **не** применяется, если файл конфигурации загрузился.
- `--uvicorn-log-level`: значение все равно передается в `uvicorn.Config`, но уровни логгеров из файла имеют приоритет.
- `--disable-uvicorn-access-log`: конфигурация из файла задает обработчики целиком и может вернуть access-лог, который вы отключали флагом.

## Типовые проблемы и диагностика

- **Симптом:** формат логов не изменился. **Причина:** файл не прочитался. **Проверка:** строка `Failed to load log config from file ...` в начале лога.
- **Симптом:** формат uvicorn изменился, а сообщения vLLM остались прежними. **Причина:** ожидаемое поведение — флаг влияет только на uvicorn. **Лечение:** задать `VLLM_LOGGING_CONFIG_PATH` (это же значение станет и дефолтом флага).
- **Симптом:** процесс падает на старте с `Could not load logging config. File does not exist`. **Причина:** это проверка `VLLM_LOGGING_CONFIG_PATH`, а не флага. **Лечение:** исправить путь в переменной окружения.
- **Симптом:** фильтр путей опроса перестал работать после добавления файла. **Причина:** приоритет файла в `get_uvicorn_log_config()`. **Лечение:** перенести фильтр внутрь конфигурации.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --log-config-file /etc/vllm/log-config.json
```

```bash
VLLM_LOGGING_CONFIG_PATH=/etc/vllm/log-config.json vllm serve /models/Qwen3-4B --host 127.0.0.1
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `vllm/vllm/logging_utils/access_log_filter.py`
- `vllm/vllm/logger.py`
- `vllm/requirements/common.txt`
