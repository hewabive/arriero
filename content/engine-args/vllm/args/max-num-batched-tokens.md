---
schema: 1
engine: vllm
primaryName: "--max-num-batched-tokens"
title: "--max-num-batched-tokens"
summary: Бюджет токенов на один forward движка — сколько prefill-кусков и decode-шагов помещается в одну итерацию. Главная ручка компромисса TTFT против ITL и один из двух факторов размера буферов активаций; объявленный дефолт почти никогда не является эффективным.
group: SchedulerConfig
related:
  - --max-num-seqs
  - --max-num-scheduled-tokens
  - --enable-chunked-prefill
  - --max-model-len
  - --long-prefill-token-threshold
  - --gpu-memory-utilization
  - --performance-mode
  - --max-cudagraph-capture-size
  - --speculative-config
  - --async-scheduling
---

# --max-num-batched-tokens

## Кратко

`--max-num-batched-tokens` — это размер одной итерации движка в токенах. Планировщик набирает шаг: сперва decode активных запросов (по одному токену каждый), затем prefill-куски из очереди ожидания, пока бюджет не исчерпан. Из этого же числа выводятся бюджет энкодера, размер `encoder_cache_size`, потолок сеток CUDA graphs и оценка in-flight токенов для KV-cache.

Объявленный в датаклассе дефолт `2048` — тестовый; на CLI дефолт заменен на `None`, и настоящее значение подбирается в `EngineArgs._set_default_max_num_seqs_and_batched_tokens_args` по железу, режиму и остальным флагам.

## Оригинальная справка

```text
Maximum number of tokens that can be processed in a single iteration.

The default value here is mainly for convenience when testing.
In real usage, this should be set in `EngineArgs.create_engine_config`.
```

## Паспорт аргумента

