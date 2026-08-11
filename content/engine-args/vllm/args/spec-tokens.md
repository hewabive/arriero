---
schema: 1
engine: vllm
primaryName: "--spec-tokens"
title: "--spec-tokens"
summary: Сокращение для ключа `num_speculative_tokens` в `--speculative-config` — сколько токенов драфтер предлагает за один шаг. Прямо задает и стоимость шага, и размер резерва KV-блоков.
group: VllmConfig
related:
  - --speculative-config
  - --spec-method
  - --spec-model
  - --max-num-batched-tokens
  - --max-num-scheduled-tokens
  - --max-num-seqs
  - --max-cudagraph-capture-size
---

# --spec-tokens

## Кратко

`--spec-tokens` кладет значение в `speculative_config["num_speculative_tokens"]`; если `--speculative-config` не задавался, он создается пустым, то есть флаг сам по себе включает спекулятивное декодирование. Это главное число всего механизма: оно задает длину предположения, объем дополнительного резерва KV-блоков и удлинение decode-запроса в CUDA graphs.

Больше — не значит быстрее. Вероятность принять всю цепочку падает с каждой позицией, а платить приходится за всю длину на каждом шаге.

## Оригинальная справка

```text
The number of speculative tokens, if provided. It will default to the
number in the draft model config if present, otherwise, it is required.
```

## Паспорт аргумента

- Флаги: `--spec-tokens`
- Группа argparse: `VllmConfig`
- Тип значения: int
- Допустимые значения: строго `> 0` (`Field(default=None, gt=0)`); дополнительная проверка `num_speculative_tokens <= 0` бросает `Expected num_speculative_tokens to be greater than zero`
- Значение по умолчанию: `None`, несмотря на то что в extract стоит выражение `Field(default=None, gt=0)` — это дефолт `None` при ограничении «строго больше нуля»
- Эффективное значение: если в HF-конфиге драфтера есть `n_predict`, `None` заменяется на него; если `n_predict` есть и значение задано вручную, оно должно быть кратно `n_predict`, иначе старт падает. Для `mtp`-моделей значение больше 1 означает повторный прогон одного и того же MTP-слоя и сопровождается предупреждением о падении доли принятия
- Где объявлен: `vllm/config/speculative.py:SpeculativeConfig.num_speculative_tokens`
- Этап применения: `create_engine_config` → `SpeculativeConfig.__post_init__`/`_verify_args` → расчет резерва KV и сетки CUDA graphs → каждый forward

## Что меняет в движке

1. **Длина предположения.** Драфтер предлагает ровно столько токенов, целевая модель проверяет их одним forward-ом.
2. **Резерв KV-блоков.** `VllmConfig.num_lookahead_tokens` равен `num_speculative_tokens` для eagle-подобных методов и методов с драфт-моделью, `num_speculative_tokens + 1` для `dflash` и `0` для `ngram`/`suffix`. Этот запас выделяется на каждый активный запрос сверх реально записанных токенов.
3. **Слоты планировщика.** `max_num_new_slots_for_drafting` (`num_speculative_tokens - 1` при `parallel_drafting`, плюс 1 для методов с драфт-моделью) вычитается из бюджета шага. `_set_max_num_scheduled_tokens()` проверяет, что бюджета хватает.
4. **CUDA graphs.** `decode_query_len = 1 + num_speculative_tokens` входит в формулу `max_cudagraph_capture_size = min(max_num_seqs × decode_query_len × 2, 512 или 1024)`, то есть увеличение длины спекуляции расширяет сетку графов и удлиняет их захват.
5. **Синтетическая проверка приема.** При `rejection_sample_method: "synthetic"` длина списка `synthetic_acceptance_rates` должна равняться `num_speculative_tokens`, а `synthetic_acceptance_length` лежать в `[1, num_speculative_tokens + 1]`.

## Значения и формат

- Целое положительное число. Специальных значений нет: `0` и отрицательные отвергаются валидацией, «не задан» означает «возьми из конфига драфтера или упади».
- Практический диапазон — 1–5 для методов с драфт-моделью и eagle-голов, 3–8 для `ngram`/`suffix`, где токен ничего не стоит по весам.
- Для MTP-чекпоинтов с `n_predict` допустимы только кратные ему значения.
- Модель Inkling MTP принимает ровно `1`.

