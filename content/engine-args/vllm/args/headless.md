---
schema: 1
engine: vllm
primaryName: "--headless"
title: "--headless"
summary: Запускает узел без HTTP-сервера: поднимаются только процессы движка, которые подключаются к фронтенду на другом узле. Флаг для второго и последующих узлов многоузлового развертывания, а не режим экономии.
group: null
related:
  - --api-server-count
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-start-rank
  - --data-parallel-address
  - --data-parallel-rpc-port
  - --data-parallel-hybrid-lb
  - --nnodes
  - --node-rank
  - --master-addr
  - --shutdown-timeout
---

# --headless

## Кратко

`--headless` меняет топологию процессов: вместо «HTTP-сервер плюс движок» узел поднимает **только** процессы движка и ждет управляющих сообщений от узла, где живет API-сервер. Порт не открывается, `/health` и `/v1/*` на этом узле не существуют.

Флаг осмыслен исключительно в многоузловых развертываниях — при data parallelism с внутренней балансировкой (второй и последующие узлы) и при многоузловом PP/TP (узлы, отличные от головного). На одиночном хосте он бесполезен: без API-сервера некому принимать запросы.

## Оригинальная справка

```text
Run in headless mode. See multi-node data parallel documentation for more details.
```

## Паспорт аргумента

