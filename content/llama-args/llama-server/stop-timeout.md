---
schema: 1
primaryName: "stop-timeout"
title: "stop-timeout"
summary: "Preset-only ключ models-preset INI: задает, сколько секунд router ждет graceful shutdown дочернего llama-server перед принудительным завершением."
category: "Пресеты"
valueType: "number"
valueHint: "SECONDS"
presetSupport: "preset-only"
aliases:
  - "stop-timeout"
allowedValues: []
env:
  - "__PRESET_STOP_TIMEOUT"
related:
  - "--models-preset"
  - "--models-max"
  - "--models-autoload"
  - "load-on-startup"
---

# stop-timeout

## Кратко

`stop-timeout` - служебный ключ модельной секции `--models-preset`. Он задает, сколько секунд router будет ждать штатного завершения дочернего процесса модели после запроса на unload/stop. Если процесс не завершился за это время, router принудительно его убивает.

Это не CLI-аргумент. В INI он пишется без ведущих дефисов:

```ini
[gemma-large]
model = /srv/models/gemma-4-31b-it-q4_k_m.gguf
stop-timeout = 30
```

## Оригинальная справка llama.cpp

В актуальном коде ключ объявлен как preset-only option:

```text
stop-timeout SECONDS
in server router mode, force-kill model instance after this many seconds of graceful shutdown
```

README router-а уточняет значение по умолчанию:

```text
After requested unload, wait for this many seconds before forcing termination (default: 10)
```

## Паспорт аргумента

- Основное имя: `stop-timeout`
- Алиасы: `stop-timeout`
- Тип: number
- Единицы: секунды
- CLI-аргумент: нет
- Ключ INI: `stop-timeout`
- Pseudo-env ключ внутри `common_preset`: `__PRESET_STOP_TIMEOUT`
- Значение по умолчанию: `10`
- Этап применения: metadata модели в router mode, используется при остановке дочернего процесса
- arriero policy: можно добавлять в модельную секцию preset как extra argument

## Что меняет в llama-server

Router запускает отдельный дочерний `llama-server` для загруженной модели. При выгрузке модели или при замещении по LRU (`--models-max`) router сначала просит процесс завершиться штатно. Мониторинговый поток ждет завершения дочернего процесса до `stop-timeout * 1000` миллисекунд. Если лимит истек, в лог пишется warning вида `force-killing model instance ... after N seconds timeout`, затем процесс убивается принудительно.

Ключ читается из `common_preset` после построения model mapping. Если значение не парсится как integer, llama.cpp пишет warning `invalid stop-timeout value ... using default 10 seconds` и возвращается к дефолту.

## Когда увеличивать

Увеличивайте `stop-timeout`, если:

- большая модель долго выгружается и часто получает force-kill в логах;
- на машине медленный диск, тяжелый backend или много памяти под KV/cache;
- нужно уменьшить риск грубого завершения процесса во время диагностики;
- router часто переключает большие модели из-за `--models-max 1`.

Практичные стартовые значения:

- маленькие модели: `10`
- средние локальные chat-модели: `15-30`
- большие GPU-модели с долгой выгрузкой: `30-60`

## Когда уменьшать

Уменьшайте значение осторожно. Слишком маленький timeout быстрее освобождает слот router-а, но увеличивает шанс принудительного kill. Для локальной диагностики это может скрыть настоящую причину зависания shutdown, потому что процесс будет убит до того, как допечатает полезный лог.

Очень большое значение тоже вредно: зависший дочерний сервер будет дольше удерживать RAM/VRAM и порт, а загрузка следующей модели может ждать освобождения ресурсов.

## Взаимодействие с --models-max и LRU

Если `--models-max` ограничивает число активных моделей, router может выгружать least recently used модель перед загрузкой новой. `stop-timeout` влияет на то, сколько времени router готов ждать завершения этой выгрузки.

При частом переключении больших моделей слишком короткий timeout даст шумные warning-и и force-kill. Слишком длинный timeout сделает переключение моделей медленным.

## Взаимодействие с ручной выгрузкой

Через router API модель можно выгружать явно. В этом случае `stop-timeout` работает так же: сначала graceful shutdown, затем force-kill после лимита.

Для UI arriero это важно при кнопках unload/restart: пользователь может видеть задержку не из-за зависания менеджера, а из-за ожидаемого graceful timeout модели.

## Пример

```ini
version = 1

[*]
ctx-size = 8192

[fast-small]
model = /srv/models/qwen2.5-0.5b-instruct-q4_k_m.gguf
stop-timeout = 10

[large-gpu]
model = /srv/models/gemma-4-31b-it-q4_k_m.gguf
n-gpu-layers = auto
stop-timeout = 45
```

Запуск router-а:

```bash
llama-server --models-preset /srv/llama/models.ini --models-max 1 --no-models-autoload
```

В таком режиме `large-gpu` не будет загружаться автоматически, но при ручной смене активной модели router будет ждать до 45 секунд перед принудительным завершением ее дочернего процесса.

## Типовые проблемы

- `invalid stop-timeout value`: в INI записано нецелое значение, пустая строка или строка с лишними символами.
- `force-killing model instance`: shutdown не уложился в timeout. Увеличьте значение и проверьте, что процесс не зависает на backend/driver уровне.
- Долго освобождается VRAM: timeout слишком большой или дочерний процесс реально зависает при завершении.
- Ключ не находится в `llama-server --help`: это ожидаемо для preset-only options, они объявлены в коде отдельно от обычных CLI-аргументов.

## Источники

- `llama.cpp/common/arg.cpp`: `common_params_add_preset_options()`
- `llama.cpp/common/arg.h`: pseudo-env `COMMON_ARG_PRESET_STOP_TIMEOUT`
- `llama.cpp/common/preset.cpp`: `common_preset::to_args()` пропускает preset-only options
- `llama.cpp/tools/server/server-models.cpp`: `apply_stop_timeout()` и force-kill monitoring
- `llama.cpp/tools/server/README.md`: раздел Model presets
