---
schema: 1
engine: vllm
primaryName: "--max-num-scheduled-tokens"
title: "--max-num-scheduled-tokens"
summary: Отдельный потолок «сколько токенов планировщик вправе выдать за итерацию», меньший, чем размер батча воркера. Существует ради спекулятивного декодирования, где модель дописывает в батч draft-слоты сверх запланированного; без спекуляции равен `--max-num-batched-tokens` и трогать его не нужно.
group: SchedulerConfig
related:
  - --max-num-batched-tokens
  - --max-num-seqs
  - --speculative-config
  - --spec-tokens
  - --enable-chunked-prefill
  - --long-prefill-token-threshold
---

# --max-num-scheduled-tokens

## Кратко

В планировщике два счетчика на шаг, а не один. `token_budget` — сколько токенов планировщик разрешает себе выдать; он инициализируется из `--max-num-scheduled-tokens`. `input_budget` — сколько токенов реально уйдет в forward; он инициализируется из `--max-num-batched-tokens` и вычитается с запасом на draft-слоты.

Пока спекулятивного декодирования нет, оба счетчика равны и различие невидимо. Со спекуляцией модель добавляет в батч слоты, которых планировщик не планировал, и второй потолок нужен, чтобы forward не вышел за размер, под который выделены буферы.

## Оригинальная справка

```text
Maximum number of tokens that the scheduler may issue in a single iteration.

This is usually equal to max_num_batched_tokens, but can be smaller in cases
when the model might append tokens into the batch (such as speculative decoding).
Defaults to max_num_batched_tokens.
```

## Паспорт аргумента

- Флаги: `--max-num-scheduled-tokens`
- Группа argparse: `SchedulerConfig`
- Тип значения: int, `optional: true` (допускает `None`); парсер принимает человекочитаемые суффиксы (`8k` = 8000, `8K` = 8192)
- Допустимые значения: `>= 0` (`Field(default=None, ge=0)`); `None` означает «равно `max_num_batched_tokens`»
- Значение по умолчанию: `None` (и в датаклассе, и на CLI)
- Эффективное значение: `VllmConfig._set_max_num_scheduled_tokens()` подставляет `max_num_batched_tokens` — **только** если задан `speculative_config`. Без спекуляции поле остается `None`, и подстановку делает уже сам `Scheduler` в конструкторе
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.max_num_scheduled_tokens`
- Этап применения: сборка `VllmConfig` → планировщик, на каждом шаге

## Что меняет в движке

`Scheduler.__init__` вычисляет

```
self.max_num_scheduled_tokens = scheduler_config.max_num_scheduled_tokens
                                if not None else scheduler_config.max_num_batched_tokens
```

и в `schedule()` использует его как `token_budget`. Каждый запланированный запрос уменьшает `token_budget` на `num_new_tokens`, а `input_budget` — на `num_new_tokens + draft_slots`, где `draft_slots = speculative_config.max_num_new_slots_for_drafting`. В конце шага стоит инвариант `assert total_num_scheduled_tokens <= self.max_num_scheduled_tokens`.

Тот же потолок ограничивает размер prefill-куска при block-aligned разрезе для Mamba-моделей (`_mamba_block_aligned_split`), где он комбинируется с `long_prefill_token_threshold`.

## Значения и формат

- Целое число, минимум 0. `0` формально проходит валидацию поля, но при заданной спекуляции отвергается отдельной проверкой (`max_num_scheduled_tokens is set to 0 ... which does not allow any tokens to be scheduled`), а без спекуляции планировщик просто не сможет ничего запланировать.
- «Не задан» (`None`) — штатный режим: значение равно `--max-num-batched-tokens`.
- Значение больше `--max-num-batched-tokens` не запрещено валидацией, но бессмысленно: реальным ограничителем станет `input_budget`.
- Суффиксы: строчные — десятичные (`4k` = 4000), прописные — двоичные (`4K` = 4096).

## Когда использовать

- В подавляющем большинстве случаев — **не использовать**. Это внутренняя ручка, выставленная наружу; штатный способ управлять размером шага — `--max-num-batched-tokens`.
- Осмысленный сценарий один: спекулятивное декодирование, где вы хотите оставить в forward гарантированный запас под draft-слоты, не уменьшая общий размер батча (и, соответственно, не инвалидируя кэш компиляции, куда входит только `max_num_batched_tokens`).
- Не используйте как «мягкий лимит длины запроса»: длину контекста ограничивает `--max-model-len`, а размер prefill-куска — `--long-prefill-token-threshold`.

## Влияние на производительность и память

- **VRAM.** Собственного вклада нет: буферы активаций, сетки CUDA graphs и `encoder_cache_size` считаются от `--max-num-batched-tokens`. Понижение этого потолка уменьшает фактическую загрузку шага, но не уменьшает выделенную память.
- **Throughput.** Понижение уменьшает наполняемость шага и, соответственно, пропускную способность.
- **Latency.** При спекулятивном декодировании корректный потолок предотвращает переполнение батча draft-слотами; ошибка здесь проявляется как отказ старта, а не как медленная работа.
- **Время старта.** Не влияет и в ключ кэша компиляции не входит.

## Взаимодействие с другими аргументами

- `--max-num-batched-tokens`: источник значения по умолчанию и одновременно верхняя граница полезного диапазона. Разделение появилось именно ради учета draft-слотов.
- `--speculative-config`, `--spec-tokens`: определяют `max_num_new_slots_for_drafting`, то есть насколько `input_budget` расходуется быстрее `token_budget`. Только при заданной спекуляции движок проверяет этот потолок на старте.
- `--max-num-seqs`: независимая квота по числу запросов.
- `--enable-chunked-prefill`, `--long-prefill-token-threshold`: определяют, как оставшийся `token_budget` распределяется между запросами.

## Типовые проблемы и диагностика

- **Симптом:** `max_num_scheduled_tokens is set to N based on the speculative decoding settings, which does not allow any tokens to be scheduled. Increase max_num_batched_tokens to accommodate the additional draft token slots, or decrease num_speculative_tokens.` **Лечение:** ровно то, что написано в сообщении.
- **Симптом:** предупреждение `max_num_scheduled_tokens is set to N based on the speculative decoding settings. This may lead to suboptimal performance.` (при `N < 8192`). **Причина:** бюджет мал для эффективной спекуляции. **Лечение:** увеличить `--max-num-batched-tokens`.
- **Симптом:** `VllmConfig does not have enough slots to schedule a token and support the speculative decoding settings. Got max_num_batched_tokens=... and scheduled_token_delta=...` **Причина:** draft-слотов больше, чем весь бюджет шага. **Лечение:** увеличить бюджет или сократить число спекулятивных токенов.
- **Симптом:** шаги стабильно недозаполнены при свободной памяти. **Проверка:** задан ли этот аргумент меньше `--max-num-batched-tokens`. **Лечение:** снять его и управлять размером шага через `--max-num-batched-tokens`.
- **Подтверждение принятого значения:** отдельной строки лога нет; наблюдаемое следствие — верхняя граница суммы `num_scheduled_tokens` за шаг, видимая в детальном логе итераций (`--enable-logging-iteration-details`).

## Примеры

```bash
vllm serve /models/Qwen3-4B --max-num-batched-tokens 16384 --max-num-scheduled-tokens 8192 --speculative-config '{"method": "ngram", "num_speculative_tokens": 4, "prompt_lookup_max": 4}'
```

```bash
vllm serve /models/Qwen3-4B --max-num-batched-tokens 8192 --max-num-scheduled-tokens 8k --max-num-seqs 16
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/speculative.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/utils/argparse_utils.py`
