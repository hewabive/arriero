---
schema: 1
engine: sglang
primaryName: "--dist-timeout"
title: "--dist-timeout"
summary: Таймаут инициализации `torch.distributed` в секундах; он же наследуется подгруппами (TP, PP, EP, CP). Не задан — берется умолчание самого PyTorch, которое движок не подставляет.
group: parallel
related:
  - --dist-init-addr
  - --nccl-port
  - --nnodes
  - --node-rank
  - --tp-size
  - --pp-size
  - --watchdog-timeout
  - --pre-warm-nccl
  - --load-format
---

# --dist-timeout

## Кратко

`--dist-timeout` уходит прямо в `torch.distributed.init_process_group(timeout=…)` и, что важнее, запоминается в `_MODEL_PARALLEL_GROUP_TIMEOUT`, откуда его наследует **каждая** создаваемая подгруппа: TP, PP, ATTN_CP, DCP, EP. То есть аргумент задает не только окно сбора рангов на старте, но и терпимость коллективов к рассинхронизации в работе. Поднимают его в двух ситуациях: медленный многоузловой старт (узлы поднимаются не одновременно, веса читаются с сетевого хранилища) и длинные операции, во время которых часть рангов простаивает в коллективе.

## Оригинальная справка

```text
Set timeout for torch.distributed initialization.
```

## Паспорт аргумента

- Флаги: `--dist-timeout`
- Группа: `parallel`
- Тип значения: int (секунды), `Optional[int]`
- Допустимые значения: строго положительное целое. `init_distributed_environment` проверяет: `assert isinstance(timeout, (int)), "timeout must be a number"` и `assert timeout > 0, "timeout must be positive"`
- Значение по умолчанию: `null`
- Эффективное значение: при `null` в `init_process_group` передается `timeout=None`, и действует **умолчание PyTorch** (`torch.distributed.constants.default_pg_timeout` в вашей версии torch); SGLang своего значения не подставляет. Проверить фактическое умолчание на своей сборке: `python -c "from torch.distributed.constants import default_pg_timeout; print(default_pg_timeout)"`
- Где объявлен: `ServerArgs.dist_timeout`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `init_torch_distributed` → `init_distributed_environment` (мировая группа) → `initialize_model_parallel` (все подгруппы)

## Что меняет в движке

`init_distributed_environment` (`sglang/python/sglang/srt/distributed/parallel_state.py`):

```python
if timeout is not None:
    assert isinstance(timeout, (int)), "timeout must be a number"
    assert timeout > 0, "timeout must be positive"
    timeout = timedelta(seconds=timeout)
_MODEL_PARALLEL_GROUP_TIMEOUT = timeout
torch.distributed.init_process_group(..., timeout=timeout, ...)
```

Глобальная переменная `_MODEL_PARALLEL_GROUP_TIMEOUT` читается в конструкторе `GroupCoordinator` (`subgroup_timeout = _MODEL_PARALLEL_GROUP_TIMEOUT`) при создании каждой подгруппы, поэтому значение распространяется на весь набор коммуникационных групп. При завершении (`destroy_model_parallel`) переменная сбрасывается в `None`.

Аргумент относится только к слою `torch.distributed`. Он не имеет отношения к:

- зависанию **после** старта под нагрузкой — это `--watchdog-timeout`;
- ожиданию освобождения TCP-портов — это `SGLANG_WAIT_PORT_TIMEOUT`;
- HTTP-таймаутам клиентов.

## Значения и формат

- Целое число секунд, строго `> 0`. Дробные значения argparse отвергнет (тип `int`), а `0` и отрицательные — ассерт в `init_distributed_environment`.
- Не задавать — значит «умолчание PyTorch», а не «без таймаута». Бесконечного значения нет.
- Значение должно быть одинаковым на всех узлах: разные окна ожидания приводят к тому, что одна сторона отваливается раньше другой и диагностика становится односторонней.
- Значение действует и на стартовое рандеву, и на все последующие коллективы подгрупп.

## Когда использовать

- Многоузловой запуск, где узлы стартуют не синхронно: пока первый узел ждет остальных, он сидит в `init_process_group`. Типичное значение для больших моделей — от получаса и выше.
- Загрузка весов с медленного или сетевого хранилища: ранг, который читает дольше, заставляет остальных ждать в коллективе.
- Длинные подготовительные операции на одном ранге (конвертация весов, прогрев, инициализация внешних backend'ов), пока остальные стоят в барьере.
- Не поднимать до огромных значений «на всякий случай»: тогда реальный дедлок вместо внятного отказа превращается в бесконечное молчание. Для этого случая полезнее пара «умеренный `--dist-timeout` + `--soft-watchdog-timeout`».
- Не использовать как лекарство от зависаний в работе: там срабатывает сторожевой пес scheduler'а.

## Влияние на производительность и память

- На производительность и память не влияет: значение задает только предельное время ожидания.
- Влияет на поведение при сбое: слишком маленькое значение превращает медленный, но исправный старт в отказ; слишком большое — растягивает обнаружение реального дедлока.

## Взаимодействие с другими аргументами

- `--dist-init-addr` / `--nccl-port`: определяют, **куда** ранги идут на рандеву; этот аргумент — **сколько** они там ждут.
- `--nnodes` / `--node-rank`: чем больше узлов, тем выше вероятность рассинхронизации старта и тем нужнее запас.
- `--tp-size` / `--pp-size`: определяют число подгрупп, каждая из которых наследует значение.
- `--pre-warm-nccl`: прогрев коллективов выполняется сразу после создания групп и тоже попадает под общий таймаут.
- `--load-format`: способ загрузки весов напрямую влияет на разброс времени готовности рангов.
- `--watchdog-timeout`: соседний, но независимый механизм — он ловит зависания уже в работе.

## Типовые проблемы и диагностика

- Старт останавливается на `Init torch distributed begin.` и через некоторое время падает с ошибкой из `c10d`/NCCL о превышении таймаута — либо узлы не собрались (адрес/порт/firewall), либо один ранг реально дольше готовится. Апстрим-документация для дедлоков дополнительно рекомендует попробовать `--disable-cuda-graph`.
- `AssertionError: timeout must be positive` — задан `0` или отрицательное.
- Ошибка таймаута приходит уже после успешного старта, в коллективе подгруппы — это то же значение, унаследованное подгруппой; поднимать нужно тот же аргумент.
- Значение задано на одном узле и не задано на другом — окна ожидания разъехались; выравнивайте конфигурацию.
- Что смотреть в логе: `dist_timeout=` в дампе `server_args=`, пару строк `Init torch distributed begin.` / `Init torch distributed ends. elapsed=… s, mem usage=… GB` — вторая подтверждает, что сбор группы состоялся.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --dist-timeout 1800
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --nnodes 2 --node-rank 0 --dist-init-addr 192.168.0.2:25000 --dist-timeout 3600
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/utils/network.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
