---
schema: 1
engine: vllm
primaryName: "--data-parallel-supervisor-port"
title: "--data-parallel-supervisor-port"
summary: Порт, на котором супервизор multi-port external LB отдает агрегированный `/health` по всем локальным DP-рангам. Не должен пересекаться с диапазоном портов дочерних серверов.
group: Frontend
related:
  - --data-parallel-multi-port-external-lb
  - --data-parallel-size-local
  - --data-parallel-size
  - --port
  - --dp-supervisor-probe-interval-s
  - --dp-supervisor-probe-timeout-s
  - --dp-supervisor-probe-failure-threshold
---

# --data-parallel-supervisor-port

## Кратко

Аргумент имеет смысл только в режиме `--data-parallel-multi-port-external-lb`. В нем `vllm serve` не поднимает движок сам, а становится супервизором: порождает по одному полноценному API-серверу на каждый локальный DP-ранг и держит собственный маленький HTTP-сервер с агрегированной проверкой здоровья.

Именно этот порт слушает внешний балансировщик или Kubernetes, чтобы одним запросом узнать, живы ли все ранги.

## Оригинальная справка

```text
HTTP port for aggregated health endpoints in multi-port external LB
mode.
```

## Паспорт аргумента

- Флаги: `--data-parallel-supervisor-port`
- Группа argparse: `Frontend`
- Тип значения: int
- Допустимые значения: любой порт; проверяется только непересечение с портами детей
- Значение по умолчанию: `9256`
- Эффективное значение: у дочерних процессов это поле принудительно обнуляется (`child_args.data_parallel_supervisor_port = None`) — супервизор в дереве ровно один
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.data_parallel_supervisor_port`
- Этап применения: разбор CLI (валидация режима) → запуск супервизора вместо обычного сервера

## Что меняет в движке

`vllm/entrypoints/cli/serve.py` при `--data-parallel-multi-port-external-lb` вызывает `run_dp_supervisor(args)` вместо запуска API-сервера. `DPSupervisor` (`vllm/entrypoints/openai/dp_supervisor.py`):

1. проверяет конфигурацию `validate_multi_port_external_lb_args` — режим несовместим с `--grpc`, `--uds`, явным `--data-parallel-rank`, с другими режимами LB и требует `--api-server-count 1`; `--data-parallel-size` должен быть не меньше 2, `--data-parallel-size-local` — не меньше 2 и делить `--data-parallel-size` нацело;
2. отдельно проверяет порты: супервизорный порт не должен попадать в диапазон `[--port, --port + local_size - 1]`, иначе `Error: --data-parallel-supervisor-port <N> overlaps with child rank ports <A>-<B>`;
3. запускает `data_parallel_size_local` дочерних процессов (`multiprocessing` со стартовым методом `spawn`). Каждому достается `port = --port + local_rank`, свой срез `--device-ids`, `data_parallel_external_lb=True` и `api_server_count=1`;
4. опрашивает `/health` каждого ребенка и, **только когда все они здоровы**, поднимает свой сервер на этом порту.

Супервизорное приложение отдает три маршрута — `/health`, `/ready`, `/readyz` — с пустым телом: 200, если супервизор считает группу готовой, и 503 иначе. TLS-параметры (`--ssl-keyfile`/`--ssl-certfile` и прочие) наследуются от общих аргументов, хост берется из `--host` или `0.0.0.0`.

Обратная сторона отложенного старта: пока хотя бы один ранг не готов, порт вообще не слушается, и проба получает отказ соединения, а не 503.

## Значения и формат

- Целое число порта: `--data-parallel-supervisor-port 9256`.
- Значение по умолчанию `9256` выбрано так, чтобы не пересекаться со стандартным `--port 8000` при разумном числе локальных рангов, но проверка выполняется по фактическим значениям.
- Дочерние ранги занимают подряд идущие порты от `--port`; их число равно `--data-parallel-size-local`.
- Вне режима multi-port значение не используется никем.

## Когда использовать

- Один узел обслуживает несколько DP-рангов, каждый со своим портом, а распределением нагрузки занимается внешний балансировщик. Тогда балансировщику нужен один адрес для health-проб — этот.
- Меняйте значение, когда 9256 занят другим процессом или попадает в диапазон дочерних портов при большом `--data-parallel-size-local`.
- Не используйте в режимах internal/hybrid/external LB без multi-port: там супервизора нет, и аргумент бесполезен.

## Влияние на производительность и память

Сам порт ничего не стоит. Стоимость режима — в дочерних процессах: каждый ранг это полноценный API-сервер со своим движком, своей копией весов на своих устройствах и своим потреблением VRAM. Супервизор добавляет один легкий процесс без движка и периодические HTTP-пробы по loopback.

## Взаимодействие с другими аргументами

- `--data-parallel-multi-port-external-lb`: единственный включатель режима.
- `--port`: база диапазона дочерних портов; пересечение с супервизорным портом отвергается на старте.
- `--data-parallel-size-local`: сколько дочерних портов будет занято; вместе с `--port` задает запрещенный диапазон.
- `--data-parallel-size`: должен делиться на `--data-parallel-size-local` нацело.
- `--dp-supervisor-probe-interval-s`, `--dp-supervisor-probe-timeout-s`, `--dp-supervisor-probe-failure-threshold`: параметры того самого механизма проб, который определяет значение на этом порту.

## Типовые проблемы и диагностика

- **Симптом:** старт падает с `Error: --data-parallel-supervisor-port <N> overlaps with child rank ports <A>-<B>`. **Причина:** порт попал в диапазон детей. **Лечение:** вынести супервизорный порт за пределы `[--port, --port + local - 1]`.
- **Симптом:** проба на супервизорный порт получает отказ соединения (не 503). **Причина:** сервер супервизора поднимается только после готовности всех рангов. **Проверка:** строка `Waiting for vLLM DP Servers to become ready.` в логе. **Лечение:** увеличить порог готовности в балансировщике на время старта.
- **Симптом:** старт падает с `Error: --data-parallel-multi-port-external-lb requires --api-server-count=1` (или аналогичным сообщением про `--uds`, `--grpc`, `--data-parallel-rank`). **Причина:** несовместимая комбинация. **Лечение:** убрать конфликтующий аргумент.
- **Симптом:** `/health` супервизора отвечает 503 и не восстанавливается. **Причина:** после достижения готовности любая неудачная проба переводит группу в остановку — это конструктивное решение, а не временный сбой. **Проверка:** `DPSupervisor probe found N unhealthy DP Servers.` в логе. **Лечение:** разбирать причину падения ранга.
- **Подтверждение принятого значения:** строка `Started DPSupervisor on <host>:<port>` в логе.

## Примеры

```bash
vllm serve /models/Qwen3-4B --data-parallel-multi-port-external-lb --data-parallel-size 2 --data-parallel-size-local 2 --port 8000 --data-parallel-supervisor-port 9256
```

```bash
vllm serve /models/Qwen3-4B --data-parallel-multi-port-external-lb --data-parallel-size 4 --data-parallel-size-local 4 --port 8000 --data-parallel-supervisor-port 8100
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/dp_supervisor.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/entrypoints/launcher.py`
