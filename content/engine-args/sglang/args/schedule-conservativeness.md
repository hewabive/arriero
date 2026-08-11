---
schema: 1
engine: sglang
primaryName: "--schedule-conservativeness"
title: "--schedule-conservativeness"
summary: Множитель начального `new_token_ratio` — доли `max_new_tokens`, которую планировщик резервирует под каждый запущенный запрос при допуске новых. Больше значение — меньше retraction и ниже утилизация KV, меньше — наоборот.
group: schedule
related:
  - --schedule-policy
  - --retraction-policy
  - --max-running-requests
  - --mem-fraction-static
  - --chunked-prefill-size
  - --enable-dp-attention
  - --max-total-tokens
---

# --schedule-conservativeness

## Кратко

Планировщик не знает, сколько токенов на самом деле сгенерирует запущенный запрос, поэтому при допуске новых он резервирует под каждый уже работающий запрос долю его оставшегося `max_new_tokens`. Эта доля — `new_token_ratio`, и `--schedule-conservativeness` — прямой множитель ее стартового значения. Ручка нужна ровно в двух ситуациях: сервер слишком осторожен (`token usage` низкий при непустой очереди) или слишком жаден (постоянные `Retract requests` в логе).

## Оригинальная справка

```text
How conservative the schedule policy is. A larger value means more conservative scheduling. Use a larger value if you see requests being retracted frequently.
```

## Паспорт аргумента

- Флаги: `--schedule-conservativeness`
- Группа: `schedule`
- Тип значения: число с плавающей точкой
- Допустимые значения: любое неотрицательное; `assert self.schedule_conservativeness >= 0` в `__post_init__`
- Значение по умолчанию: `1.0`
- Эффективное значение: при `--enable-dp-attention` умножается на `0.3` (`self.schedule_conservativeness = self.schedule_conservativeness * 0.3` в `_handle_data_parallelism`) — то есть с DP attention значение по умолчанию фактически `0.3`
- Где объявлен: `ServerArgs.schedule_conservativeness`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (корректировка под DP) → создание `NewTokenRatioTracker` при инициализации планировщика → каждый проход сборки prefill-батча

## Что меняет в движке

Значение читается один раз, в `NewTokenRatioTracker.from_server_args` (`sglang/python/sglang/srt/managers/scheduler_components/new_token_ratio_tracker.py`):

```python
init = min(SGLANG_INIT_NEW_TOKEN_RATIO * schedule_conservativeness, 1.0)
min_ratio = min(init * SGLANG_MIN_NEW_TOKEN_RATIO_FACTOR, 1.0)
decay = (init - min_ratio) / SGLANG_NEW_TOKEN_RATIO_DECAY_STEPS
```

Значения переменных окружения по умолчанию (`sglang/python/sglang/srt/environ.py`): `SGLANG_INIT_NEW_TOKEN_RATIO=0.7`, `SGLANG_MIN_NEW_TOKEN_RATIO_FACTOR=0.14`, `SGLANG_NEW_TOKEN_RATIO_DECAY_STEPS=600`. То есть при `--schedule-conservativeness 1.0` стартовое `new_token_ratio` равно `0.7`, нижняя граница — `0.098`, а спуск от одного к другому занимает 600 шагов decode.

Где ratio используется. `PrefillAdder` (`sglang/python/sglang/srt/managers/schedule_policy.py`) для каждого **уже запущенного** запроса резервирует

```python
min(max_new_tokens - len(output_ids), CLIP_MAX_NEW_TOKENS) * new_token_ratio
```

токенов (`CLIP_MAX_NEW_TOKENS = 4096`, настраивается `SGLANG_CLIP_MAX_NEW_TOKENS_ESTIMATION`). Сумма этих резервов вычитается из `rem_total_tokens` — бюджета, из которого допускаются новые запросы. Чем выше ratio, тем меньше остается, тем меньше запросов войдет в prefill-батч.

Динамика внутри работы:

- каждый decode-шаг, на котором **не** случилось retraction, вызывает `decay_step()`: ratio уменьшается на `decay` до нижней границы — сервер постепенно становится смелее;
- при retraction (`update_running_batch` → `retract_decode`) ratio скачком заменяется на оценку по факту: `min(1.0, (сумма уже сгенерированных токенов + 20 * число запросов) / (сумма max_new_tokens + 1))`, где 20 — `SGLANG_RETRACT_DECODE_STEPS`;
- когда очередь и running-батч пусты, планировщик вызывает `reset()` и возвращает ratio к `init`.

