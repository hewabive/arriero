---
schema: 1
engine: sglang
primaryName: "--remote-instance-weight-loader-backend"
title: "--remote-instance-weight-loader-backend"
summary: Выбирает транспорт, которым инстанс тянет веса из уже работающего «seed»-инстанса вместо чтения с диска. Это опорный флаг механизма `--load-format remote_instance`; неполная настройка не роняет старт, а молча откатывает формат загрузки на `auto`.
group: model
related:
  - --load-format
  - --remote-instance-weight-loader-seed-instance-ip
  - --remote-instance-weight-loader-seed-instance-service-port
  - --remote-instance-weight-loader-send-weights-group-ports
  - --remote-instance-weight-loader-start-seed-via-transfer-engine
  - --modelexpress-config
  - --engine-info-bootstrap-port
  - --enable-memory-saver
  - --tp-size
---

# --remote-instance-weight-loader-backend

## Кратко

Remote instance weight loader — это загрузка весов **по сети из памяти другого живого инстанса SGLang**, а не с диска. Механизм включается форматом `--load-format remote_instance` и настраивается пятью флагами; этот выбирает транспорт. Здесь же описан весь механизм целиком, остальные четыре флага задают по одному значению каждый. Главная эксплуатационная особенность: при неполной или неподдерживаемой конфигурации движок не падает — он печатает предупреждение и откатывает `--load-format` на `auto`, то есть тихо читает веса с диска.

## Оригинальная справка

```text
The backend for loading weights from remote instance. Can be 'transfer_engine', 'nccl', or 'modelexpress'. Default is 'nccl'.
```

## Паспорт аргумента

- Флаги: `--remote-instance-weight-loader-backend`
- Группа: `model`
- Тип значения: строка с фиксированным списком (`Literal[...]`)
- Допустимые значения: `transfer_engine`, `nccl`, `modelexpress`
- Значение по умолчанию: `nccl`
- Эффективное значение: само значение не переписывается, но при `--load-format remote_instance` оно проверяется в `_handle_load_format` и может привести к откату **формата загрузки** на `auto`
- Где объявлен: `ServerArgs.remote_instance_weight_loader_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; каждый транспорт требует своей внешней обвязки
- Этап применения: `__post_init__` (`_handle_load_format`) → инициализация transfer engine в `ModelRunner` → загрузка весов в `RemoteInstanceModelLoader`

## Что меняет в движке

**Общая схема.** Есть seed-инстанс — обычный работающий сервер SGLang с загруженной моделью, — и целевой инстанс, который поднимается с `--load-format remote_instance`. Целевой создает модель на GPU (веса пока мусорные), устанавливает канал к seed и вытягивает параметры по именам. Соответствие рангов строго попарное: seed TP 0 ↔ dst TP 0, seed TP 1 ↔ dst TP 1 и так далее, каждая пара образует коммуникационную группу с `world_size = 2`. Поэтому параллелизм seed и целевого инстанса обязан совпадать.

**`nccl`** (по умолчанию). Целевой инстанс, ранг 0, в отдельном потоке шлет seed'у HTTP `POST /init_weights_send_group_for_remote_instance` с телом `{master_address, ports, group_rank: 0, world_size: 2, group_name: "send_weights_<ip клиента>", backend: "nccl"}` (`maybe_trigger_remote_instance_nccl_send_group` в `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`). Затем `RemoteInstanceModelLoader` открывает коннектор `instance://<seed_ip>:<порт своего tp_rank>`, строит группу, ранг 0 шлет `POST /send_weights_to_remote_instance`, и все параметры переливаются последовательными `torch.distributed.broadcast` из ранга 0 группы. После загрузки выполняется `_post_load_weights`, группа уничтожается, кеш аллокатора очищается.

**`transfer_engine`** — RDMA-путь поверх Mooncake. Целевой инстанс регистрирует память под веса в transfer engine (`register_memory_region`; версия v2 сначала сливает соседние блоки из `torch.cuda.memory_snapshot`, чтобы регистрировать меньше регионов), затем через HTTP `GET /get_remote_instance_transfer_engine_info?rank=<tp_rank>` получает у seed'а session id и карту `имя → (указатель, numel, element_size)`, сверяет размеры каждого тензора и выполняет один `batch_transfer_sync_read`. Эндпоинт `/get_remote_instance_transfer_engine_info` помечен в http-сервере как deprecated в пользу `/remote_instance_transfer_engine_info`; оба проксируют запрос в EngineInfoBootstrapServer (`--engine-info-bootstrap-port`), куда seed заранее положил свои метаданные — за это на seed-стороне отвечает `--remote-instance-weight-loader-start-seed-via-transfer-engine`.

**`modelexpress`** — делегирование внешнему пакету: `RemoteInstanceModelLoader` импортирует `modelexpress.engines.sglang.loader.MxModelLoader` и передает управление ему. Транспорт внутри ModelExpress выбирается ключом `transport` в `--modelexpress-config` (`nixl` по умолчанию либо `transfer_engine`). Отсутствие пакета — `ImportError` с явным текстом.

**Проверки в `_handle_load_format`** (выполняются только при `--load-format remote_instance`):

- backend не `modelexpress` и не задан `--remote-instance-weight-loader-seed-instance-ip` или `--remote-instance-weight-loader-seed-instance-service-port` → `Fallback load_format to 'auto' due to incomplete remote instance weight loader settings.`;
- backend `nccl` и не задан `--remote-instance-weight-loader-send-weights-group-ports` → `Fallback load_format to 'auto' due to incomplete remote instance weight loader NCCL group ports settings.`;
- backend `transfer_engine` и `validate_transfer_engine()` вернул `False` → `Fallback load_format to 'auto' due to 'transfer_engine' backend is not supported.`

