---
schema: 1
engine: vllm
primaryName: "--enable-chunked-prefill"
title: "--enable-chunked-prefill"
summary: Разрешает планировщику резать prefill на куски по остатку бюджета `max_num_batched_tokens` и смешивать их с decode в одном шаге. Включен по умолчанию для генеративных моделей; выключение переводит движок в режим «промпт целиком за один шаг» и ужесточает требование к `--max-num-batched-tokens`.
group: SchedulerConfig
related:
  - --max-num-batched-tokens
  - --max-num-seqs
  - --max-model-len
  - --long-prefill-token-threshold
  - --enable-prefix-caching
  - --scheduler-reserve-full-isl
  - --disable-chunked-mm-input
  - --prefill-schedule-interval
  - --runner
---

# --enable-chunked-prefill

## Кратко

С chunked prefill планировщик не обязан обрабатывать промпт за один шаг: он берет столько токенов, сколько осталось в бюджете шага, и продолжает на следующем. Побочный эффект — в один forward попадают и prefill-куски, и decode активных запросов, что выравнивает загрузку GPU: prefill compute-bound, decode memory-bound.

Аргумент трехпозиционный на уровне CLI: несмотря на `enable_chunked_prefill: bool = True` в датаклассе, `add_cli_args` явно ставит CLI-дефолт `None`, и настоящее значение выбирается по модели в `EngineArgs._set_default_chunked_prefill_and_prefix_caching_args`.

## Оригинальная справка

```text
If True, prefill requests can be chunked based
on the remaining `max_num_batched_tokens`.

The default value here is mainly for convenience when testing.
In real usage, this should be set in `EngineArgs.create_engine_config`.
```

## Паспорт аргумента

