---
schema: 1
primaryName: "--ui-config-file"
title: "--ui-config-file"
summary: "Файл с JSON-настройками Web UI по умолчанию. Содержимое читается на старте и обрабатывается как `--ui-config`."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "PATH"
aliases:
  - "--ui-config-file"
  - "--webui-config-file"
allowedValues: []
env:
  - "LLAMA_ARG_UI_CONFIG_FILE"
related:
  - "--ui"
  - "--ui-config"
---

# --ui-config-file

## Кратко

`--ui-config-file` вызывает `read_file(value)` в обработчике аргумента и кладет содержимое в единственное поле `ui_config_json`. JSON парсится позже, как у `--ui-config`. `--webui-config-file` — равноправный алиас (раньше был deprecated).

## Оригинальная справка llama.cpp

```text
JSON file that provides default UI settings (overrides UI defaults)
```

## Паспорт аргумента

- Основное имя: `--ui-config-file`
- Алиас: `--webui-config-file`
- Значение: путь к JSON-файлу
- Переменная окружения: `LLAMA_ARG_UI_CONFIG_FILE`
- Поле в `common_params`: `ui_config_json`
- Этап применения: чтение при парсинге CLI, парсинг JSON при инициализации server context

## Что меняет в llama-server

Файл читается один раз на старте. Если JSON невалиден, `server-context.cpp` логирует `failed to parse UI config` и модель не считается загруженной. Успешный JSON появляется в `GET /props` как `ui_settings`.

## Значения и формат

Файл должен содержать валидный JSON, обычно object. Относительный путь зависит от рабочего каталога процесса. Файл не перечитывается автоматически при изменении.

## Когда использовать

Используйте вместо `--ui-config`, когда JSON длинный, содержит кавычки или управляется системой конфигурации. Это более надежно для service unit и контейнеров.

## Влияние на производительность и память

На инференс не влияет. Чтение и парсинг выполняются на старте.

## Взаимодействие с другими аргументами

- `--webui-config-file` — алиас и делает то же самое.
- Если одновременно задан `--ui-config`, итог зависит от порядка обработки аргументов: оба пишут в одно поле, последнее примененное значение победит.
- `--ui` не обязан быть включен, чтобы настройки отображались в `/props`.

## INI-пресеты и router-режим

В INI: `ui-config-file = /etc/llama/ui.json`. В router-режиме настройки router-а возвращаются в router `/props`; дочерние процессы могут получать свои настройки через inherited args/presets.

## Типовые проблемы и диагностика

- Ошибка чтения файла: проверьте путь и права.
- `failed to parse UI config`: проверьте JSON валидатором.
- Изменили файл, но UI не поменялся: перезапустите сервер.

## Примеры

```bash
llama-server --model /models/model.gguf --ui-config-file /etc/llama/ui.json
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-models.h`
- `llama.cpp/tools/server/README.md`
