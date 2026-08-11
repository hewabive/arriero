---
schema: 1
engine: sglang
primaryName: "--node-rank"
title: "--node-rank"
summary: Порядковый номер этого узла в диапазоне `0…nnodes-1`. Единственное, чем строки запуска на разных машинах отличаются друг от друга; узел 0 держит HTTP-сервер и токенизатор, остальные только считают.
group: parallel
related:
  - --nnodes
  - --dist-init-addr
  - --tp-size
  - --pp-size
  - --port
  - --host
  - --elastic-ep-join-mode
  - --elastic-ep-join-rank-offset
  - --enable-metrics
---

# --node-rank

## Кратко

`--node-rank` — единственный аргумент, который обязан различаться между узлами одного экземпляра. Все остальное (модель, `--tp-size`, `--pp-size`, `--nnodes`, `--dist-init-addr`) на всех машинах совпадает. Ранг решает две вещи: какие TP/PP-ранги поднимет этот узел и будет ли на нем HTTP-фасад. Узел `0` владеет всем внешним контуром; узлы с рангом ≥ 1 запускают только scheduler-процессы, поднимают заглушку health-эндпоинта и блокируются до завершения. Значение по умолчанию `0`.

## Оригинальная справка

```text
The node rank.
```

## Паспорт аргумента

- Флаги: `--node-rank`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет; осмысленный диапазон — `0…nnodes-1`. Выход за диапазон не проверяется: `_calculate_rank_ranges` посчитает несуществующие ранги, группа не соберется, и запуск повиснет
- Значение по умолчанию: `0`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает. Единственная жесткая проверка — в elastic EP: `--elastic-ep-join-mode scale` требует ровно `--node-rank 1`
- Где объявлен: `ServerArgs.node_rank`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `_calculate_rank_ranges` (выбор локальных TP/PP-рангов) → запуск scheduler-процессов → развилка «узел 0 или нет» в `_launch_subprocesses` → рандеву `torch.distributed`

## Что меняет в движке

### Какие ранги поднимает узел

Ранг входит в обе формулы раскладки: `node_rank // nnodes_per_pp_rank` выбирает диапазон PP-стадий, `node_rank % nnodes_per_tp_group` — диапазон TP-рангов. Полные формулы и разбор двух типовых конфигураций — в `nnodes.md`.

### Что запускается только на узле 0

- `recv_from_tokenizer` в `DataParallelController` создается только при `node_rank == 0`;
- PUSH-сокеты воркеров при DP-attention биндит узел 0, остальные узлы получают их номера broadcast'ом (`_broadcast_worker_ports`; на клиентской стороне ранг узла используется как идентификатор в handshake);
- при `node_rank >= 1` `_launch_subprocesses` не поднимает ни detokenizer, ни tokenizer manager, ни HTTP-сервер: он ждет готовности своих scheduler'ов, поднимает `launch_dummy_health_check_server(host, port, enable_metrics)` и блокируется в `block_until_scheduler_exits()`;
- переменная окружения `SGLANG_BLOCK_NONZERO_RANK_CHILDREN=0` отменяет блокировку — это режим для использования `Engine` как Python-API, а не для обычного сервера.

Заглушка health-сервера на узлах ≥ 1 означает, что `--port` на них тоже должен быть свободен, и что ответ `/health` с такого узла ничего не говорит о готовности модели.

### Elastic EP

Присоединяющаяся группа запускается с `--elastic-ep-join-mode scale` и обязана иметь `--node-rank 1`: `assert self.node_rank == 1` с текстом `Elastic EP scale-up requires one joining TP group at --node-rank 1 (got N).`. Ее scheduler'ы получают порты от первичного развертывания по handshake-каналу, а свои выходы отправляют в токенизатор первичного узла.

## Значения и формат

- Целое `0…nnodes-1`. Диапазон не валидируется — ошибка проявится как несобравшаяся группа, а не как понятное сообщение.
- На одноузловом запуске (`--nnodes 1`) единственное корректное значение — `0`, то есть умолчание.
- Значение обязано быть уникальным среди узлов. Два узла с одинаковым рангом поднимут одни и те же глобальные ранги, и `torch.distributed` либо повиснет, либо упадет на конфликте рангов.
- Порядок узлов имеет значение для производительности: соседние глобальные ранги должны лежать на одной машине. Docstring `initialize_model_parallel` прямо просит это учитывать при раскладке.

## Когда использовать

- Всегда при `--nnodes > 1`: на каждой машине свой номер, начиная с 0.
- Узел, на котором вы хотите видеть HTTP-эндпоинт и метрики, должен получить ранг `0`.
- Присоединяющаяся группа elastic EP — ранг `1` и только он.
- Не задавайте на одноузловом запуске: `0` и так умолчание.

## Влияние на производительность и память

- Сам по себе не влияет ни на память, ни на throughput: это индекс.
- Косвенно определяет, какие карты займет узел (через `tp_rank_range` и `--base-gpu-id`) и на каком узле окажется дополнительная нагрузка токенизации/детокенизации — она вся на ранге 0.
- Порядок рангов влияет на топологию коллективов: неправильно назначенные ранги могут отправить внутриузловой трафик через сеть.

## Взаимодействие с другими аргументами

- `--nnodes`: задает диапазон допустимых значений.
- `--dist-init-addr`: одинаков на всех узлах и указывает на узел с рангом 0.
- `--tp-size` / `--pp-size`: вместе с рангом определяют локальные диапазоны рангов.
- `--port` / `--host`: на узлах ≥ 1 используются заглушкой health-сервера.
- `--enable-metrics`: передается в заглушку health-сервера на узлах ≥ 1.
- `--elastic-ep-join-mode scale` / `--elastic-ep-join-rank-offset`: требуют ранга 1 и ненулевого offset.
- `--enable-dp-attention`: на узле 0 биндятся воркер-сокеты, остальные узлы их получают.

## Типовые проблемы и диагностика

- `AssertionError: Elastic EP scale-up requires one joining TP group at --node-rank 1 (got 0).`
- Старт висит на `Init torch distributed begin.` на всех узлах — типичные причины: два узла с одинаковым рангом, пропущенный ранг в последовательности, ранг вне `0…nnodes-1`.
- `/v1/models` и `/health` отвечают, но модель не грузится — вы обращаетесь к узлу с рангом ≥ 1, где работает заглушка health-сервера. Обращайтесь к узлу 0.
- `Port is already in use` на узле ≥ 1 — `--port` занят под заглушку и там тоже должен быть свободен.
- Ранг узла не печатается в лог отдельной строкой; ориентируйтесь на глобальные ранги в префиксах ` TP<n>`/` PP<n>` и на дамп `server_args=`, который каждый узел печатает свой.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --tensor-parallel-size 4 --nnodes 2 --node-rank 0 --dist-init-addr 10.0.0.10:50000
```

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --tensor-parallel-size 4 --nnodes 2 --node-rank 1 --dist-init-addr 10.0.0.10:50000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
