---
schema: 1
engine: vllm
primaryName: "--api-server-count"
title: "--api-server-count"
summary: Сколько отдельных процессов HTTP-фронтенда поднимается перед движком. Один порт остается один, распределение делает SO_REUSEPORT; значение больше 1 отключает консольный лог статистики и требует multiprocess-режима Prometheus.
group: null
related:
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-external-lb
  - --data-parallel-hybrid-lb
  - --data-parallel-multi-port-external-lb
  - --headless
  - --enable-elastic-ep
  - --enable-fault-tolerance
  - --disable-log-stats
  - --port
---

# --api-server-count

## Кратко

`--api-server-count` масштабирует **фронтенд**, а не движок. Каждый процесс API-сервера — это отдельный uvicorn с собственным `AsyncLLM`-клиентом, все они слушают один и тот же сокет, а ядра движка (`EngineCore`) остаются общими и адресуются по ZMQ.

Ручка нужна тогда, когда узким местом становится сам Python-фронтенд: сериализация, токенизация запросов, обработка SSE. При одном DP-ранге и умеренном RPS она почти всегда лишняя.

У аргумента нет фиксированного дефолта: без явного значения он выводится из режима data parallelism, и в самом типовом случае (`--data-parallel-size 1`) получается 1.

## Оригинальная справка

```text
How many API server processes to run. Defaults to data_parallel_size if not specified.
```

## Паспорт аргумента