## Когда использовать

- Задавайте явно всегда, когда включаете спекуляцию любым методом без `n_predict` — иначе старт упадет.
- Увеличивайте, пока per-position acceptance rate на последней позиции остается заметно выше нуля; как только хвост вектора вырождается, лишние позиции — чистые потери.
- Уменьшайте, если после включения спекуляции просел throughput или ITL: длинная цепочка при низком приеме дороже, чем ее отсутствие.
- Не поднимайте одновременно с `--max-num-seqs`: обе величины умножаются в формуле сетки CUDA graphs и в резерве KV.

## Влияние на производительность и память

- **VRAM.** Прямо увеличивает резерв KV-блоков на каждый активный запрос (`num_lookahead_tokens`) и сетку CUDA graphs. При `draft_sample_method: "probabilistic"` растет и буфер логитов драфтера.
- **Latency.** ITL падает пропорционально средней длине принятия, а не заданному числу токенов. Ориентир — строка `Mean acceptance length` в логе.
- **Throughput.** Падает под нагрузкой: спекулятивные токены занимают тот же бюджет шага, что и реальные.
- **Время старта.** Растет за счет более широкой сетки CUDA graphs.

## Взаимодействие с другими аргументами

- `--speculative-config`: ключ `num_speculative_tokens` и этот флаг взаимоисключающи (`--spec-tokens and --speculative-config['num_speculative_tokens'] are mutually exclusive`).
- `--spec-method`, `--spec-model`: определяют, обязателен ли флаг и какой резерв KV из него выводится.
- `--max-num-batched-tokens`, `--max-num-scheduled-tokens`: бюджет шага, из которого вычитаются draft-слоты.
- `--max-num-seqs`: вместе с `1 + num_speculative_tokens` задает потолок сетки CUDA graphs.
- `--max-cudagraph-capture-size`: способ ограничить разрастание сетки, не уменьшая длину спекуляции.

## Типовые проблемы и диагностика

- **Симптом:** `Expected num_speculative_tokens to be greater than zero (0).` **Лечение:** задать значение `>= 1`.
- **Симптом:** `num_speculative_tokens must be provided with speculative model unless the draft model config contains an n_predict parameter.` **Лечение:** добавить `--spec-tokens`.
- **Симптом:** `num_speculative_tokens:5 must be divisible by n_predict=2`. **Лечение:** взять кратное значение (`2`, `4`, `6`).
- **Симптом:** `Inkling MTP currently supports exactly one speculative token`. **Лечение:** `--spec-tokens 1`.
- **Симптом:** `VllmConfig does not have enough slots to schedule a token and support the speculative decoding settings. Got max_num_batched_tokens=N and scheduled_token_delta=M.` **Лечение:** поднять `--max-num-batched-tokens` или снизить `--spec-tokens`.
- **Симптом:** предупреждение `max_num_scheduled_tokens is set to N based on the speculative decoding settings. This may lead to suboptimal performance.` **Лечение:** увеличить бюджет шага либо принять меньшую длину спекуляции.
- **Симптом:** предупреждение `Enabling num_speculative_tokens > 1 will run multiple times of forward on same MTP layer, which may result in lower acceptance rate`. **Лечение:** для MTP оставить `1`, если замер не подтверждает выигрыш.
- **Подтверждение принятого значения:** периодическая строка `SpecDecoding metrics: Mean acceptance length: X.XX, ..., Per-position acceptance rate: p1, p2, ...` — длина вектора равна заданному числу токенов.

## Примеры

```bash
vllm serve /models/Qwen3-4B --spec-method ngram --spec-tokens 4 --max-num-batched-tokens 4096
```

```bash
vllm serve /models/Qwen3-8B --spec-method draft_model --spec-model /models/Qwen3-0.6B --spec-tokens 2 --max-num-seqs 4
```

## Источники

- `vllm/vllm/config/speculative.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/spec_decode/metrics.py`
