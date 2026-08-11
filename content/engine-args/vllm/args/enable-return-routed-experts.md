---
schema: 1
engine: vllm
primaryName: "--enable-return-routed-experts"
title: "--enable-return-routed-experts"
summary: Возвращает в ответе, какие эксперты MoE выбрал роутер для каждого токена. Узкоспециальная возможность для RL-пайплайнов, стоящая нескольких гигабайт хостовой RAM и несовместимая с PP и KV-коннекторами.
group: ModelConfig
related:
  - --pipeline-parallel-size
  - --decode-context-parallel-size
  - --kv-transfer-config
  - --enable-prefix-caching
  - --max-num-batched-tokens
---

# --enable-return-routed-experts

## Кратко

Однострочная справка скрывает довольно тяжёлый механизм. При включении vLLM вешает хуки на MoE-слои, собирает `topk_ids` каждого токена на каждом слое, копирует их на хост и складывает в буфер, проиндексированный слотами KV-cache. По завершении запроса маршрутизация возвращается клиенту полем `routed_experts`.

Это инструмент для RL и анализа маршрутизации, а не эксплуатационная ручка. Цена — CPU-буфер, отмасштабированный на **весь** пул KV-блоков, и жёсткие запреты на PP и KV-коннекторы.

## Оригинальная справка

```text
Whether to return routed experts.
```

## Паспорт аргумента

