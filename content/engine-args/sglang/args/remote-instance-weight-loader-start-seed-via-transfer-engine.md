---
schema: 1
engine: sglang
primaryName: "--remote-instance-weight-loader-start-seed-via-transfer-engine"
title: "--remote-instance-weight-loader-start-seed-via-transfer-engine"
summary: Флаг **seed**-стороны: заставляет инстанс поднять Mooncake transfer engine и опубликовать метаданные своих весов, чтобы другие инстансы могли читать их по RDMA. Значение молча сбрасывается в `false`, если Mooncake недоступен или включен memory saver.
group: model
related:
  - --remote-instance-weight-loader-backend
  - --remote-instance-weight-loader-seed-instance-ip
  - --remote-instance-weight-loader-seed-instance-service-port
  - --remote-instance-weight-loader-send-weights-group-ports
  - --load-format
  - --enable-memory-saver
  - --modelexpress-config
  - --engine-info-bootstrap-port
---

# --remote-instance-weight-loader-start-seed-via-transfer-engine

## Кратко

Все остальные флаги семейства `remote-instance-weight-loader` настраивают инстанс-получатель. Этот — единственный, который задается на инстансе-**источнике**: он поднимает Mooncake transfer engine, регистрирует память весов и публикует карту тензоров, чтобы получатели с backend `transfer_engine` могли прочитать их напрямую по RDMA. Механизм целиком описан в документе `--remote-instance-weight-loader-backend`. Особенность, которую нельзя пропустить: значение не просто проверяется, а **перезаписывается** результатом проверки — при недоступном Mooncake или включенном memory saver флаг становится `false`, и seed поднимется без transfer engine.

## Оригинальная справка

```text
Start seed server via transfer engine backend for remote instance weight loader.
```

## Паспорт аргумента

