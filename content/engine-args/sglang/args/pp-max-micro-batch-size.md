---
schema: 1
engine: sglang
primaryName: "--pp-max-micro-batch-size"
title: "--pp-max-micro-batch-size"
summary: Потолок числа запросов в одном микробатче конвейера. Не задан — вычисляется как `max_running_requests // pp_size`; единственный из аргументов PP, который можно менять на работающем сервере.
group: parallel
related:
  - --pp-size
  - --pp-async-batch-depth
  - --max-running-requests
  - --mem-fraction-static
  - --chunked-prefill-size
  - --min-free-slots-delay
  - --disable-overlap-schedule
---

# --pp-max-micro-batch-size

## Кратко

При pipeline parallelism запросы попадают на GPU микробатчами, и `--pp-max-micro-batch-size` задает верхнюю границу их размера: планировщик может добавить в очередной микробатч не более `pp_max_micro_batch_size - running_bs` запросов. Не задан — движок подставляет `max(max_running_requests // pp_size, 1)` уже после того, как узнал реальный `max_running_requests` от воркера. Это единственный аргумент из PP-набора, включенный в белый список `POST /set_internal_state`, то есть его можно менять без перезапуска.

## Оригинальная справка

```text
The maximum micro batch size in pipeline parallelism.
```

## Паспорт аргумента

- Флаги: `--pp-max-micro-batch-size`
- Группа: `parallel`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `None` (авто) либо `>= 1`. Проверка в `check_server_args`: `pp_max_micro_batch_size must be a positive integer or None (for auto-compute). Got: …`
- Значение по умолчанию: `null`
- Эффективное значение: в конструкторе `Scheduler`, после получения `max_running_requests` от воркера, при незаданном значении выполняется `get_context().override("scheduler.pp_max_micro_batch_size_default", pp_max_micro_batch_size=max(self.max_running_requests // self.ps.pp_size, 1))`. То есть эффективная величина зависит от того, каким получился `max_running_requests` (а он, в свою очередь, ограничен сверху `max_total_num_tokens // 2`)
- Где объявлен: `ServerArgs.pp_max_micro_batch_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; изменяем в runtime через `POST /set_internal_state`
- Этап применения: `check_server_args` (валидация) → конструктор `Scheduler` (подстановка умолчания) → каждый вызов `get_num_allocatable_reqs` при формировании микробатча

## Что меняет в движке

Единственная точка чтения на горячем пути (`sglang/python/sglang/srt/managers/scheduler.py`):

```python
def get_num_allocatable_reqs(self, running_bs):
    res = get_parallel().pp_max_micro_batch_size - running_bs
    res = min(res, self.req_to_token_pool.available_size())
    return res
```

То есть значение — это потолок «сколько запросов одновременно может быть в одном микробатче», а не размер батча в токенах. Второй ограничитель — свободные слоты пула `req_to_token`.

### Изменение на работающем сервере

`Scheduler.set_internal_state` разрешает обновление только для узкого списка полей, куда входит `pp_max_micro_batch_size`. Допустимый диапазон проверяется прямо там:

```text
Updating pp_max_micro_batch_size to <v> is rejected because it is out of the valid range [1, <max_running_requests // pp_size>].
```

Запрос выглядит так (пример из комментария в `http_server.py`):

```text
POST /set_internal_state  {"server_args": {"pp_max_micro_batch_size": 8}}
```

Обратите внимание на верхнюю границу: она равна автоматически подобранному умолчанию, поэтому в runtime значение можно только уменьшать относительно него.

## Значения и формат

- Целое `>= 1` либо не задавать (авто).
- `0` и отрицательные отвергаются на старте ассертом.
- Значения больше `max_running_requests // pp_size` на старте формально принимаются (`check_server_args` проверяет только положительность), но в runtime `set_internal_state` такие значения уже отвергнет — граница диапазона там жестче.
- Величина измеряется в **запросах**, не в токенах.
- Без `--pp-size > 1` значение читается, но микробатчей как таковых нет — смысл появляется только с конвейером.

## Когда использовать

- Уменьшать, когда микробатчи слишком велики и вызывают вытеснения из KV-пула: меньше запросов на стадию — меньше одновременно удерживаемых страниц.
- Уменьшать, когда важна latency отдельного запроса: маленький микробатч быстрее проходит конвейер.
- Увеличивать (относительно авто) на старте, если `max_running_requests` мал, а стадии простаивают. Помните, что в runtime поднять выше авто-значения уже не получится.
- Не трогать без `--pp-size > 1`.
- Не путать с `--chunked-prefill-size`: тот ограничивает токены в одном чанке prefill, этот — число запросов в микробатче.

## Влияние на производительность и память

- VRAM: чем больше запросов в микробатче и чем больше слотов в кольце (`--pp-async-batch-depth`), тем больше KV-страниц удерживается одновременно.
- Throughput: слишком маленькое значение оставляет стадии полупустыми и увеличивает долю пузырей конвейера.
- Latency: большое значение увеличивает время прохождения отдельного запроса через стадию.
- На время старта не влияет.
- Пул `req_to_token`: второй ограничитель в `get_num_allocatable_reqs`; при его исчерпании фактический размер микробатча окажется меньше заданного потолка.

## Взаимодействие с другими аргументами

- `--pp-size`: делитель в формуле умолчания; при `pp_size == 1` умолчание вырождается в `max_running_requests`.
- `--max-running-requests`: числитель формулы и общий потолок конкурентности; сам ограничен `max_total_num_tokens // 2`.
- `--pp-async-batch-depth`: число слотов кольца; вместе с этим аргументом определяет пиковую занятость пула.
- `--mem-fraction-static`: через `max_total_num_tokens` косвенно определяет `max_running_requests`, а значит и авто-значение.
- `--min-free-slots-delay`: несовместим с PP — «allocatable slots per microbatch are bounded by pp-max-micro-batch-size, so the threshold may never be reached».
- `--disable-overlap-schedule`: при `--pp-size > 1` включается принудительно.

## Типовые проблемы и диагностика

- `AssertionError: pp_max_micro_batch_size must be a positive integer or None (for auto-compute). Got: 0`
- `Updating pp_max_micro_batch_size to N is rejected because it is out of the valid range [1, M].` — попытка поднять значение в runtime выше авто-границы.
- `AssertionError: --min-free-slots-delay is not supported with pipeline parallelism: …` — конфликт с PP в целом.
- Микробатчи меньше заданного потолка — сработал второй ограничитель, `req_to_token_pool.available_size()`. Смотрите занятость пула и `max_total_num_tokens`.
- Частые вытеснения `KV cache pool is full. Retract requests.` при PP — уменьшите значение либо `--pp-async-batch-depth`.
- Что смотреть: `pp_max_micro_batch_size=` в дампе `server_args=` (там будет `None`, если значение подбирается автоматически — эффективное появится уже в состоянии scheduler'а), `GET /get_internal_state` для текущего эффективного значения, сводка `max_running_requests=…` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --pipeline-parallel-size 2 --disable-overlap-schedule --pp-max-micro-batch-size 8
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --pipeline-parallel-size 4 --disable-overlap-schedule --pp-max-micro-batch-size 4 --max-running-requests 32 --watchdog-timeout 3600
```

## Источники

- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler_pp_mixin.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/runtime_context.py`
- `sglang/docs/docs/advanced_features/pipeline_parallelism.mdx`
