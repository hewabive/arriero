---
schema: 1
primaryName: "load-on-startup"
title: "load-on-startup"
summary: "Preset-only ключ models-preset INI: загружает выбранную модель при старте или reload router-а, не являясь CLI-аргументом llama-server."
category: "Пресеты"
valueType: "boolean"
valueHint: null
controlKind: "toggle"
presetSupport: "preset-only"
aliases:
  - "load-on-startup"
allowedValues:
  - "true"
  - "false"
env:
  - "__PRESET_LOAD_ON_STARTUP"
related:
  - "--models-preset"
  - "--models-max"
  - "--models-autoload"
  - "stop-timeout"
---

# load-on-startup

## Кратко

`load-on-startup` - служебный ключ модельной секции `--models-preset`. Он не передается в argv дочернего `llama-server`: router читает его сам и решает, нужно ли сразу поднять эту модель при первом построении каталога.

В arriero этот ключ считается `model-managed`: он должен управляться отдельным переключателем модели, а не добавляться как произвольный extra argument.

## Оригинальная справка llama.cpp

В актуальном коде ключ объявлен как preset-only option:

```text
load-on-startup NAME
in server router mode, autoload this model on startup
```

README router-а описывает фактический формат как boolean:

```text
load-on-startup (boolean): Controls whether the model loads automatically when the server starts
```

## Паспорт аргумента

- Основное имя: `load-on-startup`
- Алиасы: `load-on-startup`
- Тип: boolean
- CLI-аргумент: нет
- Ключ INI: `load-on-startup`
- Pseudo-env ключ внутри `common_preset`: `__PRESET_LOAD_ON_STARTUP`
- Значение по умолчанию: отсутствует, модель остается unloaded до явной или автоматической загрузки
- Этап применения: построение router model mapping при первом `load()`
- arriero policy: управляется отдельным полем модели

## Что меняет в llama-server

При чтении `--models-preset` router строит набор `common_preset`. Обычные ключи из INI потом превращаются в argv дочернего сервера через `common_preset::to_args()`. Preset-only ключи работают иначе: они остаются в metadata router-а и пропускаются при генерации argv.

На первом построении списка моделей router проходит по mapping и проверяет `__PRESET_LOAD_ON_STARTUP`. Если значение truthy, имя модели добавляется в список стартовой загрузки. Затем router вызывает `load(name)` для каждой такой модели.

Truthy/falsey интерпретация идет через общий helper llama.cpp. Практически используйте явные значения:

- `load-on-startup = true`
- `load-on-startup = false`

## Пример

```ini
version = 1

[small-fast]
model = /srv/models/qwen2.5-0.5b-instruct-q4_k_m.gguf
ctx-size = 8192
load-on-startup = true

[large-on-demand]
model = /srv/models/gemma-4-31b-it-q4_k_m.gguf
ctx-size = 32768
load-on-startup = false
stop-timeout = 30
```

При запуске:

```bash
llama-server --models-preset /srv/llama/models.ini --models-max 1
```

`small-fast` будет загружена сразу. `large-on-demand` останется в каталоге моделей, но не займет RAM/VRAM до запроса или ручного `POST /models/load`.

## Взаимодействие с --models-max

`--models-max` ограничивает число одновременно загруженных моделей. На старте llama.cpp проверяет, сколько моделей имеют `load-on-startup = true`. Если это число больше `models_max`, router падает до начала обслуживания HTTP-запросов.

Для production-router это полезная защита: ошибка проявляется сразу, а не после первого пользовательского запроса. Для локального стенда с одной GPU обычно безопаснее иметь `--models-max 1` и только одну модель с `load-on-startup = true`.

Если `--models-max 0`, лимит отключен, но память все равно конечна. Несколько больших моделей с eager loading могут привести к OOM уже при старте.

## Взаимодействие с --models-autoload

`--models-autoload` управляет on-demand загрузкой модели при обычном inference-запросе. `load-on-startup` управляет eager loading при старте router-а.

Типовые режимы:

- `load-on-startup = true`, `--models-autoload` не важен для первой загрузки: модель поднимается сразу.
- `load-on-startup = false`, `--models-autoload`: модель загрузится при первом запросе к ней.
- `load-on-startup = false`, `--no-models-autoload`: модель нужно грузить явно через router API.

## Производительность и память

Включение `load-on-startup` переносит стоимость загрузки модели на старт router-а. Это увеличивает время запуска и сразу занимает RAM/VRAM, но первый пользовательский запрос не ждет загрузку весов.

Для маленьких embedding/rerank моделей eager loading часто удобен. Для больших chat-моделей на ограниченной GPU он может быть вреден: перезапуск менеджера или router-а будет долгим, а свободная VRAM исчезнет до реального запроса.

## Типовые проблемы

- Router не стартует: проверьте, не превышает ли число `load-on-startup = true` значение `--models-max`.
- Старт стал очень долгим: отключите eager loading у больших моделей и грузите их явно.
- Модель остается unloaded: проверьте, что ключ записан в правильной секции INI, а не в секции с опечаткой в имени модели.
- В arriero ключ не виден как extra argument: это ожидаемо, он управляется отдельным переключателем модели.

## Источники

- `llama.cpp/common/arg.cpp`: `common_params_add_preset_options()`
- `llama.cpp/common/arg.h`: pseudo-env `COMMON_ARG_PRESET_LOAD_ON_STARTUP`
- `llama.cpp/common/preset.cpp`: `common_preset::to_args()` пропускает preset-only options
- `llama.cpp/tools/server/server-models.cpp`: выбор моделей для startup load
- `llama.cpp/tools/server/README.md`: раздел Model presets