- Флаги: `--enable-return-routed-experts`, `--no-enable-return-routed-experts`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-return-routed-experts` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется; вместо этого несовместимые конфигурации приводят к отказу старта
- Где объявлен: `vllm/config/model.py:ModelConfig.enable_return_routed_experts`
- Этап применения: сборка `VllmConfig` (проверки совместимости) → инициализация KV-cache в worker'е (создание capturer'а) → каждый шаг планировщика и forward → формирование ответа

## Что меняет в движке

**Проверки при сборке конфига** (`VllmConfig.__post_init__`):

- `pipeline_parallel_size > 1` ⇒ `ValueError("--enable-return-routed-experts is incompatible with pipeline parallelism (PP > 1).")`;
- любой KV-коннектор (`kv_transfer_config.is_kv_transfer_instance`) ⇒ `ValueError("--enable-return-routed-experts is incompatible with KV connectors (PD disaggregation, KV cache offload).")` — комментарий в коде объясняет обе причины: при PD-разнесении маршрутизация, снятая на prefill-узле, не доедет до decode-узла, а при offload/sharing меняется семантика `slot_mapping`, на которой держится весь буфер.

**Планировщик** (`vllm/v1/core/sched/scheduler.py`) дополнительно требует `dcp_world_size == 1 and pcp_world_size == 1` («enable_return_routed_experts does not support context parallelism») и создаёт `RoutedExpertsManager`.

**Память менеджера.** `RoutedExpertsManager` выделяет numpy-буфер формы `(num_blocks × block_size, num_layers, num_experts_per_tok)` с типом `uint8`, если экспертов ≤ 256, иначе `uint16`. Это **хостовая** память, отмасштабированная на весь блок-пул, а не на активные запросы. Размер печатается при инициализации:

```
RoutedExpertsManager CPU buffer: %.2f GB (slots=%d, layers=%d, top_k=%d, dtype=%s)
```

Проверяйте эту строку до вывода инстанса в работу: на крупной MoE-модели с большим KV-cache счёт идёт на гигабайты.

**Worker.** После `initialize_kv_cache` вызывается `model_runner.init_routed_experts_capturer()`, который создаёт `RoutedExpertsCapturer` (device-буфер `max_num_batched_tokens × num_layers × top_k × 4` байт в `int32`), привязывает хуки к MoE-слоям и заводит зеркальный pinned-буфер на CPU для неблокирующего D2H.

**Поток данных на шаг.** Worker копирует device-буфер на хост → планировщик в `update_from_output` делает `routed_experts_by_slot[slot_mapping] = data` → при завершении/аборте запроса собирает полную маршрутизацию по снимку block-id, взятому на момент планирования (снимок нужен, потому что асинхронное планирование может освободить блоки раньше).

**Формат ответа.** Поле `routed_experts` в choice-объекте — base64 от `.npy`. После декодирования форма `(num_tokens - 1, num_layers, num_experts_per_tok)`: последний сэмплированный токен ещё не прошёл forward и маршрутизации не имеет. Декодирование: `np.load(io.BytesIO(base64.b64decode(s)))`. Значение `None` означает либо запрос, прерванный до первого forward'а, либо выключенный флаг на сервере.

**Обрезание промпта.** `SamplingParams.routed_experts_prompt_start` позволяет не возвращать маршрутизацию первых N токенов промпта — это per-request параметр, а не аргумент CLI.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- Осмысленен только для MoE-моделей: `_get_routed_experts_shape` требует положительных `num_layers`, `num_experts`, `num_experts_per_tok` и иначе поднимает `ValueError("Routed-experts capture requires positive layer, expert, and experts-per-token counts, got ...")`. На плотной модели старт упадёт этой ошибкой.
- Дополнительных значений или уровней нет.

## Когда использовать

- RL-пайплайн, которому нужна маршрутизация для расчёта наград или для анализа стабильности роутера. Рабочий пример в апстриме — `examples/rl/routed_experts_e2e.py`.
- Исследование распределения нагрузки по экспертам на реальном трафике.
- **Не включайте на обычном инференс-инстансе.** Это тратит хостовую RAM пропорционально размеру KV-cache, добавляет D2H-копию на каждом шаге и запрещает PP и KV-offload.
- Проверьте несовместимости до включения: PP > 1, любой KV-коннектор, decode/prefill context parallel — всё это даёт отказ старта, а не деградацию.

## Влияние на производительность и память

- **Хостовая RAM.** Главная статья: `num_blocks × block_size × num_layers × top_k` байт (или ×2 при более чем 256 экспертах). Растёт вместе с KV-cache — то есть повышение `--gpu-memory-utilization` косвенно увеличивает и этот буфер.
- **VRAM.** Device-буфер capturer'а: `max_num_batched_tokens × num_layers × top_k × 4` байт — по комментарию в исходниках «costs only a few MB per worker».
- **Пропускная способность PCIe.** Каждый шаг несёт D2H-копию собранной маршрутизации; на крупных батчах это единицы мегабайт за шаг.
- **CPU планировщика.** `store_batch` — одно numpy fancy-index присваивание на шаг, дешёвое, но не бесплатное.
- **Trade-off с prefix caching.** Буфер индексируется слотами и переживает вытеснение для кэшированных блоков — это плюс по корректности, но означает, что память под него нельзя уменьшить, не уменьшив KV-cache.

## Взаимодействие с другими аргументами

- `--pipeline-parallel-size`: запрещено больше 1.
- `--kv-transfer-config`: запрещён любой KV-коннектор.
- `--decode-context-parallel-size` (и prefill-аналог): планировщик требует ровно 1.
- `--enable-prefix-caching`: совместим; буфер намеренно привязан к физическим слотам, чтобы попадания в кэш возвращали ту же маршрутизацию.
- `--max-num-batched-tokens`: задаёт размер device-буфера capturer'а.
- `--gpu-memory-utilization`: через число KV-блоков определяет размер хостового буфера.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --enable-return-routed-experts is incompatible with pipeline parallelism (PP > 1).` **Лечение:** снять PP или флаг.
- **Симптом:** `ValueError: --enable-return-routed-experts is incompatible with KV connectors (PD disaggregation, KV cache offload).` **Лечение:** то же — одно из двух.
- **Симптом:** `AssertionError: enable_return_routed_experts does not support context parallelism (dcp_world_size > 1 or pcp_world_size > 1)`. **Лечение:** вернуть context parallel в 1.
- **Симптом:** `ValueError: Routed-experts capture requires positive layer, expert, and experts-per-token counts, got num_layers=32, num_experts=0, num_experts_per_tok=0.` **Причина:** модель не MoE. **Лечение:** снять флаг.
- **Симптом:** хост ушёл в своп после старта. **Причина:** буфер менеджера. **Проверка:** строка `RoutedExpertsManager CPU buffer: X GB (slots=..., layers=..., top_k=..., dtype=...)`. **Лечение:** уменьшить KV-cache (`--gpu-memory-utilization`, `--kv-cache-memory-bytes`) или отказаться от флага.
- **Симптом:** в ответе `routed_experts: null`. **Причина:** запрос прерван до первого forward'а либо флаг на сервере выключен.
- **Подтверждение принятого значения:** строки `Initializing routed experts capturer, enable_return_routed_experts: True` и `RoutedExpertsManager CPU buffer: ...`; в стартовой строке конфига есть `enable_return_routed_experts=True`.

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --enable-return-routed-experts --tensor-parallel-size 2 --attention-backend FLASH_ATTN
```

```bash
vllm serve /models/Qwen3-30B-A3B --enable-return-routed-experts --gpu-memory-utilization 0.7 --max-model-len 4096
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/model_executor/layers/fused_moe/routed_experts_capturer.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `vllm/vllm/sampling_params.py`
- `vllm/examples/rl/routed_experts_e2e.py`