- Флаги: `--max-num-batched-tokens`
- Группа argparse: `SchedulerConfig`
- Тип значения: int; парсер принимает человекочитаемые суффиксы (`8k` = 8000, `8K` = 8192, `1m`, `1M`, `1g`, `1G`)
- Допустимые значения: `>= 1` (валидация `Field(default=..., ge=1)`)
- Значение по умолчанию: в датаклассе `SchedulerConfig.DEFAULT_MAX_NUM_BATCHED_TOKENS = 2048`, но `add_cli_args` ставит CLI-дефолт `None`
- Эффективное значение: подбирается в `_set_default_max_num_seqs_and_batched_tokens_args` по `UsageContext.OPENAI_API_SERVER` и памяти устройства — `2048` для карт < 70 GiB и для A100, `8192` для H100/H200-класса (≥ 70 GiB, не A100), `16384` для карт ≥ 160 GiB; отдельные значения для TPU и CPU; `256` при batched-DP MoE. Потом: удвоение при `--performance-mode throughput`, подъем до `max_model_len` если chunked prefill выключен, подъем до размера крупнейшего мультимодального элемента для prefix-LM моделей и, наконец, `min(max_num_seqs × max_model_len, значение)`
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.max_num_batched_tokens`
- Этап применения: `create_engine_config` → валидация `SchedulerConfig` → размеры CUDA graphs → планировщик, на каждом шаге

## Что меняет в движке

1. **Бюджет шага.** В `Scheduler.schedule()` значение становится `input_budget` — счетчиком реальных входных токенов forward-а. Каждый запланированный запрос вычитает из него `num_new_tokens + draft_slots`, где `draft_slots` — дополнительные слоты спекулятивного декодирования. Параллельно ведется `token_budget` из `max_num_scheduled_tokens` (по умолчанию равен этому же числу).
2. **Мультимодальный энкодер.** `SchedulerConfig.__post_init__` присваивает `max_num_encoder_input_tokens = encoder_cache_size = max_num_batched_tokens`. Оба поля не настраиваются отдельно.
3. **CUDA graphs.** `_set_cudagraph_sizes` берет `max_cudagraph_capture_size = min(max_num_batched_tokens, min(max_num_seqs × decode_query_len × 2, 512 или 1024))`.
4. **Резерв KV под in-flight шаги.** `VllmConfig.max_in_flight_tokens = max_concurrent_batches × max_num_batched_tokens`; это учитывают recycling-aware спецификации KV (sliding window, chunked-local).
5. **Ключ кэша компиляции.** `SchedulerConfig.compute_hash()` включает **только** `max_num_batched_tokens`: LoRA строит статические буферы этого размера, а Inductor выбирает по нему 32- или 64-битную индексацию. Изменение значения инвалидирует кэш torch.compile и вызывает повторную компиляцию при старте.

## Значения и формат

- Целое число токенов, минимум 1. Суффиксы: строчные — десятичные (`8k` = 8000), прописные — двоичные (`8K` = 8192); дробные с двоичным суффиксом запрещены.
- Специальных значений (`0`, `-1`, `auto`) нет: «не задан» означает автоподбор, описанный выше.
- Жесткие проверки на старте (`SchedulerConfig.verify_max_model_len`):
  - `max_num_batched_tokens >= max_num_seqs`, иначе `ValueError`;
  - при выключенном chunked prefill `max_num_batched_tokens >= max_model_len`, иначе `ValueError`;
  - `max_num_batched_tokens > max_num_seqs × max_model_len` — не ошибка, а предупреждение `This may lead to unexpected behavior.`

## Когда использовать

- **Задавайте явно на управляемом сервере.** Эффективный дефолт зависит от модели карты (`get_device_total_memory`), от `--performance-mode`, от режима chunked prefill и от модели; воспроизводимость конфигурации требует явного числа. `docs/VLLM_OPERATIONS.md` (arriero) прямо требует «deliberate» значение.
- **Уменьшайте** (2048 и ниже), если приоритет — стабильная межтокенная задержка у активных потоков: чем меньше кусок prefill, тем меньше он тормозит decode.
- **Увеличивайте** (8192–16384), если приоритет — TTFT и агрегированный throughput на длинных промптах и у вас есть VRAM под большие активации.
- Не увеличивайте «про запас» вместе с большим `--max-num-seqs`: обе величины тянут одну и ту же память, и рост бюджета сначала съедает KV-cache, а потом дает OOM при захвате CUDA graphs.

## Влияние на производительность и память

- **VRAM.** Прямо задает пик активаций и размер буферов энкодера; вместе с `--max-num-seqs` определяет сетку CUDA graphs. Все это вычитается из бюджета `--gpu-memory-utilization` **до** KV-cache, поэтому повышение бюджета шага уменьшает емкость KV-cache.
- **TTFT.** Растет при малом значении: длинный промпт режется на больше кусков.
- **ITL.** Растет при большом значении: decode ждет, пока крупный prefill-кусок отсчитается.
- **Throughput.** Максимум обычно при 8192+ на небольших моделях и крупных картах — рекомендация из `vllm/docs/configuration/optimization.md`.
- **Время старта.** Больший бюджет — больше и дольше захватываемые CUDA graphs; смена значения дополнительно вызывает перекомпиляцию из-за `compute_hash`.

## Взаимодействие с другими аргументами

- `--max-num-seqs`: вторая квота планировщика. Соотношение `max_num_batched_tokens >= max_num_seqs` обязательно; при автоподборе `max_num_seqs` дополнительно зажимается сверху этим значением.
- `--max-num-scheduled-tokens`: отдельный, более узкий потолок «сколько токенов планировщик вправе выдать»; по умолчанию равен `max_num_batched_tokens` и меньше него бывает только при спекулятивном декодировании.
- `--enable-chunked-prefill`: при выключенном chunked prefill появляется жесткое требование `>= max_model_len`.
- `--max-model-len`: вместе с `--max-num-seqs` задает верхнюю границу осмысленного бюджета (`max_num_seqs × max_model_len`).
- `--long-prefill-token-threshold`: режет кусок одного запроса, не трогая общий бюджет шага.
- `--gpu-memory-utilization`: общий бюджет памяти, из которого активации этого размера вычитаются до KV-cache.
- `--performance-mode`: значение `throughput` удваивает автоподобранный бюджет; на явно заданное значение не влияет.
- `--max-cudagraph-capture-size`: явный потолок сеток CUDA graphs, иначе выводимый из этого аргумента.
- `--speculative-config`: draft-слоты расходуют тот же `input_budget`; при малом бюджете старт падает с явной ошибкой.
- `--async-scheduling`: удваивает `max_in_flight_tokens`, который считается от этого значения.

## Типовые проблемы и диагностика

- **Симптом:** `max_num_batched_tokens (128) must be greater than or equal to max_num_seqs (256).` **Лечение:** поднять бюджет или снизить `--max-num-seqs`.
- **Симптом:** предупреждение `max_num_batched_tokens (N) exceeds max_num_seqs * max_model_len (M). This may lead to unexpected behavior.` **Причина:** бюджет заведомо недостижим. **Лечение:** снизить до `max_num_seqs × max_model_len`.
- **Симптом:** `VllmConfig does not have enough slots to schedule a token and support the speculative decoding settings.` **Лечение:** увеличить бюджет или уменьшить `num_speculative_tokens`.
- **Симптом:** OOM на этапе `Capturing CUDA graphs`. **Причина:** сетка графов растет от `max_num_batched_tokens` и `max_num_seqs`. **Лечение:** снизить бюджет, задать `--max-cudagraph-capture-size` или `--enforce-eager`.
- **Симптом:** каждый рестарт заново компилирует модель. **Причина:** значение меняется между запусками — оно входит в `compute_hash` `SchedulerConfig`. **Лечение:** зафиксировать число в конфигурации инстанса.
- **Подтверждение принятого значения:** строка `Chunked prefill is enabled with max_num_batched_tokens=N.` при старте; при выключенном chunked prefill смотрите строку конфигурации движка в логе.
- **Симптом (arriero):** после переезда инстанса на другую карту изменились latency и емкость KV. **Причина:** автоподбор зависит от объема памяти устройства. **Лечение:** задать значение явно в аргументах инстанса.

## Примеры

```bash
vllm serve /models/Qwen3-4B --max-num-batched-tokens 4096 --max-num-seqs 8 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --max-num-batched-tokens 16K --max-num-seqs 64 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/docs/configuration/optimization.md`
- `docs/VLLM_OPERATIONS.md` (arriero)
