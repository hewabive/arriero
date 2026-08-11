---
schema: 1
engine: sglang
primaryName: "--kv-events-config"
title: "--kv-events-config"
summary: Узкая интеграция с внешним маршрутизатором (NVIDIA Dynamo): включает публикацию событий радиксного кеша по ZMQ. События содержат идентификаторы токенов промпта и по умолчанию биндятся на все интерфейсы без аутентификации.
group: observability
related:
  - --page-size
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --dp-size
  - --enable-dp-attention
  - --tp-size
  - --enable-metrics
---

# --kv-events-config

## Кратко

Это не «еще один флаг наблюдаемости», а включение отдельного канала интеграции: планировщик начинает публиковать события радиксного кеша (`BlockStored`, `BlockRemoved`, `AllBlocksCleared`) наружу по ZMQ, чтобы внешний маршрутизатор мог направлять запрос на ту реплику, у которой уже есть нужный префикс. Значение — JSON-строка конфигурации публикатора.

Публикация включается **самим фактом непустого значения**, дополнительного переключателя нет. Перед включением надо знать две вещи:

1. Событие `BlockStored` содержит поле `token_ids` — реальные идентификаторы токенов сохраненного блока. Это содержимое промпта, покидающее процесс.
2. Значение `endpoint` по умолчанию — `tcp://*:5557`, то есть PUB-сокет **биндится на все интерфейсы** без какой-либо аутентификации. Подписаться может кто угодно, кто дотянется до порта.

## Оригинальная справка

```text
Config in json format for NVIDIA dynamo KV event publishing. Publishing will be enabled if this flag is used.
```

## Паспорт аргумента

- Флаги: `--kv-events-config`
- Группа: `observability`
- Тип значения: str — JSON-документ целиком в одном аргументе
- Допустимые значения: `choices` нет. Схема — pydantic-модель `KVEventsConfig` (`sglang/python/sglang/srt/disaggregation/kv_events.py`), разбор через `model_validate_json`
- Значение по умолчанию: `None` — публикация выключена
- Эффективное значение: значение не переписывается, но публикация фактически включается только на рангах `pp_rank == 0`, `attn_tp_rank == 0`, `attn_cp_rank == 0`; на остальных объект публикатора не создается
- Где объявлен: `ServerArgs.kv_events_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но узкоспециальный — вне связки с внешним маршрутизатором смысла не имеет
- Этап применения: инициализация планировщика (`Scheduler.init_kv_events_publisher`) и построение радиксного кеша (флаг `enable_kv_cache_events` в `CacheInitParams`)

## Что меняет в движке

### Кто и что публикует

`SchedulerKvEventsPublisher` (`sglang/python/sglang/srt/managers/scheduler_components/kv_events_publisher.py`) держит публикатор и на каждом шаге забирает накопленные события из дерева префиксов (`tree_cache.take_events()`), заворачивает их в `KVEventBatch` с меткой времени и отправляет.

Тот же флаг проставляет `enable_kv_cache_events` при построении кеша: без него `take_events()` всегда возвращает пустой список, и дерево событий вообще не накапливает.

Типы событий (`kv_events.py`):

- `BlockStored` — `block_hashes`, `parent_block_hash`, **`token_ids`**, `block_size`, `lora_id`, `medium` (уровень хранения: GPU / CPU_PINNED / DISK / EXTERNAL);
- `BlockRemoved` — `block_hashes`, `medium`;
- `AllBlocksCleared`.

Помимо событий кеша публикуется структура `KvMetrics` (число активных слотов, занятость KV, длина очереди, hit rate) через отдельный ZMQ-канал планировщика.

### Транспорт

`ZmqEventPublisher` поднимает отдельный поток и PUB-сокет; при указании `replay_endpoint` дополнительно ROUTER-сокет, через который подписчик может запросить пропущенные батчи по номеру последовательности. Очередь событий ограничена `max_queue_size`, высокая вода ZMQ — `hwm`; при отставании подписчика события **отбрасываются**, а не копятся бесконечно.

В конфигурации с несколькими репликами порт смещается на индекс реплики (`select_kv_publisher_dp_rank` + `offset_endpoint_port`): при DP-attention — по `attn_dp_rank`, при обычном DP — по `dp_rank`. То есть при `--dp-size 4` и `tcp://*:5557` будут заняты порты 5557–5560.

### Что видит потребитель

`/server_info` отдает производную структуру с `publisher`, `endpoint_host` и `endpoint_port_base` — но только если конфигурация разбирается, публикатор не `null`, endpoint является маршрутизируемым TCP-адресом и `--page-size` положителен. Комментарий в `server_args.py` объясняет, почему `page_size` обязателен: маршрутизатор хеширует промпты с гранулярностью блока, и неверный `block_size` дает молчаливые промахи кеша, а не ошибку.

## Значения и формат

Поля `KVEventsConfig` со значениями по умолчанию:

- `publisher` — `"null"` (ничего не публикует) или `"zmq"`. По умолчанию `"null"`: JSON `{}` включит механизм сбора событий, но отправлять их будет некуда;
- `endpoint` — `"tcp://*:5557"`. `tcp://*:PORT` означает bind на все интерфейсы, `tcp://host:PORT` — connect;
- `replay_endpoint` — `None`, ROUTER-адрес для повторной выдачи батчей;
- `buffer_steps` — `10000`, глубина буфера повторов;
- `hwm` — `100000`, high-water mark PUB-сокета;
- `max_queue_size` — `100000`, глубина внутренней очереди;
- `topic` — `""`, топик подписки.