Таким образом `--schedule-conservativeness` задает только точку старта и потолок этой адаптации, а не постоянное значение.

## Значения и формат

- `1.0` — умолчание: старт с `new_token_ratio = 0.7`.
- Значения ниже 1 (типично `0.3`) — агрессивнее: под запущенные запросы резервируется меньше, в батч входит больше новых.
- Значения выше 1 (типично `1.3`) — консервативнее. Обратите внимание на `min(..., 1.0)`: при `--schedule-conservativeness >= 1.43` стартовое ratio упирается в `1.0` и дальнейший рост значения не меняет ничего — резервируется полный оставшийся `max_new_tokens` (с клипом 4096).
- `0` формально допустимо: ratio станет нулевым, резерв под запущенные запросы исчезнет полностью, и retraction будет практически гарантирован под нагрузкой. Практического смысла не имеет.
- Отрицательное значение отвергает assert в `__post_init__`.

## Когда использовать

- В логе часто `token usage < 0.9` и одновременно `#queue-req > 0` — сервер слишком осторожен, снижайте до `0.3`. Классическая причина: клиенты шлют большой `max_new_tokens`, а запросы завершаются рано по EOS или stop-строке.
- В логе часто `KV cache pool is full. Retract requests.` при высоком `token usage` — повышайте до `1.3`. Редкие retraction (порядка одного в минуту) — норма, реагировать не надо.
- Не трогайте аргумент, если проблема в объеме пула, а не в оценке: сначала `--mem-fraction-static`, потом уже консервативность.
- При `--enable-dp-attention` помните про множитель `0.3`: заданная вами `1.0` превратится в `0.3`, и чтобы получить прежнюю осторожность, значение нужно задавать примерно втрое больше.

## Влияние на производительность и память

- Память не выделяется и не освобождается — меняется только бухгалтерия допуска. Размер KV-пула задан `--mem-fraction-static` и не зависит от этого аргумента.
- Низкое значение поднимает `token usage` и throughput, но повышает частоту retraction; каждый retraction — это выброшенный из батча запрос, который затем пере-prefill'ится целиком (по radix cache может частично попасть в кеш) и получает лишнюю задержку.
- Высокое значение стабилизирует latency и убирает retraction ценой недоиспользованного KV-пула и меньшей конкурентности.
- На VRAM, RAM и время старта влияния нет.

## Взаимодействие с другими аргументами

- `--mem-fraction-static`: реальный размер пула. Если retraction идет постоянно, проверьте сначала его, а не консервативность.
- `--max-running-requests`: жесткий потолок конкурентности; при малом значении резерв на запущенные запросы мал сам по себе, и эффект от консервативности слабее.
- `--retraction-policy`: определяет, кого выкидывать, когда консервативности не хватило.
- `--schedule-policy`: порядок допуска. `lof` в паре с низкой консервативностью особенно легко приводит к retraction — длинные генерации входят первыми.
- `--enable-dp-attention`: молча умножает значение на 0.3.
- `--chunked-prefill-size`: ограничивает объем prefill в одном проходе; при агрессивной консервативности именно он остается последним предохранителем по пиковой памяти prefill.

## Типовые проблемы и диагностика

- `KV cache pool is full. Retract requests. #retracted_reqs: 1, #new_token_ratio: 0.9998 -> 1.0000` — retraction произошел, и трекер поднял ratio почти до предела. Если такие строки идут пачками, повышайте `--schedule-conservativeness`.
- Низкий `token usage` при непустой очереди в строках `Decode batch, #running-req: …, token usage: …, #queue-req: …` — снижайте.
- Принятое значение видно в дампе `server_args=` при старте; при `--enable-dp-attention` там же будет уже умноженное на 0.3.
- Текущее значение ratio в рантайме отдается метрикой планировщика (`stats.new_token_ratio`) при `--enable-metrics` и печатается в сообщении о retraction.
- Если после снижения консервативности появились аборты с текстом `Out of memory even after retracting all other requests in the decode batch` — вы перешли границу, при которой даже один запрос не помещается в пул; это уже вопрос `--mem-fraction-static` и `--context-length`, а не консервативности.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --schedule-conservativeness 0.3 --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --schedule-conservativeness 1.3 --retraction-policy length
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler_components/new_token_ratio_tracker.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
