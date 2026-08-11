---
schema: 1
engine: sglang
primaryName: "--weight-version"
title: "--weight-version"
summary: Произвольная метка версии весов. На вычисления не влияет: попадает в `/model_info`, в `meta_info` каждого ответа и в `metadata.weight_version` нестриминговых OpenAI-ответов. Меняется на лету через `/update_weight_version` и при горячей замене весов.
group: serving
related:
  - --served-model-name
  - --model-path
  - --revision
  - --load-format
  - --checkpoint-engine-wait-weights-before-ready
---

# --weight-version

## Кратко

Это метка, а не настройка. SGLang нигде её не интерпретирует — только отдает наружу, чтобы клиент мог понять, каким набором весов сгенерирован конкретный ответ. Смысл появляется на инстансах с горячей заменой весов (RL-обучение, checkpoint engine), где `--model-path` остается прежним, а веса под ним меняются.

Особенность, которую надо знать: значение **изменяемо в рантайме**, поэтому объявленный дефолт `default` — это только стартовая точка, а не константа на весь срок жизни процесса.

## Оригинальная справка

```text
Version identifier for the model weights. Defaults to 'default' if not specified.
```

## Паспорт аргумента

- Флаги: `--weight-version`
- Группа: `serving`
- Тип значения: строка, произвольная
- Допустимые значения: `choices` нет; формат не проверяется
- Значение по умолчанию: `default`
- Эффективное значение: `__post_init__` не переопределяет, но значение перекрывается control-plane overlay'ем `TokenizerManager` — `config_value("weight_version")` сначала смотрит записи `record_config_updates` (в обратном порядке) и только потом читает `server_args`
- Где объявлен: `ServerArgs.weight_version`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: HTTP-слой (`/model_info`) и сборка `meta_info` каждого ответа; на загрузку весов и на forward не влияет

## Что меняет в движке

### Где значение видно

- `GET /model_info` — поле `weight_version`, читается как `tokenizer_manager.config_value("weight_version")`. Устаревший алиас `GET /get_model_info` печатает предупреждение и отдает тот же ответ.
- `meta_info` каждого ответа генерации (`TokenizerManager._handle_batch_output`): `"weight_version": self.config_value("weight_version")`.
- Нестриминговые OpenAI-ответы: `ChatCompletionResponse(..., metadata={"weight_version": ret[0]["meta_info"]["weight_version"]})`, аналогично в `CompletionResponse`. **В стриминге этого поля нет** — у `ChatCompletionStreamResponse` и `CompletionStreamResponse` поля `metadata` вообще не объявлено.
- Нативный gRPC отдает его в своем описании модели (`grpc_bridge.py`).
- Отдельных эндпоинтов `GET /weight_version` и `GET /get_weight_version` больше нет: они отвечают `404` с текстом «is deprecated. Please use '/model_info' instead.»

### Как меняется в рантайме

Два пути, оба через `record_config_updates`, который складывает изменения в список overlay'ев:

1. `POST /update_weight_version` с телом `{"new_version": "...", "abort_all_requests": true}`. По умолчанию перед сменой прерываются все выполняющиеся запросы. Ответ — `{"success": true, "message": "Weight version updated to <...>", "new_version": "<...>"}`.
2. Горячая замена весов: `update_weights_from_disk` / `from_distributed` / `from_tensor` принимают необязательное поле `weight_version` и при успехе обновляют метку, дописывая к сообщению «Weight version updated to <...>».

`record_config_updates` проверяет, что имя поля существует в `ServerArgs`, — иначе `ValueError` про «phantom config entry». `weight_version` не входит в `_MANAGER_OWNED_FIELDS` (там только `model_path` и `served_model_name`), поэтому overlay для него работает.

## Значения и формат

- Любая строка: имя ветки, хеш коммита, номер шага обучения, дата. Валидации нет.
- Пустая строка допустима — приедет как пустая строка в `/model_info` и в `metadata`.
- Значения «отключить» или «не отдавать» нет: поле присутствует всегда, по умолчанию со значением `default`.
- Единого формата апстрим не навязывает; если метку читает автоматика, формат — ваша ответственность.

## Когда использовать

- Инстанс живет дольше, чем набор весов: RL-цикл, периодический `update_weights_from_disk`, checkpoint engine. Метка позволяет привязать ответ к конкретной итерации.
- Несколько инстансов одной модели с разными чекпойнтами за общим балансировщиком: `--served-model-name` у них может совпадать, а `weight_version` — различаться.
- A/B-сравнение: клиент складывает `metadata.weight_version` рядом с результатом.
- **Не нужен** на статичном инстансе, где веса не меняются, а `--model-path` уже однозначно их описывает.
- **Не путайте** с `--revision`: тот реально влияет на то, **какие** веса загрузятся из HF-репозитория.

## Влияние на производительность и память

Нулевое: строка в JSON-ответе. Ни VRAM, ни KV-пул, ни время старта, ни throughput не затрагиваются. Единственный побочный эффект — `POST /update_weight_version` с `abort_all_requests: true` (значение по умолчанию) прерывает все выполняющиеся запросы.

## Взаимодействие с другими аргументами

- `--served-model-name`: имя модели в `/v1/models`; метка версии его не подменяет и не участвует в маршрутизации.
- `--model-path` / `--revision` / `--load-format`: определяют, что реально загружено. `--weight-version` их не проверяет и рассинхронизироваться с ними может свободно — это ответственность оператора.
- `--checkpoint-engine-wait-weights-before-ready`: сценарий горячей замены весов, где метка и приобретает смысл.

В arriero проксируемые ответы OpenAI не переносят `metadata` в трассу запроса — телеметрия прокси собирает модель, таргет, usage и тайминги (`docs/API_PROXY_FOUNDATION.md`, раздел Telemetry). Поэтому `weight_version` виден клиенту в теле нестримингового ответа, но не попадает в `#/proxy/traces` как отдельное поле. Если метка нужна для аудита, снимайте её отдельно через `GET /model_info` инстанса.

## Типовые проблемы и диагностика

- `404` на `GET /weight_version` или `/get_weight_version` — эндпоинты удалены; используйте `GET /model_info`.
- **Метка не совпадает с реально загруженными весами** — её никто не синхронизирует автоматически: при `--load-format` из другого каталога или ручной подмене файлов она останется прежней. Обновляйте через `/update_weight_version` или передавайте `weight_version` вместе с запросом на горячую замену.
- **В стриминговом ответе нет `metadata`** — так и есть, поле объявлено только у нестриминговых моделей ответа.
- `ValueError: [...] are not ServerArgs fields` — попытка записать overlay с несуществующим именем поля; к штатному использованию `/update_weight_version` не относится.
- Проверка: `curl -s http://127.0.0.1:30000/model_info | python -m json.tool` — поля `model_path` и `weight_version` рядом. Стартовое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --weight-version rl-step-4200 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --weight-version 2026-08-11-nightly --served-model-name qwen3-30b --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- `sglang/python/sglang/srt/managers/io_struct.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/grpc_bridge.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`