- Флаги: `--remote-instance-weight-loader-start-seed-via-transfer-engine`
- Группа: `model`
- Тип значения: булев переключатель (`store_true`); парной формы `--no-...` нет
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: **переопределяется в `__post_init__`**. В `_handle_load_format` выполняется `self.remote_instance_weight_loader_start_seed_via_transfer_engine = self.validate_transfer_engine()`, то есть при заданном флаге итоговое значение равно результату проверки, а не тому, что попросил оператор
- Где объявлен: `ServerArgs.remote_instance_weight_loader_start_seed_via_transfer_engine`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_load_format`) → `ModelRunner.init_remote_instance_weight_transporter` и инициализация движка передачи → регистрация и публикация метаданных весов после загрузки модели

## Что меняет в движке

Значение читается методом `ServerArgs.remote_instance_weight_loader_use_transfer_engine(load_format=None)`: он возвращает `True`, если этот флаг поднят (роль seed), либо если инстанс сам грузится как получатель через transfer engine (`load_format == "remote_instance"` и backend `transfer_engine`, или `modelexpress` с транспортом `transfer_engine`).

`ModelRunner` по этому признаку инициализирует `RemoteInstanceWeightTransporter` (`sglang/python/sglang/srt/model_executor/model_runner_components/remote_instance_weight_transporter.py`) и вызывает `init_engine()`: тот поднимает `mooncake.engine.TransferEngine` в режиме `P2PHANDSHAKE` (протокол и устройство — из переменных окружения `MOONCAKE_PROTOCOL`/`MOONCAKE_DEVICE`) и запоминает session id вида `<ip>:<rpc-порт>`.

После загрузки модели вызывается `maybe_register_and_publish_weight_info()`: она регистрирует память весов (`register_memory_region`) и отправляет `PUT /register_transfer_engine_info` на EngineInfoBootstrapServer (хост — узел `node_rank == 0`, порт — `--engine-info-bootstrap-port`, по умолчанию 6789) с телом `{tp_rank, transfer_engine_info: {session_id, weights_info_dict}}`. Получатели забирают эти данные через HTTP-эндпоинт seed'а `GET /remote_instance_transfer_engine_info?rank=<n>` (и его deprecated-псевдоним `/get_remote_instance_transfer_engine_info`), который проксирует запрос в тот же bootstrap-сервер. Для backend `modelexpress` публикация пропускается — там регистрацией памяти владеет сам ModelExpress.

Перезапись значения в `_handle_load_format` делает `validate_transfer_engine()`, который возвращает `False` в двух случаях:

- не импортируется `mooncake.engine` — в лог уходит `Failed to import mooncake.engine. Does not support using TransferEngine as remote instance weight loader backend.`;
- включен `--enable-memory-saver` — `Memory saver is enabled, which is not compatible with TransferEngine. Does not support using TransferEngine as remote instance weight loader backend.`

Никакого отказа старта при этом нет: seed поднимется как обычный сервер, просто без публикации весов.

## Значения и формат

Переключатель без значения. Единственная тонкость — асимметрия ролей: на seed'е задают этот флаг и ничего больше из семейства; на получателе задают `--load-format remote_instance`, backend и адрес seed'а, но этот флаг не задают.

Регистрация памяти в Mooncake — не мгновенная операция: в логе она обрамлена строкой `TransferEngine registering memory regions (this may take a few seconds)...`. Версия `register_memory_region_v2` заранее сливает соседние блоки из `torch.cuda.memory_snapshot()`, чтобы регистрировать меньше регионов.

## Когда использовать

- Инстанс должен служить донором весов для будущих реплик, поднимаемых с `--remote-instance-weight-loader-backend transfer_engine`. Это единственный сценарий.
- Не задавайте на инстансе-получателе: там transfer engine включается автоматически по backend'у.
- Не задавайте вместе с `--enable-memory-saver`: флаг будет сброшен, и вы получите seed без публикации весов при внешне корректной команде запуска.
- Не задавайте, если Mooncake не установлен: результат тот же — тихий сброс.

## Влияние на производительность и память

- VRAM: сами веса не дублируются, регистрируется существующая память. Но регистрация RDMA-регионов означает, что эта память закреплена за transfer engine на все время жизни инстанса.
- Совместимость с memory saver потеряна по построению: memory saver умеет выгружать веса, а RDMA-регистрация этого не допускает — отсюда и запрет.
- Время старта: добавляется инициализация движка передачи и регистрация регионов (секунды, зависит от числа блоков после слияния).
- На throughput и latency обслуживания запросов после старта не влияет; нагрузка появляется только в моменты, когда получатели читают веса.

## Взаимодействие с другими аргументами

- `--remote-instance-weight-loader-backend`: значение `transfer_engine` на **получателе** — то, ради чего этот флаг поднимают на seed'е.
- `--enable-memory-saver`: взаимно исключены; выигрывает memory saver, флаг сбрасывается.
- `--load-format`: на seed'е остается обычным (`auto` и т. п.); `remote_instance` — это про получателя.
- `--modelexpress-config`: транспорт `transfer_engine` внутри ModelExpress тоже приводит к поднятию движка передачи, но уже на стороне получателя; публикацию метаданных этот путь пропускает.
- `--engine-info-bootstrap-port`: порт bootstrap-сервера, куда seed кладет метаданные; при нескольких инстансах на одном узле его надо задавать явно, иначе они столкнутся на 6789.
- `--remote-instance-weight-loader-seed-instance-ip` и `--remote-instance-weight-loader-seed-instance-service-port`: задаются на получателе и указывают на этот самый seed.

## Типовые проблемы и диагностика

- `Failed to import mooncake.engine. Does not support using TransferEngine as remote instance weight loader backend.` — нет пакета `mooncake-transfer-engine`; флаг сброшен.
- `Memory saver is enabled, which is not compatible with TransferEngine ...` — снимите `--enable-memory-saver`, если нужен RDMA-донор.
- Получатель сообщает `Cannot get transfer engine session or weight info.` — seed не поднял transfer engine (чаще всего из-за одной из двух причин выше) либо еще не опубликовал метаданные.
- Получатель сообщает `Weight info does not match for <name>, expected (<numel>, <esize>), got (...)` — seed и получатель различаются моделью, dtype, квантизацией или параллелизмом.
- Успех на seed'е подтверждает `TransferEngine memory regions have been successfully registered.`
- Итоговое (уже переопределенное) значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) — именно там проще всего заметить, что флаг был сброшен в `False`.

## Примеры

Seed-инстанс:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --remote-instance-weight-loader-start-seed-via-transfer-engine --host 0.0.0.0 --port 30000
```

Инстанс-получатель:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend transfer_engine --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --port 30001
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/remote_instance_weight_transporter.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_loader/remote_instance_weight_loader_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
