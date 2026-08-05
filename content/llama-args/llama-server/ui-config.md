---
schema: 1
primaryName: "--ui-config"
title: "--ui-config"
summary: "JSON-строка с настройками Web UI по умолчанию. Сервер парсит JSON при загрузке модели и публикует его в `/props` как `ui_settings`."
category: "Параметры llama-server"
valueType: "json"
estimation: "normal"
valueHint: "JSON"
aliases:
  - "--ui-config"
  - "--webui-config"
allowedValues: []
env:
  - "LLAMA_ARG_UI_CONFIG"
related:
  - "--ui"
  - "--ui-config-file"
---

# --ui-config

## Кратко

`--ui-config` записывает JSON-строку в единственное поле `common_params::ui_config_json`. Позже `server-context.cpp` парсит строку в `json_ui_settings`. `--webui-config` — равноправный алиас (раньше был deprecated).

## Оригинальная справка llama.cpp

```text
JSON that provides default UI settings (overrides UI defaults)
```

## Паспорт аргумента

- Основное имя: `--ui-config`
- Алиас: `--webui-config`
- Значение: JSON object string
- Переменная окружения: `LLAMA_ARG_UI_CONFIG`
- Поле в `common_params`: `ui_config_json`
- Этап применения: после загрузки модели, при подготовке props/UI metadata

## Что меняет в llama-server

Если JSON непустой, сервер вызывает `json::parse`. При ошибке логирует `failed to parse UI config: ...` и загрузка модели завершается неуспешно. Успешно распарсенный объект публикуется в `GET /props` как `ui_settings` (legacy-ключ `webui_settings` больше не отдается).

## Значения и формат

Передавайте валидный JSON. README приводит пример `{"pasteLongTextToFileLen": 0, "renderUserContentAsMarkdown": true}`. Доступные настройки находятся в UI source `tools/server/ui/src/lib/constants/settings-config.ts`.

## Когда использовать

Используйте для управляемых дефолтов UI: отключить attachment behavior, включить markdown rendering, задать предпочтения интерфейса для всех пользователей этого экземпляра.

## Влияние на производительность и память

На инференс не влияет. JSON парсится один раз при инициализации модели/router metadata.

## Взаимодействие с другими аргументами

- `--ui-config-file` читает JSON из файла в то же поле.
- `--webui-config` — алиас и пишет в то же поле; при повторе побеждает последнее примененное значение.
- `--ui` определяет, отдается ли встроенный UI, но `/props` с `ui_settings` доступен независимо от static UI.

## INI-пресеты и router-режим

В INI JSON нужно писать как значение `ui-config = {"key": true}` с учетом правил INI. В router-режиме router тоже парсит UI settings и возвращает их в router `/props`.

## Типовые проблемы и диагностика

- `failed to parse UI config`: проверьте кавычки и валидность JSON.
- Shell съедает кавычки: храните конфигурацию в `--ui-config-file`.
- Настройка не применяется: проверьте фактический `/props` и имя настройки в UI source.

## Примеры

```bash
llama-server --model /models/model.gguf --ui-config '{"pasteLongTextToFileLen":0,"renderUserContentAsMarkdown":true}'
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-models.h`
- `llama.cpp/tools/server/README.md`
