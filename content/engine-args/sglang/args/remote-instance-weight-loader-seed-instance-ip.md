---
schema: 1
engine: sglang
primaryName: "--remote-instance-weight-loader-seed-instance-ip"
title: "--remote-instance-weight-loader-seed-instance-ip"
summary: IP-адрес seed-инстанса, у которого целевой инстанс забирает веса при `--load-format remote_instance`. Обязателен для backend'ов `nccl` и `transfer_engine`; без него формат загрузки молча откатывается на `auto`.
group: model
related:
  - --remote-instance-weight-loader-backend
  - --remote-instance-weight-loader-seed-instance-service-port
  - --remote-instance-weight-loader-send-weights-group-ports
  - --remote-instance-weight-loader-start-seed-via-transfer-engine
  - --load-format
  - --modelexpress-config
---

# --remote-instance-weight-loader-seed-instance-ip

## Кратко

Аргумент задает ровно одно значение — хост seed-инстанса, из памяти которого целевой инстанс вытянет веса. Механизм в целом (что такое seed, как устроены группы передачи, какие транспорты бывают) описан в документе `--remote-instance-weight-loader-backend`. Здесь важны две вещи: адрес используется и как HTTP-хост управляющих запросов, и как `master_address` коммуникационной группы; и его отсутствие не роняет старт, а тихо переводит загрузку на чтение с диска.

## Оригинальная справка

```text
The ip of the seed instance for loading weights from remote instance.
```

## Паспорт аргумента

- Флаги: `--remote-instance-weight-loader-seed-instance-ip`
- Группа: `model`
- Тип значения: строка (`Optional[str]`), IP-адрес или имя хоста
- Допустимые значения: не ограничены; валидации формата нет
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; при `--load-format remote_instance` его отсутствие переопределяет **другой** аргумент — `load_format` становится `auto`
- Где объявлен: `ServerArgs.remote_instance_weight_loader_seed_instance_ip`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_load_format` — проверка полноты) → HTTP-запросы к seed'у и построение коммуникационной группы при загрузке весов

## Что меняет в движке

Значение попадает в `LoadConfig.remote_instance_weight_loader_seed_instance_ip` и используется в трех местах:

1. **Управляющие HTTP-запросы.** `trigger_init_weights_send_group_for_remote_instance_request` и `trigger_transferring_weights_request` (`sglang/python/sglang/srt/model_loader/remote_instance_weight_loader_utils.py`) строят URL как `http://<ip>:<service_port>` и шлют туда `POST /init_weights_send_group_for_remote_instance` и `POST /send_weights_to_remote_instance`. Для transfer-engine пути аналогично собирается `http://<ip>:<service_port>` для `GET /get_remote_instance_transfer_engine_info`.
2. **`master_address` группы.** В теле обоих POST-запросов тот же адрес передается как `master_address` — по нему целевой ранг и seed-ранг встречаются в NCCL-группе с `world_size = 2`.
3. **Адрес коннектора.** В `nccl`-ветке `RemoteInstanceModelLoader.load_model` строит URI `instance://<ip>:<порт из --remote-instance-weight-loader-send-weights-group-ports по индексу tp_rank>`.

Проверка полноты в `_handle_load_format`: если формат загрузки `remote_instance`, backend не `modelexpress`, и не задан ip **или** service-порт, печатается `Fallback load_format to 'auto' due to incomplete remote instance weight loader settings.` и загрузка идет с диска.

## Значения и формат

- Обычная строка адреса. Формат не проверяется: опечатка проявится ошибкой HTTP-запроса, а не понятным сообщением при разборе CLI.
- Адрес должен быть достижим с целевого узла и одновременно быть тем адресом, по которому seed-ранги смогут установить NCCL-соединение: он используется как `master_address`, поэтому `127.0.0.1` годится только при запуске обоих инстансов на одном хосте.
- Порт здесь не указывается — он задается отдельным аргументом `--remote-instance-weight-loader-seed-instance-service-port`.
- Для backend `modelexpress` значение не требуется: адрес берется из ключа `url` в `--modelexpress-config`.
- Собственный адрес целевого инстанса не настраивается: он определяется как `NetworkAddress.resolve_host(socket.gethostname())` и передается seed'у как `group_name`-идентификатор клиента.

## Когда использовать

- Всегда, когда включен `--load-format remote_instance` с backend `nccl` или `transfer_engine`.
- Не задавайте при backend `modelexpress` — там адрес приходит из конфига ModelExpress.
- Не задавайте вне `--load-format remote_instance`: значение не будет прочитано (единственное исключение — служебная проверка `remote_instance_weight_loader_use_transfer_engine`, но она смотрит на backend, а не на адрес).

## Влияние на производительность и память

Сам адрес на память и скорость не влияет. Влияет выбор сети, стоящий за ним: если указан адрес интерфейса без RDMA/высокоскоростной линии, вся передача весов пойдет по нему, и выигрыш механизма перед чтением с диска может исчезнуть.

## Взаимодействие с другими аргументами

- `--remote-instance-weight-loader-seed-instance-service-port`: неразрывная пара, оба должны быть заданы.
- `--remote-instance-weight-loader-backend`: определяет, нужен ли адрес вообще (`modelexpress` — нет) и что по нему будет запрошено.
- `--remote-instance-weight-loader-send-weights-group-ports`: вместе с адресом образует URI коннектора в `nccl`-ветке.
- `--load-format`: включатель механизма.
- `--modelexpress-config`: альтернативный источник адреса для backend `modelexpress`.

## Типовые проблемы и диагностика

- `Fallback load_format to 'auto' due to incomplete remote instance weight loader settings.` — адрес (или порт) не задан. Старт продолжится с диска; это надо ловить в логе, ошибки не будет.
- `Failed to trigger init_weights_send_group_for_remote_instance_request to seed instance http://<ip>:<port>: ...` — адрес недостижим, порт закрыт или на нем не SGLang. Исключение пробрасывается, старт целевого инстанса падает.
- `Failed to trigger send weights to remote instance request: ...` — та же причина на втором шаге.
- `Exception: ...` из `get_remote_instance_transfer_engine_info_per_rank` плюс `Cannot get transfer engine session or weight info.` — недоступен HTTP-эндпоинт seed'а в transfer-engine ветке.
- Зависание после успешных HTTP-запросов обычно означает, что `master_address` недостижим для NCCL-рандеву, хотя HTTP прошел (типично для адреса за NAT или для несовпадения интерфейсов).
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend nccl --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --remote-instance-weight-loader-send-weights-group-ports '[35000]' --port 30001
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend transfer_engine --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --port 30001
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_loader/remote_instance_weight_loader_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