- Флаги: `--headless`
- Группа argparse: без группы (объявлен напрямую в `make_arg_parser`)
- Тип значения: bool, `action="store_true"` — только включение, парного `--no-headless` нет
- Допустимые значения: флаг присутствует или отсутствует
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется, но принудительно выставляет `api_server_count = 0` и передает `headless=True` в `create_engine_config`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:make_arg_parser`
- Этап применения: выбор ветки запуска в подкоманде `serve`, до `create_engine_config`

## Что меняет в движке

В `ServeSubcommand.cmd` флаг обрабатывается первым: явно заданный ненулевой `--api-server-count` отвергается, после чего счетчик выставляется в `0`, и запуск уходит в `run_headless(args)` (`vllm/entrypoints/cli/serve.py`).

`run_headless` разделяется на два сценария.

1. **Узел не нулевого ранга внутри DP-группы** (`parallel_config.node_rank_within_dp > 0`, то есть многоузловой PP/TP). Поднимается `MultiprocExecutor(vllm_config, monitor_workers=False)` и вызывается `start_worker_monitor(inline=True)`: узел работает только как набор worker'ов, подключенных к головному узлу по адресу `master_addr:master_port` для `torch.distributed`. В лог идет `Launching vLLM (vX) headless multiproc executor, with head node address <host:port> for torch.distributed process group.`
2. **Локальные DP-ранги.** Создается `CoreEngineProcManager` на `data_parallel_size_local` движков со `start_index = data_parallel_rank`, `local_client=False` и handshake-адресом `data_parallel_master_ip:data_parallel_rpc_port`. Строка в логе: `Launching N data parallel engine(s) in headless mode, with head node address <host:port>.` Дальше процесс просто следит за живостью движков (`monitor_engine_liveness()`).

Проверки, которые срабатывают именно в этом режиме:

- `data_parallel_hybrid_lb is not applicable in headless mode` — hybrid LB требует API-сервера на каждом узле, поэтому несовместим;
- `data_parallel_size_local must be > 0 in headless mode` — узлу нечего делать без локальных рангов;
- на стороне головного узла рукопожатие дополнительно проверяет согласованность: удаленный движок обязан быть headless, если режим не external/hybrid LB, и наоборот — иначе рукопожатие падает с сообщением про лишний или недостающий `--headless` (`vllm/v1/engine/utils.py`).

Завершение: устанавливаются обработчики `SIGTERM`/`SIGINT`, и при остановке `engine_manager.shutdown(timeout=vllm_config.shutdown_timeout)` ждет процессы до `--shutdown-timeout` секунд, печатая `Waiting up to N seconds for processes to exit`.

## Значения и формат

- Флаг без значения. Форма `--headless=true` не поддерживается (`store_true`), парной `--no-headless` нет.
- Из YAML через `--config` включается ключом `headless: true`; `headless: false` молча отбрасывается, потому что `--no-headless` не зарегистрирован.
- Комбинация с явным `--api-server-count` больше нуля отвергается на старте.

## Когда использовать

- Второй и последующие узлы DP-развертывания с внутренней балансировкой: головной узел держит API-сервер и все ранги адресует по RPC, остальные узлы поднимаются с `--headless`, тем же `--data-parallel-size`, своим `--data-parallel-size-local` и `--data-parallel-start-rank`.
- Узел, на котором должны жить только движки, а API-сервер вынесен отдельно (`--data-parallel-size-local 0` на головном узле и `--headless` на узле с картами).
- Узлы, отличные от головного, в многоузловом PP/TP (`--nnodes` / `--node-rank` / `--master-addr`).
- **Не используйте на одиночном хосте.** Инстанс стартует, процессы движка живут, но HTTP-порт никогда не откроется — для arriero это выглядит как инстанс, который «запустился и не проходит health».
- Не используйте вместе с `--data-parallel-hybrid-lb`: режимы взаимоисключающие по построению.

## Влияние на производительность и память

- **VRAM.** Определяется числом локальных DP-рангов и обычными аргументами модели; сам флаг ничего не меняет.
- **RAM хоста и CPU.** Немного меньше, чем у полноценного узла: нет uvicorn, токенизатора фронтенда и обвязки HTTP. Это побочный эффект, а не повод включать флаг.
- **Сеть.** Весь трафик запросов идет между узлами по ZMQ; тензоры активаций при PP/TP — по `torch.distributed`. Пропускная способность и латентность межузлового канала становятся частью критического пути.
- **Наблюдаемость.** На headless-узле нет ни `/metrics`, ни `/health`. Единственный источник состояния — лог процесса и живость движков; консольная статистика управляется тем же `--disable-log-stats`, что и обычно (`log_stats=not engine_args.disable_log_stats` передается в `CoreEngineProcManager`).

## Взаимодействие с другими аргументами

- `--api-server-count`: взаимоисключающие. Флаг принудительно выставляет счетчик в 0.
- `--data-parallel-size`: должен совпадать на всех узлах — это глобальный размер.
- `--data-parallel-size-local`: сколько рангов поднимает данный узел; обязан быть больше нуля.
- `--data-parallel-start-rank`: с какого глобального ранга начинается этот узел.
- `--data-parallel-address`, `--data-parallel-rpc-port`: адрес рукопожатия с головным узлом; обязаны совпадать с тем, что задано на головном.
- `--data-parallel-hybrid-lb`: несовместим.
- `--nnodes`, `--node-rank`, `--master-addr`, `--master-port`: многоузловой PP/TP; при `node_rank_within_dp > 0` headless-узел становится набором worker'ов.
- `--shutdown-timeout`: определяет, сколько ждать завершения процессов движка при остановке headless-узла.

## Типовые проблемы и диагностика

- **Симптом:** инстанс «запущен», но порт закрыт и health не проходит. **Причина:** `--headless` на одиночном хосте. **Лечение:** убрать флаг.
- **Симптом:** `data_parallel_size_local must be > 0 in headless mode`. **Лечение:** задать число локальных рангов на этом узле.
- **Симптом:** `data_parallel_hybrid_lb is not applicable in headless mode`. **Лечение:** выбрать один режим балансировки.
- **Симптом:** рукопожатие с головным узлом падает с жалобой на `--headless` (лишний или отсутствующий). **Причина:** режим балансировки на узлах не согласован. **Лечение:** привести флаги к одной схеме — internal LB требует headless на неголовных узлах, external и hybrid LB его запрещают.
- **Симптом:** узел висит на старте и ничего не пишет. **Причина:** головной узел недоступен по `--data-parallel-address`/`--data-parallel-rpc-port`. **Проверка:** адрес из строки `Launching N data parallel engine(s) in headless mode, with head node address ...` и доступность порта с этого узла.
- **Подтверждение принятого значения:** одна из двух стартовых строк — `Launching N data parallel engine(s) in headless mode, ...` или `Launching vLLM (vX) headless multiproc executor, with head node address ...`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --headless --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-start-rank 2 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

```bash
vllm serve /models/Qwen3-4B --headless --data-parallel-size 4 --data-parallel-size-local 4 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345 --shutdown-timeout 30
```

## Источники

- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/docs/serving/data_parallel_deployment.md`
- `vllm/docs/serving/expert_parallel_deployment.md`
- `vllm/docs/serving/parallelism_scaling.md`