`validate_transfer_engine()` возвращает `False` в двух случаях: не импортируется `mooncake.engine` либо включен `--enable-memory-saver` (memory saver несовместим с transfer engine).

## Значения и формат

- `nccl` — требует заданных ip, service-порта и списка групповых портов; работает поверх обычной сети/NVLink через NCCL.
- `transfer_engine` — требует ip, service-порта, установленного `mooncake-transfer-engine` и выключенного memory saver. Групповые порты не нужны.
- `modelexpress` — единственный вариант, которому не нужны ip и порт seed'а (адрес берется из `--modelexpress-config`); требует установленного пакета `modelexpress`.
- Значение вне списка отвергает argparse.
- Аргумент читается только при `--load-format remote_instance` (за одним исключением: `remote_instance_weight_loader_use_transfer_engine` учитывает backend и при определении, нужен ли transfer engine seed-инстансу).

## Когда использовать

- Быстрый ввод дополнительной реплики в строй, когда веса уже лежат в GPU-памяти соседнего инстанса, а чтение с общего хранилища дорого: эластичное масштабирование, PD-развертывания.
- Транспорт выбирают по обвязке: есть RDMA и Mooncake — `transfer_engine`; нет — `nccl`; используете ModelExpress — `modelexpress`.
- Не используйте для обычного одиночного инстанса: механизм требует второй живой инстанс с той же моделью и той же параллельностью.
- Не полагайтесь на то, что ошибка конфигурации будет заметна: она проявляется предупреждением в логе и медленным стартом с диска.

## Влияние на производительность и память

- Время старта: цель механизма. Передача из памяти соседа по RDMA/NCCL быстрее чтения многогигабайтного чекпойнта с диска, особенно сетевого.
- VRAM целевого инстанса: модель создается на GPU заранее (`_initialize_model` под `torch.device(device)`), поэтому пиковый расход такой же, как при обычной загрузке. Экономии VRAM механизм не дает.
- VRAM и загрузка seed-инстанса: на время передачи он отдает свои веса — при `nccl` это `broadcast` по каждому параметру, при `transfer_engine` — регистрация памяти (шаг сопровождается строкой «TransferEngine registering memory regions (this may take a few seconds)...») и один batch-read.
- Сеть: объем равен размеру шардов на ранг.
- На стационарный throughput после загрузки не влияет.

## Взаимодействие с другими аргументами

- `--load-format remote_instance`: единственный включатель всего механизма.
- `--remote-instance-weight-loader-seed-instance-ip` и `--remote-instance-weight-loader-seed-instance-service-port`: адрес HTTP-эндпоинтов seed'а; обязательны для `nccl` и `transfer_engine`.
- `--remote-instance-weight-loader-send-weights-group-ports`: обязателен для `nccl`, по одному порту на TP-ранг.
- `--remote-instance-weight-loader-start-seed-via-transfer-engine`: флаг **seed**-стороны, не целевой.
- `--modelexpress-config`: адрес и транспорт для `modelexpress`.
- `--enable-memory-saver`: блокирует `transfer_engine`.
- `--tp-size`: должен совпадать у seed и целевого инстанса — соответствие рангов попарное.
- `--speculative-draft-load-format`: драфт-раннер может грузиться своим форматом, и `remote_instance_weight_loader_use_transfer_engine(load_format=...)` учитывает это отдельно.
- `--load-format runai_streamer`/`remote_instance` исключают `ModelOptModelLoader`.

## Типовые проблемы и диагностика

- `Fallback load_format to 'auto' due to incomplete remote instance weight loader settings.` — не задан ip или service-порт seed'а.
- `Fallback load_format to 'auto' due to incomplete remote instance weight loader NCCL group ports settings.` — backend `nccl` без списка групповых портов.
- `Fallback load_format to 'auto' due to 'transfer_engine' backend is not supported.` — нет `mooncake.engine` либо включен memory saver; отдельно печатается `Failed to import mooncake.engine ...` или `Memory saver is enabled, which is not compatible with TransferEngine ...`.
- `Failed to trigger init_weights_send_group_for_remote_instance_request to seed instance http://<ip>:<port>: ...` — seed недоступен или отвечает ошибкой. Исключение пробрасывается, старт целевого инстанса падает.
- `RuntimeError: Transfer engine is not initialized for remote instance model loader with 'transfer_engine' backend.` — движок не поднял transfer engine.
- `Cannot get transfer engine session or weight info.` или `Weight info does not match for <name>, expected (...), got (...)` — рассинхронизация seed и цели: разные модель, dtype, квантизация или параллелизм. Итог — `RuntimeError: Failed to load weights from remote instance via transfer engine.`
- `ImportError: ModelExpress support requires the 'modelexpress' package.` — backend `modelexpress` без пакета.
- Успех подтверждают `Loading weights from remote instance ...`, а для RDMA — `TransferEngine memory regions have been successfully registered.`
- Про безопасность: эндпоинты `/init_weights_send_group_for_remote_instance`, `/send_weights_to_remote_instance` и `/remote_instance_transfer_engine_info` объявлены с уровнем `ADMIN_OPTIONAL`. На seed-инстансе, слушающем не только localhost, они позволяют постороннему инициировать выгрузку весов; закрывайте seed сетевыми средствами или ключом администратора.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend nccl --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --remote-instance-weight-loader-send-weights-group-ports '[35000]' --host 127.0.0.1 --port 30001
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend transfer_engine --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --host 127.0.0.1 --port 30001
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_loader/remote_instance_weight_loader_utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/remote_instance_weight_transporter.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
