---
schema: 1
engine: sglang
primaryName: "--log-level"
title: "--log-level"
summary: Уровень корневого логгера во всех процессах сервера и, если не задан --log-level-http, уровень HTTP-слоя. Словари допустимых значений у этих двух потребителей разные, поэтому безопасен только набор critical/error/warning/info/debug.
group: observability
related:
  - --log-level-http
  - --log-requests
  - --log-requests-target
  - --uvicorn-access-log-exclude-prefixes
  - --decode-log-interval
  - --enable-metrics
  - --tokenizer-worker-num
---

# --log-level

## Кратко

Значение попадает в `logging.basicConfig(level=...)` — сначала в `prepare_server_args` (чтобы предупреждения из `__post_init__` уже были отформатированы), затем в `configure_logger` в каждом порожденном процессе: tokenizer, scheduler на каждом TP/DP-ранге, detokenizer, DP-контроллер, multi-tokenizer-воркеры. Это единственный общий выключатель громкости движка.

Две вещи, которые ломают ожидания:

1. Тот же самый строковый литерал уходит в uvicorn/Granian, если не задан `--log-level-http`, а у uvicorn собственный словарь имен уровней. Значение, законное для `logging`, может уронить HTTP-сервер **после** загрузки модели.
2. `--log-requests` этому уровню не подчиняется: логгеры запросов создаются отдельно, с фиксированным уровнем INFO и `propagate=False` (`sglang/python/sglang/srt/utils/log_utils.py`). Заглушить логирование запросов через `--log-level error` нельзя.

## Оригинальная справка

```text
The logging level of all loggers.
```

## Паспорт аргумента

- Флаги: `--log-level`
- Группа: `observability`
- Тип значения: str
- Допустимые значения: `choices` нет. Фактически строка должна быть именем атрибута модуля `logging` в верхнем регистре (`getattr(logging, value.upper())`) **и одновременно** ключом словаря `uvicorn.config.LOG_LEVELS`, если `--log-level-http` не задан. Пересечение: `critical`, `error`, `warning`, `info`, `debug`
- Значение по умолчанию: `info`
- Эффективное значение: из CLI не переопределяется. Исключения — офлайновый Python-класс `Engine` (не CLI): если `log_level` не передан в kwargs, он подставляет `error`; и переменная окружения `SGLANG_LOGGING_CONFIG_PATH`, при которой `configure_logger` целиком уходит в `logging.config.dictConfig` и аргумент перестает что-либо значить
- Где объявлен: `ServerArgs.log_level`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI (`prepare_server_args`) → `configure_logger` в каждом процессе → запуск uvicorn/Granian

## Что меняет в движке

`configure_logger` (`sglang/python/sglang/srt/utils/common.py`) делает три вещи:

1. `logging.basicConfig(level=..., format=f"[%(asctime)s{prefix}] %(message)s", force=True)`. Обратите внимание на формат: **имени уровня в строке нет**. Строка `WARNING` от движка выглядит в логе ровно как строка `INFO` — отличить их по тексту файла невозможно.
2. Глушит `httpx`/`httpcore` до `WARNING` и `flashinfer.jit` до `ERROR` независимо от заданного уровня.
3. `suppress_other_loggers()` дополнительно опускает логгеры vLLM, если пакет установлен.

`prefix` в формате — это идентификатор ранга: в scheduler-процессах туда попадают `DP…`, `TP…`, `EP…` (`sglang/python/sglang/srt/managers/scheduler.py`), поэтому при `--tp-size > 1` строки одного процесса узнаются по префиксу.

HTTP-слой форматируется иначе: `set_uvicorn_logging_configs` ставит uvicorn формат `[%(asctime)s] %(levelprefix)s %(message)s`, то есть у строк uvicorn имя уровня есть, а у строк движка — нет.

Что видно на каких уровнях:

