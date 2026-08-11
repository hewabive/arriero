---
schema: 1
engine: vllm
primaryName: "--data-parallel-backend"
title: "--data-parallel-backend"
summary: Чем запускаются DP-ранги — локальными процессами (`mp`) или акторами Ray. При `ray` удаленные ранги поднимаются одной командой, но `--nnodes` становится недоступен, а executor по умолчанию тоже переключается на Ray.
group: ParallelConfig
related:
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-address
  - --data-parallel-rpc-port
  - --distributed-executor-backend
  - --nnodes
  - --node-rank
  - --headless
  - --ray-workers-use-nsight
---

# --data-parallel-backend

## Кратко

`--data-parallel-backend` отвечает за то, **кто запускает** DP-ранги, а не за то, как они считают. `mp` (по умолчанию) поднимает engine-процессы локально, поэтому каждый узел нужно стартовать отдельной командой. `ray` поднимает всех рангов через акторы Ray-кластера — одна команда с любого узла, размещение по ресурсам кластера.

Флаг ортогонален `--distributed-executor-backend`, который отвечает за worker'ы **внутри** одного ранга, но при `ray` подталкивает и его к Ray.

## Оригинальная справка

```text
Backend for data parallel, either "mp" or "ray".
```

## Паспорт аргумента

- Флаги: `--data-parallel-backend`, `-dpb`
- Группа argparse: `ParallelConfig`
- Тип значения: str
- Допустимые значения: `mp`, `ray`. В extract `choices: null`, потому что argparse объявлен с голым `type=str`; ограничение накладывает pydantic на `ParallelConfig.data_parallel_backend` (`DataParallelBackend = Literal["ray", "mp"]`), а в `create_engine_config` есть еще и `assert self.data_parallel_backend == "mp"` на ветке автоподстановки адреса
- Значение по умолчанию: `mp`
- Эффективное значение: не переопределяется; но влияет на дефолты соседей — `--data-parallel-address` при `ray` вычисляется как локальный IP, `--distributed-executor-backend` при `ray` становится `ray`, а `--data-parallel-size-local` при `VLLM_RAY_DP_PACK_STRATEGY=span` — единицей
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: разбор CLI → `create_engine_config` → выбор менеджера engine-процессов (`CoreEngineProcManager` против `CoreEngineActorManager`)

## Что меняет в движке

- **`mp`.** `launch_core_engines` создает `CoreEngineProcManager` — обычные дочерние процессы этого запуска. Удаленные ранги живут в других запусках `vllm serve` и приходят на рукопожатие по `--data-parallel-address`/`--data-parallel-rpc-port`. Многоузловой режим описывается `--nnodes`/`--node-rank` либо `--data-parallel-size-local`/`--data-parallel-start-rank`.
- **`ray`.** Создается `CoreEngineActorManager`: ранги размещаются как акторы в placement group'ах Ray. Адрес DP берется с узла запуска (`Using host IP %s as ray-based data parallel address`), `--data-parallel-rpc-port` не нужен. В `ParallelConfig.__post_init__` срабатывает ветка `Using ray distributed inference because data_parallel_backend is ray` — `--distributed-executor-backend` по умолчанию тоже становится `ray`.
- **Проверка узлов.** `--nnodes > 1` требует именно `mp`: `Invalid data-parallel launch options: --nnodes N requires --data-parallel-backend mp`.
- **Порты API-серверов.** В `run_multi_api_server` для Ray-DP отключается отложенное выделение портов (`defer_api_server_ports`), потому что актор получает уже сериализованную конфигурацию и не увидит перепривязку после `bind()`.

## Значения и формат

- `mp` — значение по умолчанию, зависимостей сверх самого vLLM не требует.
- `ray` — требует установленного и запущенного Ray (`ray_utils.assert_ray_available()` падает, если пакета нет). Размещение рангов настраивается переменными окружения `VLLM_RAY_DP_PACK_STRATEGY` (`strict`/`fill`/`span`) и `VLLM_RAY_DP_PLACEMENT_NODE_IPS` — это env-слой, не CLI.
- Любое другое значение отвергается валидацией конфига.

## Когда использовать

- `mp` — всегда, когда развертывание живет на одной машине или когда узлов немного и их удобно стартовать по отдельности. Это единственный вариант для `--nnodes`.
- `ray` — когда Ray-кластер уже есть и хочется одной командой поднять ранги на нескольких узлах, в том числе когда один DP-ранг сам по себе не помещается на узел (тогда нужен `VLLM_RAY_DP_PACK_STRATEGY=span`).
- В arriero инстанс — это один локальный процесс под супервизором; Ray-развертывание выходит за границы управляемого профиля (`docs/VLLM_OPERATIONS.md`), потому что живучестью акторов управляет Ray, а не супервизор arriero.

## Влияние на производительность и память

На арифметику forward'а не влияет. Практические различия: Ray добавляет собственные процессы и накладные расходы на диспетчеризацию, зато снимает ручную раскладку рангов по узлам. `--device-ids` при Ray-executor'е игнорируется, поэтому выбор карт приходится делать placement group'ами.

## Взаимодействие с другими аргументами

- `--nnodes`: только `mp`.
- `--distributed-executor-backend`: при `ray` берется `ray` по умолчанию; явное значение перекрывает.
- `--data-parallel-address`, `--data-parallel-rpc-port`: при `ray` не нужны.
- `--data-parallel-size-local`: при `ray` со стратегией `span` игнорируется и вычисляется автоматически.
- `--ray-workers-use-nsight`: требует Ray-executor'а (`Unable to use nsight profiling unless workers run with Ray.`).
- `--device-ids`: несовместим с Ray-executor'ом (предупреждение и отсутствие эффекта).

## Типовые проблемы и диагностика

- **Симптом:** `Invalid data-parallel launch options: --nnodes 2 requires --data-parallel-backend mp; got --data-parallel-backend ray. Use the MP backend or set --nnodes 1.` **Причина:** попытка совместить два способа описания многоузловости. **Лечение:** оставить один.
- **Симптом:** ошибка про отсутствующий Ray при старте. **Причина:** `ray` выбран, но пакет не установлен. **Лечение:** установить Ray или вернуться на `mp`.
- **Симптом:** предупреждение `--device-ids has no effect when using the Ray executor. Use Ray placement groups for GPU selection instead.` **Причина:** Ray сам решает, какие карты выдать актору. **Лечение:** настраивать placement group'ы.
- **Симптом:** ошибка валидации значения бэкенда. **Причина:** опечатка — argparse не проверяет строку, проверка происходит позже, при сборке `ParallelConfig`. **Лечение:** ровно `mp` или `ray`.
- **Подтверждение принятого значения:** `Starting ray-based data parallel backend` и `Using ray distributed inference because data_parallel_backend is ray` в логе; для `mp` таких строк нет.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-backend ray
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --data-parallel-backend mp --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/envs.py`
- `vllm/docs/serving/data_parallel_deployment.md`
- `docs/VLLM_OPERATIONS.md` (arriero)