- Флаги: `--api-server-count`, `-asc`
- Группа argparse: без группы (объявлен напрямую в `make_arg_parser`)
- Тип значения: int
- Допустимые значения: положительное целое для обычного режима; `0` выставляется движком самостоятельно в headless-режиме
- Значение по умолчанию: `None` — «решит движок»
- Эффективное значение: вычисляется в `ServeSubcommand.cmd` (`vllm/entrypoints/cli/serve.py`) до создания конфигов; см. таблицу ниже
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:make_arg_parser`
- Этап применения: выбор топологии процессов в подкоманде `serve`, до `create_engine_config`

## Что меняет в движке

Разрешение `None` идет строго по порядку:

1. `--headless` → значение принудительно `0`; явно заданное ненулевое значение отвергается с `--api-server-count=N cannot be used with --headless (no API servers are started in headless mode).`
2. multi-port external LB (`--data-parallel-multi-port-external-lb`), external LB (`--data-parallel-external-lb` или заданный `--data-parallel-rank`), либо Rust-фронтенд (`VLLM_USE_RUST_FRONTEND`) → `1`.
3. hybrid LB (`--data-parallel-hybrid-lb` или заданный `--data-parallel-start-rank`) → `--data-parallel-size-local` (или 1), с сообщением `Defaulting api_server_count to data_parallel_size_local (N) for hybrid LB mode.`
4. иначе (internal LB) → `--data-parallel-size`, с сообщением `Defaulting api_server_count to data_parallel_size (N).`

После этого применяются ограничители: при Rust-фронтенде значение больше 1 сбрасывается в 1 с предупреждением; при `--enable-elastic-ep` — тоже в 1 (`Elastic EP only supports running with with at most one API server. Capping api_server_count from N to 1.`).

Полученное число определяет ветку запуска:

- `< 1` → `run_headless(args)`: API-серверов нет вообще, поднимаются только локальные `EngineCore`;
- `== 1` → значение сбрасывается в `None`, и `run_server(args)` выполняется **в текущем процессе**;
- `> 1` → `run_multi_api_server(args)`: родительский процесс биндит слушающий сокет с `SO_REUSEPORT`, запускает ядра движка, а затем через `APIServerProcessManager` порождает N процессов `ApiServer_i` (контекст `spawn`), передавая каждому его пару ZMQ-адресов, `client_index` и общий сокет.

Важно, что даже при значении 1 движок все равно живет в отдельном процессе: это обычная многопроцессность V1, а не следствие этого аргумента.

Значение попадает в `ParallelConfig._api_process_count` (и `_api_process_rank`), участвует в валидации конфига и учитывается подсистемами, которым нужно знать число клиентов.

## Значения и формат

- Целое число. Осмысленный диапазон — от 1 до числа ядер, которые вы готовы отдать фронтенду.
- `0` вручную задавать не нужно: это внутреннее представление headless-режима, и явная попытка совместить его с `--headless` отвергается.
- Отрицательные значения приведут к ветке `run_headless`, где немедленно сработает проверка режима.
- Алиас `-asc` эквивалентен полному имени.

## Когда использовать

- Профиль показывает, что процесс фронтенда упирается в один поток CPU (высокая загрузка одного ядра, растущая очередь в uvicorn), а GPU при этом недогружен. Апстрим прямо рекомендует эту ручку как средство против бутылочного горлышка API-сервера при больших DP.
- Много мелких запросов с длинными ответами по SSE: стоимость на запрос в Python растет, а GPU-работы на запрос мало.
- **Не используйте на одиночной карте с одним DP-рангом просто так**: N процессов фронтенда добавляют N наборов токенизаторов и буферов в RAM, ломают консольную статистику (см. ниже) и усложняют диагностику.
- Не используйте как способ поднять concurrency: очередь и планирование живут в движке, а не во фронтенде; лимиты задают `--max-num-seqs` и `--max-num-batched-tokens`.

## Влияние на производительность и память

- **VRAM.** Не влияет: процессы фронтенда с GPU не работают.
- **RAM хоста.** Растет примерно линейно по числу процессов — каждый держит собственный токенизатор, процессор мультимодальных входов и буферы.
- **CPU.** Основной выигрыш: параллельная обработка HTTP, токенизации и потоковой отдачи.
- **Latency.** Снижает хвостовые задержки, когда фронтенд был перегружен; на разгруженном сервере эффекта нет.
- **Наблюдаемость.** При значении больше 1 `StatLoggerManager` отключает консольный логгер статистики с предупреждением `AsyncLLM created with api_server_count more than 1; disabling stats logging to avoid incomplete stats.` — периодических строк со скоростью и заполнением KV-cache в логе больше не будет. Prometheus продолжает работать, но переводится в multiprocess-режим: `setup_multiprocess_prometheus()` создает временный `PROMETHEUS_MULTIPROC_DIR`; если переменная уже задана извне, движок предупреждает, что каталог нужно чистить между запусками, иначе метрики будут неточными.

## Взаимодействие с другими аргументами

- `--data-parallel-size`, `--data-parallel-size-local`: источники дефолта в режимах internal и hybrid LB.
- `--data-parallel-external-lb`, `--data-parallel-multi-port-external-lb`: дефолт становится 1 — распределение делает внешний балансировщик.
- `--data-parallel-hybrid-lb`: дефолт равен числу локальных рангов; апстрим-документация рекомендует масштабировать значение по числу локальных рангов на узел.
- `--headless`: взаимоисключающие; в headless-режиме API-серверов нет.
- `--enable-elastic-ep`: принудительно ограничивает значение до 1.
- `--enable-fault-tolerance`: требует ровно одного API-сервера — иначе `ParallelConfig` отвергает конфигурацию.
- `--disable-log-stats`: при значении больше 1 консольная статистика и так выключается автоматически, так что этот флаг перестает что-либо менять в логе.
- `--port`, `--uds`: порт остается один на все процессы; сокет создается родителем и наследуется.

## Типовые проблемы и диагностика

- **Симптом:** `--api-server-count=4 cannot be used with --headless (no API servers are started in headless mode).` **Лечение:** убрать один из флагов.
- **Симптом:** после включения нескольких серверов пропали периодические строки со статистикой движка. **Причина:** штатное поведение. **Проверка:** предупреждение `AsyncLLM created with api_server_count more than 1; disabling stats logging to avoid incomplete stats.` **Лечение:** собирать метрики через `/metrics`, а не из лога.
- **Симптом:** метрики Prometheus выглядят завышенными или «залипшими». **Причина:** `PROMETHEUS_MULTIPROC_DIR` задан снаружи и не очищается между запусками. **Проверка:** предупреждение `Found PROMETHEUS_MULTIPROC_DIR was set by user...` **Лечение:** снять переменную и дать движку управлять каталогом самому.
- **Симптом:** `VLLM_ALLOW_RUNTIME_LORA_UPDATING cannot be used with api_server_count > 1`. **Причина:** динамическое обновление LoRA работает только с одним фронтендом. **Лечение:** вернуть 1.
- **Симптом:** значение молча стало равно 1. **Причина:** активен Rust-фронтенд или `--enable-elastic-ep`. **Проверка:** предупреждения `Ignoring --api-server-count=N when using rust front-end process` и `Capping api_server_count from N to 1.`
- **Подтверждение принятого значения:** строка `Started N API server processes` при старте; при значении 1 такой строки нет вовсе, потому что сервер работает в текущем процессе.
- **Симптом (arriero):** после включения нескольких фронтендов дерево процессов инстанса выросло. **Причина:** это ожидаемо — родитель порождает N процессов `ApiServer_i` плюс ядра движка. Супервизор запускает инстанс в собственной pgid и снимает всю группу целиком, но учет памяти по потомкам изменится; сверьте объявленные draw'ы с измеренными (`docs/VLLM_OPERATIONS.md`, arriero).

## Примеры

```bash
vllm serve /models/Qwen3-4B --api-server-count 2 --max-num-seqs 16
```

```bash
vllm serve /models/Qwen3-4B --data-parallel-size 2 --api-server-count 1 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/v1/utils.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/vllm/v1/metrics/prometheus.py`
- `vllm/vllm/config/parallel.py`
- `vllm/docs/serving/data_parallel_deployment.md`
- `docs/VLLM_OPERATIONS.md` (arriero)
