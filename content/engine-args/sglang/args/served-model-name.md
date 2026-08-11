---
schema: 1
engine: sglang
primaryName: "--served-model-name"
title: "--served-model-name"
summary: Публичное имя модели в /v1/models и пространство имен для внешнего хранилища HiCache. Не задан — становится равным --model-path целиком; двоеточие в значении запрещено, потому что зарезервировано под синтаксис LoRA.
group: serving
related:
  - --model-path
  - --tokenizer-path
  - --enable-lora
  - --weight-version
  - --hicache-storage-backend
  - --enable-hierarchical-cache
  - --chat-template
---

# --served-model-name

## Кратко

`--served-model-name` переопределяет имя, под которым модель видна в OpenAI-совместимом API. Если аргумент не задан, `_handle_missing_default_values` подставляет `served_model_name = model_path` — то есть публичным именем становится строка пути целиком, включая абсолютный путь с косыми чертами. Для локальной модели это почти всегда стоит перебить.

Два неочевидных момента. Первый: двоеточие в значении запрещено проверкой в `check_server_args`, потому что `model:adapter` — это синтаксис выбора LoRA-адаптера. Второй: то же значение используется как `model_name` при подключении внешнего бэкенда HiCache, то есть определяет пространство имен сохраненного префиксного кеша — смена имени обнуляет попадания в него.

## Оригинальная справка

```text
Override the model name returned by the v1/models endpoint in OpenAI API server.
```

## Паспорт аргумента

- Флаги: `--served-model-name`
- Группа: `serving`
- Тип значения: str (одно имя; списка, в отличие от vLLM, нет)
- Допустимые значения: `choices` нет. Единственное ограничение — отсутствие символа `:`, если значение не является URI объектного хранилища (`is_runai_obj_uri`)
- Значение по умолчанию: `None`
- Эффективное значение: **переопределяется всегда, когда не задано**. `__post_init__` → `_handle_missing_default_values` выполняет `if self.served_model_name is None: self.served_model_name = self.model_path`. Кроме того, значение меняется в рантайме: успешный `POST /update_weights_from_disk` вызывает `_update_model_path_info`, который присваивает `served_model_name = <новый model_path>`
- Где объявлен: `ServerArgs.served_model_name`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (подстановка дефолта) → `check_server_args` (проверка двоеточия) → HTTP-слой (`/v1/models`, ollama-маршруты) и подключение HiCache-хранилища

## Что меняет в движке

Значение читают четыре независимых потребителя.

1. **`GET /v1/models`.** Карточка модели собирается как `ModelCard(id=served_model_name, root=served_model_name, max_model_len=<context_len>)`. Если включен `--enable-lora`, к списку добавляются карточки адаптеров с `parent=served_model_name`.
2. **`GET /v1/models/{model}`.** Здесь имя проверяется: запрос с именем, не равным `served_model_name`, получает `404` с `code: "model_not_found"`.
3. **Прикладные endpoint'ы генерации — не проверяют имя вовсе.** В `serving_chat.py` поле `request.model` только возвращается обратно в ответе и разбирается функцией `_parse_model_parameter` на пару «базовая модель : адаптер» ради выбора LoRA. Никакого сравнения с `served_model_name` там нет. Практически это значит, что `/v1/chat/completions` с произвольным `model` отработает нормально — рассинхронизация имен молча не проявится в трафике и обнаружится только на `/v1/models`.
4. **Пространство имен HiCache.** `HiRadixCache` передает `model_name=server_args.served_model_name` в конструктор `cache_controller` и в `attach_storage_backend`. Для внешнего бэкенда хранения префиксного кеша это часть ключа: два сервера с разными `--served-model-name`, но одной и той же моделью, не увидят кеш друг друга; и наоборот, одинаковое имя при разных весах — путь к некорректным попаданиям.

Плюс имя используется ollama-совместимыми маршрутами (`entrypoints/ollama/serving.py`), gRPC-мостом (`entrypoints/grpc_bridge.py`) и в VLM-ветке штатного warmup-запроса.

## Значения и формат

- Произвольная строка без `:`. Нарушение дает `AssertionError: served_model_name cannot contain a colon (':') character. The colon is reserved for the 'model:adapter' syntax used in LoRA adapter specification. Invalid value: '<значение>'`.
- Исключение из запрета сделано только для URI объектного хранилища (`s3://`, `gs://`, `az://`) — такое значение может появиться, когда имя унаследовано от `--model-path`.
- Пробелы, слэши и не-ASCII формально допустимы, но становятся частью публичного идентификатора модели и частью ключа HiCache-хранилища. Держитесь короткого kebab-case.
- Пустая строка — ложное значение: `if self.served_model_name is None` ее не поймает, поэтому пустое имя доедет до `/v1/models` как есть. Не используйте.