- Флаги: `--enable-chunked-prefill`, `--no-enable-chunked-prefill`
- Группа argparse: `SchedulerConfig`
- Тип значения: bool (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: не ограничены сверх пары флагов
- Значение по умолчанию: на CLI — `None` (`add_cli_args` перекрывает объявленный в датаклассе `True`), то есть «решит движок»
- Эффективное значение: `_set_default_chunked_prefill_and_prefix_caching_args` подставляет `model_config.is_chunked_prefill_supported` — `True` для генеративных моделей, `False` для encoder-decoder и для части pooling-моделей. Дальше значение могут перебить: `SchedulerConfig.__post_init__` (encoder-decoder → `False`), RISC-V CPU (`False`), `EngineCore` для модели без KV-cache (`Disabling chunked prefill for model without KVCache`)
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.enable_chunked_prefill`
- Этап применения: `create_engine_config` → валидация `SchedulerConfig` → планировщик, на каждом шаге

## Что меняет в движке

В `Scheduler.schedule()` (`vllm/v1/core/sched/scheduler.py`) для запроса из очереди ожидания считается `num_new_tokens = request.num_tokens − num_computed_tokens`, а затем:

```
if not enable_chunked_prefill and num_new_tokens > request_token_budget:
    break
num_new_tokens = min(num_new_tokens, request_token_budget)
```

То есть с включенным chunked prefill запрос всегда берет `min(нужно, осталось)` и допланируется на следующих шагах; с выключенным — планировщик просто прекращает обход очереди, пока промпт не поместится в шаг целиком.

Из включенного chunked prefill вытекает и приоритет decode: обход начинается с running-очереди (там decode-запросы по одному токену), и только остаток бюджета достается новым prefill.

При старте включенное состояние подтверждается строкой:

```text
Chunked prefill is enabled with max_num_batched_tokens=<N>.
```

## Значения и формат

- **Не задан** — движок берет `is_chunked_prefill_supported` модели. Для обычной генеративной модели это `True`.
- **`--enable-chunked-prefill`** на модели, которая его не поддерживает (pooling с bidirectional attention), даст предупреждение `This model does not officially support chunked prefill. Enabling this manually may cause the engine to crash or produce incorrect outputs.`
- **`--no-enable-chunked-prefill`** на генеративной модели, которая его поддерживает, даст симметричное предупреждение `This model does not officially support disabling chunked prefill ...` и включит жесткое требование `max_num_batched_tokens >= max_model_len`.

## Когда использовать

- Оставьте авто-режим: для генеративных моделей это `True`, и практически весь тюнинг делается через `--max-num-batched-tokens`, а не через этот флаг.
- `--no-enable-chunked-prefill` осмысленен, когда нужно воспроизвести поведение «prefill целиком за шаг» — например, при сравнении с движком, который не умеет chunked prefill, или при отладке ядра внимания на смешанном батче. Готовьтесь поднять `--max-num-batched-tokens` минимум до `--max-model-len`.
- Не выключайте chunked prefill ради «меньшей latency prefill»: это ухудшает ITL активных decode-запросов, потому что длинный prefill монополизирует шаг.

## Влияние на производительность и память

- **ITL (межтокенная задержка).** Главный выигрыш включенного режима: decode не блокируется длинным prefill. При выключении ITL под нагрузкой скачет.
- **TTFT.** Включенный режим слегка ухудшает TTFT длинного промпта — он размазывается на несколько шагов. Управляется размером `--max-num-batched-tokens`.
- **VRAM.** Сам флаг память не выделяет, но меняет требования к `--max-num-batched-tokens`: при выключенном chunked prefill автоподбор поднимает бюджет до `max(max_model_len, дефолт)`, а размеры буферов активаций и CUDA-graph-сеток считаются именно от него. Отключение chunked prefill на длинном контексте — типичный способ неожиданно потерять KV-cache.
- **Время старта.** Косвенно: больший `max_num_batched_tokens` увеличивает объем захватываемых CUDA graphs.

## Взаимодействие с другими аргументами

- `--max-num-batched-tokens`: определяет размер куска. При выключенном chunked prefill действует жесткая проверка `max_num_batched_tokens >= max_model_len`, иначе `ValueError` на старте.
- `--max-model-len`: вторая сторона той же проверки.
- `--max-num-seqs`: независимая квота на число одновременных запросов; `max_num_batched_tokens >= max_num_seqs` обязателен в любом режиме.
- `--long-prefill-token-threshold`: дополнительно ограничивает кусок сверху; при encoder-decoder модели принудительно сбрасывается в `0` вместе с отключением chunked prefill.
- `--scheduler-reserve-full-isl`: компенсирует главный риск chunked prefill — впустить запрос по первому куску и упереться в KV-cache на середине промпта.
- `--disable-chunked-mm-input`: запрещает резать мультимодальный элемент; имеет смысл только при включенном chunked prefill.
- `--enable-prefix-caching`: настраивается тем же методом `_set_default_chunked_prefill_and_prefix_caching_args`, но независимо; отключение одного не отключает второе.
- `--prefill-schedule-interval`: управляет тем, **когда** впускать prefill, а не тем, как его резать.

## Типовые проблемы и диагностика

- **Симптом:** `max_num_batched_tokens (2048) is smaller than max_model_len (32768). This effectively limits the maximum sequence length to max_num_batched_tokens and makes vLLM reject longer sequences. Please increase max_num_batched_tokens or decrease max_model_len.` **Причина:** chunked prefill выключен явно, а бюджет шага задан меньше длины контекста. **Лечение:** вернуть chunked prefill либо поднять `--max-num-batched-tokens` до `--max-model-len`.
- **Симптом:** предупреждение `This model does not officially support disabling chunked prefill. Disabling this manually may cause the engine to crash or produce incorrect outputs.` **Лечение:** снять `--no-enable-chunked-prefill`, если нет конкретной причины его держать.
- **Симптом:** запросы «зависают» в очереди при свободном GPU. **Причина:** chunked prefill выключен и промпт не помещается в остаток бюджета шага — планировщик выходит из обхода очереди (`break`). **Проверка:** растущее `Waiting: N reqs` в периодическом логе при неизменном `Running`. **Лечение:** включить chunked prefill.
- **Симптом:** в логе `Disabling chunked prefill for model without KVCache`. **Причина:** модель без KV-cache (например, чистый энкодер). **Лечение:** ничего, это штатно.
- **Подтверждение принятого значения:** строка `Chunked prefill is enabled with max_num_batched_tokens=N.` при старте. Ее отсутствие означает выключенный режим.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-chunked-prefill --max-num-batched-tokens 4096 --max-model-len 32768
```

```bash
vllm serve /models/Qwen3-4B --no-enable-chunked-prefill --max-model-len 8192 --max-num-batched-tokens 8192
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/docs/configuration/optimization.md`
