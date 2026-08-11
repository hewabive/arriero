---
schema: 1
engine: vllm
primaryName: "--data-parallel-external-lb"
title: "--data-parallel-external-lb"
summary: Явно включает режим «один процесс — один DP-ранг — свой HTTP-порт», где балансировкой занимается внешний роутер. Нужен только для MoE-моделей и только когда ранг нельзя или не хочется задавать через `--data-parallel-rank`.
group: ParallelConfig
related:
  - --data-parallel-size
  - --data-parallel-rank
  - --data-parallel-size-local
  - --data-parallel-hybrid-lb
  - --data-parallel-multi-port-external-lb
  - --data-parallel-address
  - --data-parallel-rpc-port
  - --api-server-count
  - --enable-fault-tolerance
  - --enable-elastic-ep
  - --node-rank
  - --nnodes
  - --port
---

# --data-parallel-external-lb

## Кратко

Флаг переводит запуск в режим внешней балансировки: процесс обслуживает ровно один DP-ранг, поднимает один API-сервер и ничего не знает про загрузку соседних рангов. Тот же режим включается неявно любым `--data-parallel-rank`, поэтому явный `--data-parallel-external-lb` нужен там, где ранг выводится из `--node-rank` (`--nnodes > 1`), а не задается руками.

Карта всех четырех режимов балансировки — в `--data-parallel-size`.

## Оригинальная справка

```text
Whether to use "external" DP LB mode. Applies only to online serving
and when data_parallel_size > 0. This is useful for a "one-pod-per-rank"
wide-EP setup in Kubernetes. Supported only for MoE deployments; non-MoE
models should use independent vLLM instances without --data-parallel-*
arguments. Set implicitly when --data-parallel-rank is provided explicitly
to vllm serve.
```

## Паспорт аргумента

- Флаги: `--data-parallel-external-lb`, `--no-data-parallel-external-lb`, `-dpe`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо `--no-...`; «не задан» здесь означает именно `False`, а не «решит движок»
- Значение по умолчанию: `false`
- Эффективное значение: в `create_engine_config` используется `data_parallel_external_lb = self.data_parallel_external_lb or self.data_parallel_rank is not None` — то есть режим включается и без флага. Обратный переход тоже бывает: hybrid с `--data-parallel-size-local 1` автоматически превращается в external
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.data_parallel_external_lb`
- Этап применения: разбор CLI → выбор режима LB в `vllm/entrypoints/cli/serve.py` → `create_engine_config` → рукопожатие и запуск локального движка

## Что меняет в движке

1. `--data-parallel-size-local` фиксируется в `1` — каждый процесс держит ровно один engine.
2. `data_parallel_hybrid_lb` сбрасывается в `False`.
3. `--api-server-count` по умолчанию равен `1`: внешний LB и так распределяет запросы.
4. `ParallelConfig.local_engines_only` становится истинным, поэтому клиент управляет только своим локальным движком, а не всеми.
5. Ранг 0 дополнительно держит DP-координатор, с которым рукопожимаются все ранги; ранги `> 0` рукопожимаются со своим локальным движком **и** с фронтендом ранга 0.
6. При `--nnodes > 1` ранг перестает быть входным: `self.data_parallel_rank = inferred_data_parallel_rank`, вывод из `--node-rank` (`Inferred data_parallel_rank %d from node_rank %d for external lb`).

Поле входит в `ignored_factors` `ParallelConfig.compute_hash()`, поэтому само по себе расхождение режима между процессами проверкой согласованности не ловится.

## Значения и формат

- Булев переключатель без аргумента. `--no-data-parallel-external-lb` возвращает `False` (полезно, если значение приходит из `--config`-файла).
- Требует `--data-parallel-size > 1`: `data_parallel_external_lb can only be set when data_parallel_size > 1`.
- Требует, чтобы ранг был известен: либо `--data-parallel-rank`, либо выводимый из `--nnodes` + `--node-rank`.
- Требует MoE-модель, когда `--data-parallel-size > 1`.
- Co-located ранги обязаны различаться `--port`; RPC-порт у них общий.

## Когда использовать

- Kubernetes-раскладка «один под — один ранг» для wide-EP: ingress балансирует между подами, каждый под — самостоятельный эндпоинт с собственными метриками.
- Многоузловое развертывание, где ранг удобнее вывести из `--node-rank`, чем прописывать `--data-parallel-rank` в каждом манифесте.
- Обязателен для `--enable-fault-tolerance`: `Fault tolerance requires external load balancer mode (--data-parallel-external-lb or --data-parallel-rank). Internal LB mode is not supported.`
- Не используйте на плотной модели — там нужны просто независимые инстансы без `--data-parallel-*`.
- Не используйте, если хочется, чтобы vLLM сам распределял запросы по очередям движков: это internal или hybrid LB.

## Влияние на производительность и память

VRAM и скорость forward'а не меняются. Меняется качество балансировки: internal LB учитывает running/waiting-очереди и состояние KV-cache каждого движка, внешний роутер этого не видит, если ему явно не отдать телеметрию. Зато исчезает единый фронтенд-бутылочное горлышко, а `--api-server-count` на процесс равен 1.

## Взаимодействие с другими аргументами

- `--data-parallel-rank`: включает тот же режим неявно; вместе с флагом допустим.
- `--data-parallel-hybrid-lb`: взаимно исключены — `--data-parallel-hybrid-lb и --data-parallel-external-lb cannot be enabled together`.
- `--data-parallel-multi-port-external-lb`: тоже взаимно исключен (супервизор сам выставляет external LB дочерним процессам).
- `--data-parallel-size-local`: допустимо только `1` или пропуск.
- `--enable-fault-tolerance`: требует этот режим и `--api-server-count 1`.
- `--enable-elastic-ep`: наоборот, несовместим — `Elastic EP is not compatible with data_parallel_external_lb or data_parallel_hybrid_lb.`
- `--headless`: бессмысленен, режим предполагает API-сервер в каждом процессе.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: data_parallel_external_lb can only be set when data_parallel_size > 1`. **Лечение:** задать `--data-parallel-size`.
- **Симптом:** `Invalid data-parallel launch options: --data-parallel-external-lb requires a data-parallel rank. Set --data-parallel-rank, or set --data-parallel-size greater than 1 and use --nnodes with --node-rank so the rank can be inferred.` **Лечение:** добавить ранг или пару `--nnodes`/`--node-rank`.
- **Симптом:** `Non-MoE models do not support external data parallel mode.` **Лечение:** независимые инстансы без DP-флагов.
- **Симптом:** `Remote engine N must not use --headless in external or hybrid dp lb mode`. **Причина:** удаленный ранг запущен с `--headless`. **Лечение:** убрать `--headless`.
- **Симптом:** ранги стартуют, но внешний LB видит перекос нагрузки. **Причина:** в этом режиме vLLM не балансирует. **Лечение:** настроить роутер на телеметрию `/metrics` каждого ранга.
- **Подтверждение принятого значения:** `--api-server-count` не поднимается до `--data-parallel-size` (нет строки `Defaulting api_server_count to data_parallel_size (N).`); при выводе ранга из узла — `Inferred data_parallel_rank %d from node_rank %d for external lb`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --data-parallel-external-lb --nnodes 2 --node-rank 1 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --data-parallel-external-lb --data-parallel-rank 0 --port 8000
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/docs/serving/data_parallel_deployment.md`