## Когда использовать

- Всегда, когда `--model-path` — локальный каталог. Иначе клиенты будут вынуждены писать в поле `model` абсолютный путь вроде `/models/Qwen3-30B-A3B`.
- Всегда, когда включено внешнее хранилище HiCache и вы хотите управлять тем, какие серверы делят префиксный кеш.
- Не меняйте на живом сервере с уже прогретым внешним HiCache: смена имени равносильна сбросу кеша.
- Не пытайтесь через это имя «переключать модели» — это метка, а не выбор весов.

## Влияние на производительность и память

Прямого влияния на VRAM, RAM и скорость нет. Косвенное — через HiCache: несогласованное имя обнуляет попадания во внешнее хранилище префиксов, что видно как рост времени prefill на повторяющихся префиксах.

## Взаимодействие с другими аргументами

- `--model-path`: источник значения по умолчанию.
- `--enable-lora`: адаптеры адресуются синтаксисом `<served_model_name>:<adapter>`, отсюда и запрет двоеточия.
- `--hicache-storage-backend` / `--enable-hierarchical-cache`: имя входит в ключ внешнего хранилища.
- `--weight-version`: отдельная метка версии весов, в `/v1/models` не участвует; не путайте.
- `--tokenizer-path`: получает такой же дефолт из `--model-path`, но независимо от этого аргумента.
- `--chat-template`: шаблон выбирается по модели, а не по публичному имени.

## Типовые проблемы и диагностика

- **Симптом:** в `/v1/models` модель называется `/models/very/long/path`. **Причина:** сработал дефолт `served_model_name = model_path`. **Лечение:** задать имя явно.
- **Симптом:** `AssertionError: served_model_name cannot contain a colon (':')`. **Причина:** двоеточие в значении (частый случай — попытка записать `модель:тег` в стиле ollama). **Лечение:** убрать двоеточие.
- **Симптом:** `GET /v1/models/<имя>` возвращает 404, хотя `/v1/chat/completions` с тем же именем работает. **Причина:** это разное поведение по замыслу — генерация имя не проверяет, а `retrieve_model` проверяет. **Проверка:** сравните с выводом `GET /v1/models`.
- **Симптом:** после `POST /update_weights_from_disk` публичное имя поменялось само. **Причина:** `_update_model_path_info` присваивает `served_model_name = <новый model_path>`. **Лечение:** учитывать это при горячей подмене весов.
- **Симптом:** внешний HiCache перестал давать попадания. **Причина:** сменилось `--served-model-name`, а с ним и пространство имен. **Подтверждение:** строка `server_args=` в логе старта и метрики HiCache-хранилища.

## В arriero

Для kind `ktransformers` этот флаг **запрещен в сыром `args`**. Ключ `--served-model-name` входит в `KTRANSFORMERS_RESERVED_ARG_KEYS` (`packages/core/src/instance.ts`) вместе с `--model`, `--model-path`, `--kt-weight-path` и `--kt-method`; схема инстанса отклоняет его сообщением «is managed by KTransformers engine config». Значение задается типизированным полем `engineConfig.servedModelName` и подставляется в командную строку сборщиком снапшота запуска (`apps/api/src/process/launch-snapshot.ts`).

Дальше это же значение определяет идентификатор модели в прокси: `impliedInstanceModelId` (`packages/core/src/instance-model.ts`) для kind `ktransformers` возвращает `engineConfig.servedModelName`, а при его отсутствии — последний сегмент локального пути модели либо HF repo id целиком. Это имя предлагается как модель цели прокси и используется формой инстанса при переименовании.

Практика: заполняйте поле «served model name» в форме инстанса всегда, когда модель задана локальным путем, — иначе имя цели прокси получится из последнего сегмента пути и может неожиданно совпасть с именем другого инстанса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --served-model-name qwen3-30b-a3b --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --served-model-name deepseek-v3 --enable-hierarchical-cache --hicache-storage-backend file
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_base.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/mem_cache/hiradix_cache.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- arriero: `packages/core/src/instance.ts`, `packages/core/src/instance-model.ts`, `docs/KTRANSFORMERS_SUPPORT.md`, `docs/API_PROXY_FOUNDATION.md`