- `debug` — дополнительная детализация подсистем (планировщик, кеш, backend'ы внимания); объем на порядок больше, чем на `info`.
- `info` (по умолчанию) — итоговый дамп `server_args=` при старте (`_launch_subprocesses`, `sglang/python/sglang/srt/entrypoints/engine.py`), выбранный backend, размер KV-пула, периодические строки `Prefill batch` / `Decode batch` (частота — `--decode-log-interval`), access-лог uvicorn.
- `warning` — дамп `server_args=` пропадает, вместе с ним пропадает и access-лог uvicorn (если `--log-level-http` не задан); остаются предупреждения о deprecated-флагах и автоподборе значений в `__post_init__`.
- `error` и выше — практически немой сервер; диагностировать по логу становится нечем.

Уровень можно менять на живом сервере: `POST /configure_logging` с телом `{"log_level": "debug"}` вызывает `logging.getLogger().setLevel(...)` в tokenizer-процессе и рассылает запрос в scheduler и detokenizer (`sglang/python/sglang/srt/managers/tokenizer_manager.py`, `configure_logging.py`). Уровень HTTP-слоя таким образом не меняется.

## Значения и формат

- Регистр не важен для `logging` (`value.upper()`), но важен для uvicorn: там ключи только в нижнем регистре.
- `warn` и `fatal` — валидные атрибуты `logging` (`logging.WARN`, `logging.FATAL`), но их **нет** в `LOG_LEVELS` uvicorn. Итог: аргументы разбираются, модель грузится несколько минут, а потом сервер падает при старте HTTP. Проверить словарь uvicorn на своей сборке: `python -c "from uvicorn.config import LOG_LEVELS; print(list(LOG_LEVELS))"`.
- `trace` — обратная ситуация: uvicorn такой уровень знает, а `logging.TRACE` не существует, и падение происходит сразу на разборе аргументов (`AttributeError` в `prepare_server_args`).
- Опечатка в имени уровня — `AttributeError: module 'logging' has no attribute '...'` до создания `ServerArgs`.
- Миллисекунды в отметке времени добавляет переменная окружения `SGLANG_LOG_MS=1`, а не этот аргумент.

## Когда использовать

- `--log-level debug` — разовая диагностика старта, выбора backend'а внимания или поведения планировщика; на постоянной основе на управляемом инстансе не держите, лог растет быстро и вместе с ним растет вероятность ложного `degraded` (см. ниже).
- Понижать до `warning` осмысленно только на внешнем сервере с собственным сбором метрик. На управляемом arriero-инстансе это лишает вас строки `server_args=`, по которой проверяется, что аргументы вообще приняты, и строк с размером KV-пула.
- Не используйте `--log-level` для того, чтобы спрятать содержимое запросов: за это отвечает `--log-requests`, и он этому уровню не подчиняется.

## Влияние на производительность и память

На VRAM и на скорость forward не влияет. На `debug` заметны две вещи: рост объема записи в файл лога (десятки мегабайт в час под нагрузкой) и накладные расходы на форматирование строк в горячем пути планировщика. На `info` и выше это шум на уровне погрешности.

## Взаимодействие с другими аргументами

- `--log-level-http`: если задан, полностью перекрывает `--log-level` для uvicorn/Granian — и заодно снимает проблему несовместимых словарей уровней.
- `--log-requests` и `--log-requests-target`: не подчиняются `--log-level` вовсе (отдельные логгеры, уровень INFO, `propagate=False`).
- `--uvicorn-access-log-exclude-prefixes`: фильтрует access-лог по пути; работает только пока access-лог вообще включен уровнем (`info`/`debug`).
- `--decode-log-interval`: определяет, как часто печатается строка `Decode batch` на уровне INFO.
- `--enable-metrics`: альтернативный канал наблюдаемости, от уровня логов не зависит.
- `--tokenizer-worker-num` > 1: uvicorn запускается с несколькими воркерами, и в `LOGGING_CONFIG` дополнительно регистрируется логгер `sglang.srt.entrypoints.http_server` с жестко зашитым уровнем `INFO`.

## Типовые проблемы и диагностика

- **Симптом:** модель загрузилась, а процесс упал с `KeyError: 'warn'` (или другого имени) в момент старта HTTP. **Причина:** значение законно для `logging`, но неизвестно uvicorn. **Лечение:** `--log-level warning` либо разнести уровни через `--log-level-http`.
- **Симптом:** `AttributeError: module 'logging' has no attribute 'TRACE'` сразу при запуске. **Причина:** уровень из словаря uvicorn задан общим аргументом. **Лечение:** `--log-level-http trace` вместо `--log-level trace`.
- **Симптом:** задан `--log-level error`, а в лог все равно идут промпты. **Причина:** это `--log-requests`, у него свой логгер с уровнем INFO. **Лечение:** убрать `--log-requests`.
- **Симптом:** в логе не найти, приняты ли аргументы. **Причина:** уровень выше `info`, а дамп `server_args=` пишется через `logger.info`. **Лечение:** вернуть `info` или запросить `GET /server_info`.
- **Проверка принятого значения:** строка `server_args=` при старте содержит `log_level=`.

## В arriero

- Разбор лога (`apps/api/src/process/log-parsers/sglang.ts`) классифицирует строки **только по тексту**: ошибкой считается любая строка с `error`, `fatal`, `failed`, `exception`, `traceback`, `out of memory`, `oom`, предупреждением — с `warn`/`warning`. Поскольку формат SGLang не печатает имя уровня, соответствия между уровнем Python-логгера и классификацией arriero нет вообще: безобидная INFO-строка со словом `failed` считается ошибкой, а настоящий `logger.warning` без этих слов — нет.
- Любая непустая коллекция ошибок или предупреждений в последней 1000 строк отфильтрованного лога переводит здоровый инстанс в состояние `degraded` (`apps/api/src/process/health-summary.ts`), даже когда `/health` отвечает 200. Поэтому `--log-level debug` на управляемом инстансе почти гарантированно окрашивает карточку в `degraded`.
- Менеджер опрашивает `GET /health` и `GET /v1/models` (`apps/api/src/process/engine-probe.ts`). На уровне `info` каждая проба оставляет строку access-лога uvicorn; фильтр рутинных проб arriero (`apps/api/src/process/log-filter.ts`) рассчитан на формат llama.cpp (`done request: …`) и строки uvicorn не убирает. Чистить их надо на стороне движка — `--uvicorn-access-log-exclude-prefixes /health /v1/models`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-level info
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-level debug --log-level-http warning
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/utils/log_utils.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/configure_logging.py`
- arriero: `apps/api/src/process/log-parsers/sglang.ts`, `apps/api/src/process/log-filter.ts`, `apps/api/src/process/health-summary.ts`, `apps/api/src/process/engine-probe.ts`
