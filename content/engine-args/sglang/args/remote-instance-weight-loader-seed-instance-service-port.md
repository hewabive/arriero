---
schema: 1
engine: sglang
primaryName: "--remote-instance-weight-loader-seed-instance-service-port"
title: "--remote-instance-weight-loader-seed-instance-service-port"
summary: HTTP-порт seed-инстанса, на котором целевой инстанс дергает управляющие эндпоинты передачи весов. Это порт `--port` seed-сервера, а не порт данных; без него `--load-format remote_instance` откатывается на `auto`.
group: model
related:
  - --remote-instance-weight-loader-backend
  - --remote-instance-weight-loader-seed-instance-ip
  - --remote-instance-weight-loader-send-weights-group-ports
  - --remote-instance-weight-loader-start-seed-via-transfer-engine
  - --load-format
  - --port
---

# --remote-instance-weight-loader-seed-instance-service-port

## Кратко

Аргумент задает одно значение — TCP-порт HTTP-сервера seed-инстанса. По нему целевой инстанс отправляет управляющие запросы: «подними группу отправки весов», «отправь веса», «отдай метаданные transfer engine». Сами веса по этому порту не идут: для `nccl` данные передаются через порты из `--remote-instance-weight-loader-send-weights-group-ports`, для `transfer_engine` — по RDMA. Механизм целиком описан в документе `--remote-instance-weight-loader-backend`.

## Оригинальная справка

```text
The service port of the seed instance for loading weights from remote instance.
```

## Паспорт аргумента

- Флаги: `--remote-instance-weight-loader-seed-instance-service-port`
- Группа: `model`
- Тип значения: целое (`Optional[int]`), номер TCP-порта
- Допустимые значения: не ограничены; проверки диапазона нет
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; его отсутствие при `--load-format remote_instance` переводит `load_format` в `auto`
- Где объявлен: `ServerArgs.remote_instance_weight_loader_seed_instance_service_port`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_load_format` — проверка полноты) → HTTP-запросы к seed'у при загрузке весов

## Что меняет в движке

Значение вместе с `--remote-instance-weight-loader-seed-instance-ip` собирается в базовый URL `http://<ip>:<port>` (`sglang/python/sglang/srt/model_loader/remote_instance_weight_loader_utils.py`) и используется для трех обращений:

- `POST /init_weights_send_group_for_remote_instance` — целевой ранг 0 просит seed поднять группу отправки (`world_size: 2`, `group_name: send_weights_<ip клиента>`);
- `POST /send_weights_to_remote_instance` — команда начать передачу (только `nccl`-ветка);
- `GET /get_remote_instance_transfer_engine_info?rank=<tp_rank>` — метаданные RDMA-сессии и карта весов (`transfer_engine`-ветка). Эндпоинт помечен deprecated в пользу `/remote_instance_transfer_engine_info`.

Все три эндпоинта живут на обычном HTTP-сервере SGLang (`sglang/python/sglang/srt/entrypoints/http_server.py`), поэтому нужное значение — это `--port` seed-инстанса.

Проверка полноты в `_handle_load_format` объединена с проверкой ip: если backend не `modelexpress` и не задан ip **или** порт — `Fallback load_format to 'auto' due to incomplete remote instance weight loader settings.`

## Значения и формат

- Целое. Ни диапазон, ни доступность порта не проверяются; ошибка проявится как исключение HTTP-запроса.
- Это управляющий порт, а не порт данных. Путать его с элементами `--remote-instance-weight-loader-send-weights-group-ports` — самая частая ошибка в этой пятерке флагов.
- Для backend `modelexpress` значение не требуется: адрес и порт берутся из `--modelexpress-config`.
- Значение не читается вне `--load-format remote_instance`.

## Когда использовать

- Всегда вместе с `--remote-instance-weight-loader-seed-instance-ip`, когда включен `remote_instance` с backend `nccl` или `transfer_engine`.
- Значение берите из конфигурации seed-инстанса: это его `--port`.
- Не задавайте при backend `modelexpress`.
- Не подставляйте сюда порт из группы передачи весов — HTTP-запрос уйдет в никуда.

## Влияние на производительность и память

На производительность и память не влияет: по этому порту передаются только небольшие управляющие JSON-сообщения. Объем весов идет другим путем.

## Взаимодействие с другими аргументами

- `--remote-instance-weight-loader-seed-instance-ip`: неразрывная пара.
- `--remote-instance-weight-loader-backend`: определяет, какие именно эндпоинты будут вызваны и нужен ли порт вообще.
- `--remote-instance-weight-loader-send-weights-group-ports`: другой набор портов, для данных `nccl`.
- `--port`: на seed-инстансе именно этот аргумент задает значение, которое надо здесь указать.
- `--load-format`: включатель механизма.

## Типовые проблемы и диагностика

- `Fallback load_format to 'auto' due to incomplete remote instance weight loader settings.` — порт (или ip) не задан; загрузка пойдет с диска без ошибки.
- `Failed to trigger init_weights_send_group_for_remote_instance_request to seed instance http://<ip>:<port>: ...` — порт закрыт, занят другим сервисом или указан порт данных вместо HTTP-порта.
- `request.get failed: <код>` из `get_remote_instance_transfer_engine_info_per_rank` — HTTP-эндпоинт ответил не 200: обычно seed не поднял transfer engine либо это не тот сервис.
- Ответ `401`/`403` от seed'а — на нем включена админ-аутентификация: эндпоинты объявлены с уровнем `ADMIN_OPTIONAL`, и при заданном ключе они его потребуют.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend nccl --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --remote-instance-weight-loader-send-weights-group-ports '[35000]' --port 30001
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --tp-size 2 --load-format remote_instance --remote-instance-weight-loader-backend nccl --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --remote-instance-weight-loader-send-weights-group-ports '[35000,35001]' --port 30001
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_loader/remote_instance_weight_loader_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
