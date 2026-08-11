---
schema: 1
engine: sglang
primaryName: "--modelexpress-config"
title: "--modelexpress-config"
summary: JSON-настройка P2P-загрузки весов через ModelExpress: адрес gRPC-сервиса и транспорт. Работает только при `--load-format remote_instance` с backend'ом `modelexpress` и требует установленного внешнего пакета.
group: model
related:
  - --load-format
  - --remote-instance-weight-loader-backend
  - --remote-instance-weight-loader-seed-instance-ip
  - --engine-info-bootstrap-port
  - --model-path
---

# --modelexpress-config

## Кратко

Аргумент описывает подключение к ModelExpress — внешней системе P2P-раздачи весов. Это узкая интеграция: SGLang только разбирает JSON, кладет значения в `LoadConfig` и импортирует `modelexpress.engines.sglang.loader.MxModelLoader`. Без установленного пакета `modelexpress` загрузка падает с явным `ImportError`, а без `--load-format remote_instance` и `--remote-instance-weight-loader-backend modelexpress` значение просто не читается.

## Оригинальная справка

```text
JSON config for ModelExpress P2P weight loading. Keys: "url" (optional gRPC host:port override), "transport" ("nixl" or "transfer_engine"). Example: '{"url": "localhost:8001", "transport": "nixl"}'
```

## Паспорт аргумента

- Флаги: `--modelexpress-config`
- Группа: `model`
- Тип значения: строка с JSON-объектом
- Допустимые значения: ключи `url` (строка `host:port`) и `transport` (`nixl` либо `transfer_engine`); список ключей нигде не валидируется — лишние молча игнорируются
- Значение по умолчанию: `null`
- Эффективное значение: разбирается ленивым свойством `_parsed_modelexpress_config` (результат кешируется в `_mx_config_cache`); отсутствующий `transport` подставляется как `nixl`, отсутствующий `url` остается `None` и означает «использовать дефолт клиента ModelExpress»
- Где объявлен: `ServerArgs.modelexpress_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, интеграция с внешним пакетом
- Этап применения: построение `LoadConfig` и выбор ветки загрузчика `RemoteInstanceModelLoader`

## Что меняет в движке

Свойства `ServerArgs.modelexpress_url` и `ServerArgs.modelexpress_transport` читают разобранный словарь и уходят в `LoadConfig` (`model_runner_components/load_model_utils.py`). Дальше `RemoteInstanceModelLoader` (`model_loader/loader.py`) в ветке `remote_instance_weight_loader_backend == MODELEXPRESS` импортирует внешний загрузчик:

```python
try:
    from modelexpress.engines.sglang.loader import MxModelLoader
except ImportError as exc:
    raise ImportError("ModelExpress support requires the 'modelexpress' package. Install it in the SGLang image.") from exc
model = MxModelLoader(load_config).load_model(model=model, model_config=model_config, device_config=device_config)
```

Значение `transport` дополнительно влияет на решение поднимать ли transfer engine: `remote_instance_weight_loader_use_transfer_engine()` возвращает True, когда backend `modelexpress` и `transport == "transfer_engine"`. При `nixl` transfer engine не поднимается.

Важная деталь конфигурации: `_handle_load_format` откатывает `--load-format remote_instance` обратно в `auto`, если не хватает данных о seed-инстансе, но для backend'а `modelexpress` эта проверка **не применяется** — там IP и порт seed-инстанса не требуются.

## Значения и формат

- Одна строка JSON; в shell — в одинарных кавычках.
- Невалидный JSON падает при первом обращении к свойству, то есть уже на этапе загрузки весов, а не при разборе CLI.
- `url` — адрес gRPC-сервиса ModelExpress в форме `host:port`, без схемы.
- `transport` принимает только два осмысленных значения; неизвестное значение не отвергается, но `transfer_engine`-ветка просто не включится.
- Пустой объект `{}` эквивалентен «дефолтный URL, транспорт nixl».

## Когда использовать

- Только в кластерных развертываниях, где веса раздаются через ModelExpress вместо чтения с диска каждым инстансом.
- Для обычного локального инференса — никогда: пакета `modelexpress` в стандартном окружении нет, а раздача весов между инстансами на одном хосте бессмысленна.
- Задавайте `url` явно, если сервис ModelExpress живет не там, где его ищет клиент по умолчанию.

## Влияние на производительность и память

- Единственный измеримый эффект — время загрузки весов: P2P-раздача рассчитана на то, чтобы N инстансов не читали один чекпоинт N раз с общего хранилища.
- Транспорт `transfer_engine` дополнительно поднимает RDMA-подобный канал и регистрирует буферы; `nixl` — свой стек. Оба требуют дополнительной пиновки памяти на время передачи.
- На VRAM после загрузки и на throughput не влияет.

## Взаимодействие с другими аргументами

- `--load-format remote_instance`: обязательное условие, иначе загрузчик ModelExpress не выбирается.
- `--remote-instance-weight-loader-backend modelexpress`: второе обязательное условие.
- `--remote-instance-weight-loader-seed-instance-ip` / `--…-service-port`: нужны другим backend'ам (`nccl`, `transfer_engine`), для ModelExpress не требуются.
- `--engine-info-bootstrap-port`: относится к seed-стороне обмена метаданными transfer engine.
- `--model-path`: должен указывать на ту же модель, что раздает ModelExpress.

## Типовые проблемы и диагностика

- `ImportError: ModelExpress support requires the 'modelexpress' package. Install it in the SGLang image.` — пакет не установлен в окружении сервера.
- `json.decoder.JSONDecodeError` на этапе загрузки весов — сломанные кавычки в строке.
- Веса грузятся с диска, хотя ожидалась P2P-раздача — проверьте `--load-format` в дампе `server_args=`: он мог откатиться в `auto` из-за неполной конфигурации удаленного загрузчика («Fallback load_format to 'auto' …»).
- `ValueError: Invalid remote instance weight loader backend.` — значение backend'а не из списка.
- Строка конфигурации, как её принял движок, — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend modelexpress --modelexpress-config '{"url": "localhost:8001", "transport": "nixl"}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend modelexpress --modelexpress-config '{"transport": "transfer_engine"}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_loader/remote_instance_weight_loader_utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