Строка передается целиком: `--kv-events-config '{"publisher":"zmq","endpoint":"tcp://127.0.0.1:5557"}'`. Некорректный JSON или несоответствие схеме дают ошибку pydantic при создании публикатора (то есть на старте планировщика); отдельно `/server_info` в этой ситуации просто перестает показывать блок публикатора, чтобы не падать.

## Когда использовать

- Перед SGLang стоит маршрутизатор, умеющий читать эти события (NVIDIA Dynamo и совместимые), и вы хотите prefix-aware балансировку между репликами. Это единственный сценарий.
- Не включайте «чтобы посмотреть на кеш»: для наблюдения есть метрики (`--enable-metrics`, hit rate в строках `Prefill batch`), а этот канал — интеграционный протокол, а не отладочный вывод.
- Не включайте на сервере, доступном не только с localhost, без явного `endpoint` с адресом интерфейса и без сетевого ограничения: подписка ничем не защищена, а в событиях есть `token_ids`.

## Влияние на производительность и память

- VRAM не затрагивается.
- RAM: буфер повторов на `buffer_steps` батчей плюс очередь до `max_queue_size` событий в scheduler-процессе. При значениях по умолчанию это заметные десятки мегабайт под нагрузкой.
- CPU: сериализация msgspec и отправка в отдельном потоке; планировщик от этого не блокируется, но событий генерируется примерно столько же, сколько блоков сохраняется и вытесняется.
- Сеть: постоянный исходящий поток, пропорциональный интенсивности prefill.
- При отстающем подписчике события отбрасываются по достижении `hwm`/`max_queue_size` — деградация тихая.

## Взаимодействие с другими аргументами

- `--page-size`: определяет `block_size` в событиях; без положительного значения `/server_info` не покажет публикатора, а маршрутизатор будет хешировать не с той гранулярностью.
- `--disable-radix-cache`: дерево префиксов заменяется на `ChunkCache`, у которого `take_events()` из базового класса всегда возвращает пустой список. Публикатор поднимется, но событий не будет.
- `--enable-hierarchical-cache`: события несут поле `medium` с уровнем хранения (GPU/CPU/DISK/EXTERNAL) — именно для иерархии оно и нужно. Отдельно учтите: экспериментальная C++-реализация радиксного дерева (включается переменной окружения `SGLANG_EXPERIMENTAL_CPP_RADIX_TREE`, а не аргументом) содержит `assert params.enable_kv_cache_events is False` с сообщением `HiRadixCache does not support kv cache events yet` — в этой связке старт упадет.
- `--dp-size`, `--enable-dp-attention`: определяют, по какому рангу смещается порт публикатора и сколько портов будет занято.
- `--tp-size`, `--pp-size`: публикует только ранг 0 по attention-TP, CP и PP.

## Типовые проблемы и диагностика

- **Симптом:** ошибка валидации pydantic при старте планировщика. **Причина:** некорректный JSON или неизвестное поле. **Лечение:** проверить строку, например `python -c "import json,sys;json.loads(sys.argv[1])" '<строка>'`.
- **Симптом:** публикатор запущен (`Starting ZMQ publisher thread` в логе), а событий нет. **Причина №1:** `publisher` остался `"null"`. **Причина №2:** `--disable-radix-cache`. **Причина №3:** это не тот ранг — публикует только `attn_tp_rank == 0`.
- **Симптом:** `AssertionError: HiRadixCache does not support kv cache events yet`. **Причина:** включена экспериментальная C++-реализация радиксного дерева. **Лечение:** снять `SGLANG_EXPERIMENTAL_CPP_RADIX_TREE`.
- **Симптом:** маршрутизатор промахивается по кешу, хотя события идут. **Причина:** несовпадение `block_size` — сверьте `--page-size` с тем, что ждет потребитель, и посмотрите блок публикатора в `GET /server_info`.
- **Симптом:** порт 5557 занят при `--dp-size > 1`. **Причина:** порт смещается на индекс реплики, занят диапазон.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `kv_events_config=`; `GET /server_info` показывает разобранные `publisher`/`endpoint_host`/`endpoint_port_base`.

## В arriero

Для управляемого инстанса аргумент не нужен и потенциально вреден.

- Маршрутизацию между целями в arriero делает собственный планировщик прокси (`docs/API_PROXY_FOUNDATION.md`, `docs/RESOURCE_MANAGEMENT.md`, arriero), и он не является потребителем событий Dynamo. Публикация будет работать «в пустоту».
- Безопасность: инстанс под arriero принято слушать на `127.0.0.1`, но `endpoint` публикатора задается отдельно и по умолчанию биндится на все интерфейсы. Значение `tcp://*:5557` откроет наружу поток с идентификаторами токенов промптов при формально «локальном» HTTP.
- Занятые порты не видны менеджеру: arriero учитывает только HTTP-порт инстанса, поэтому конфликт портов между двумя инстансами с одинаковым `endpoint` проявится как непонятный отказ старта планировщика.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --page-size 64 --kv-events-config '{"publisher":"zmq","endpoint":"tcp://127.0.0.1:5557"}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --page-size 64 --kv-events-config '{"publisher":"zmq","endpoint":"tcp://127.0.0.1:5557","replay_endpoint":"tcp://127.0.0.1:5558","topic":"kv","buffer_steps":2000}'
```

## Источники

- `sglang/python/sglang/srt/disaggregation/kv_events.py`
- `sglang/python/sglang/srt/managers/scheduler_components/kv_events_publisher.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/mem_cache/events.py`
- `sglang/python/sglang/srt/mem_cache/base_prefix_cache.py`
- `sglang/python/sglang/srt/mem_cache/radix_cache_cpp.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `docs/RESOURCE_MANAGEMENT.md`
