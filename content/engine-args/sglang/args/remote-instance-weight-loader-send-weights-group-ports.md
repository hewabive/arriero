---
schema: 1
engine: sglang
primaryName: "--remote-instance-weight-loader-send-weights-group-ports"
title: "--remote-instance-weight-loader-send-weights-group-ports"
summary: JSON-список портов коммуникационных групп передачи весов — по одному на TP-ранг. Нужен только backend'у `nccl`; без него формат загрузки молча откатывается на `auto`.
group: model
related:
  - --remote-instance-weight-loader-backend
  - --remote-instance-weight-loader-seed-instance-ip
  - --remote-instance-weight-loader-seed-instance-service-port
  - --remote-instance-weight-loader-start-seed-via-transfer-engine
  - --load-format
  - --tp-size
---

# --remote-instance-weight-loader-send-weights-group-ports

## Кратко

Аргумент задает одно значение — список TCP-портов, на которых поднимаются попарные NCCL-группы «seed-ранг ↔ целевой ранг» для перекачки весов. Индекс в списке равен TP-рангу, поэтому длина списка должна соответствовать `--tp-size`. Это порты данных, а не управляющий порт (тот задается через `--remote-instance-weight-loader-seed-instance-service-port`). Механизм целиком описан в документе `--remote-instance-weight-loader-backend`.

## Оригинальная справка

```text
The communication group ports for loading weights from remote instance.
```

## Паспорт аргумента

- Флаги: `--remote-instance-weight-loader-send-weights-group-ports`
- Группа: `model`
- Тип значения: JSON-список целых (`Optional[List[int]]`, парсер `json_list_type`)
- Допустимые значения: не ограничены; проверяется только то, что строка разбирается как JSON
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; его отсутствие при `--load-format remote_instance` и backend `nccl` переводит `load_format` в `auto`
- Где объявлен: `ServerArgs.remote_instance_weight_loader_send_weights_group_ports`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_load_format` — проверка полноты) → HTTP-запросы к seed'у и построение коннектора при загрузке весов

## Что меняет в движке

Список используется двумя способами (`sglang/python/sglang/srt/model_loader/`):

1. **Передается seed'у.** В телах `POST /init_weights_send_group_for_remote_instance` и `POST /send_weights_to_remote_instance` он сериализуется как строка `ports` через запятую (`",".join(str(p) for p in ports)`). Seed по ней поднимает свою половину каждой группы.
2. **Адресует коннектор.** В `RemoteInstanceModelLoader.load_model` (`nccl`-ветка) URI строится как `instance://<seed_ip>:<ports[tp_rank]>` — элемент берется по индексу текущего TP-ранга.

Из второго пункта следует жесткое требование: элементов в списке должно быть не меньше, чем `--tp-size`. Проверки на длину в коде нет — при коротком списке будет `IndexError` в момент загрузки весов на старшем ранге.

Проверка полноты в `_handle_load_format`: если формат `remote_instance`, backend `nccl` и список не задан — `Fallback load_format to 'auto' due to incomplete remote instance weight loader NCCL group ports settings.`

Для backend'ов `transfer_engine` и `modelexpress` список не читается: там адресация другая (RDMA-сессия и метаданные весов, либо конфиг ModelExpress).

## Значения и формат

- Строка с валидным JSON-массивом, например `[35000]` или `[35000,35001,35002,35003]`. Разбирается `json_list_type` (`orjson.loads`); при ошибке argparse ответит `Invalid JSON list: <value>. Please provide a valid JSON list.`
- В shell значение надо экранировать кавычками, иначе квадратные скобки съест сам shell.
- Порядок значим: индекс = TP-ранг.
- Тип элементов не валидируется: JSON-массив строк разберется без ошибки и упадет позже, при построении URI.
- Порты должны быть свободны на seed-узле и достижимы с целевого; их занимает NCCL-рандеву каждой пары.

## Когда использовать

- Всегда, когда `--load-format remote_instance` и backend `nccl`.
- Число элементов подбирайте по `--tp-size` обоих инстансов (они обязаны совпадать — соответствие рангов попарное).
- Не задавайте при backend `transfer_engine` или `modelexpress` — значение не будет прочитано.
- Не подставляйте сюда HTTP-порт seed'а: это разные вещи, и подмена приведет к конфликту портов на seed-узле.

## Влияние на производительность и память

На память не влияет. На скорость влияет косвенно, через выбор сети: NCCL-группы поднимаются на указанных портах поверх маршрута до `master_address`, поэтому фактическая пропускная способность определяется интерфейсом, а не номерами портов.

## Взаимодействие с другими аргументами

- `--remote-instance-weight-loader-backend`: значение читается только при `nccl`.
- `--remote-instance-weight-loader-seed-instance-ip`: вместе образуют URI коннектора.
- `--remote-instance-weight-loader-seed-instance-service-port`: управляющий порт, не путать.
- `--tp-size`: определяет требуемую длину списка.
- `--load-format`: включатель механизма.

## Типовые проблемы и диагностика

- `Fallback load_format to 'auto' due to incomplete remote instance weight loader NCCL group ports settings.` — список не задан при backend `nccl`; старт продолжится с диска.
- `argparse.ArgumentTypeError: Invalid JSON list: <value>. Please provide a valid JSON list.` — значение не разобралось как JSON (чаще всего shell съел скобки; заключите в одинарные кавычки).
- `IndexError` при загрузке весов на ранге `k` — в списке меньше `k+1` элементов.
- Зависание после `Loading weights from remote instance ...` — порт занят, закрыт файрволом или seed не поднял свою половину группы; проверяйте лог seed-инстанса.
- `Failed to trigger send weights to remote instance request: ...` — seed не принял команду передачи.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend nccl --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --remote-instance-weight-loader-send-weights-group-ports '[35000]' --port 30001
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --tp-size 4 --load-format remote_instance --remote-instance-weight-loader-backend nccl --remote-instance-weight-loader-seed-instance-ip 10.0.0.11 --remote-instance-weight-loader-seed-instance-service-port 30000 --remote-instance-weight-loader-send-weights-group-ports '[35000,35001,35002,35003]' --port 30001
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_loader/remote_instance_weight_loader_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/utils/common.py`
