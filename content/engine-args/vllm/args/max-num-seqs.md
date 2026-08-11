---
schema: 1
engine: vllm
primaryName: "--max-num-seqs"
title: "--max-num-seqs"
summary: Максимальное число запросов в running-очереди, то есть ширина батча по последовательностям. Определяет, где проходит граница между «выполняется» и «ждет в очереди», и вместе с `--max-num-batched-tokens` задает размеры буферов и сеток CUDA graphs.
group: SchedulerConfig
related:
  - --max-num-batched-tokens
  - --max-model-len
  - --gpu-memory-utilization
  - --enable-chunked-prefill
  - --scheduling-policy
  - --watermark
  - --max-cudagraph-capture-size
  - --performance-mode
  - --enforce-eager
  - --max-loras
---

# --max-num-seqs

## Кратко

`--max-num-seqs` — это `Scheduler.max_num_running_reqs`: сколько запросов одновременно находятся в running-очереди и получают токены на каждом шаге. Все, что сверх, лежит в waiting-очереди и ничего не потребляет, кроме памяти хоста под сам запрос.

Значение не про KV-cache напрямую: KV ограничен памятью, а `--max-num-seqs` — жесткий счетчик. Но именно оно определяет, сколько запросов будут одновременно претендовать на KV-блоки, то есть насколько часто планировщик дойдет до вытеснения.

## Оригинальная справка

```text
Maximum number of sequences to be processed in a single iteration.

The default value here is mainly for convenience when testing.
In real usage, this should be set in `EngineArgs.create_engine_config`.
```

## Паспорт аргумента

- Флаги: `--max-num-seqs`
- Группа argparse: `SchedulerConfig`
- Тип значения: int
- Допустимые значения: `>= 1` (валидация `Field(default=..., ge=1)`)
- Значение по умолчанию: в датаклассе `SchedulerConfig.DEFAULT_MAX_NUM_SEQS = 128`, но `add_cli_args` ставит CLI-дефолт `None`
- Эффективное значение: `_set_default_max_num_seqs_and_batched_tokens_args` подставляет `256` для карт < 70 GiB и для A100, `1024` для H100/H200-класса и карт ≥ 160 GiB, `128 × world_size` для CPU-платформы (контекст `OPENAI_API_SERVER`); затем удвоение при `--performance-mode throughput` и финальный зажим `min(max_num_seqs, max_num_batched_tokens)`. Зажим применяется **только** если значение не задано явно
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.max_num_seqs`
- Этап применения: `create_engine_config` → валидация `SchedulerConfig` → размеры CUDA graphs и прогрев сэмплера → планировщик, на каждом шаге

## Что меняет в движке

1. **Граница running/waiting.** В `Scheduler.schedule()` обход waiting-очереди прекращается, как только `len(self.running) + num_waiting_for_streaming_input >= max_num_running_reqs`. Есть и жесткая проверка-инвариант `assert len(self.running) <= self.max_num_running_reqs`.
2. **Ширина персистентного батча.** `GPUModelRunner.max_num_reqs = scheduler_config.max_num_seqs` — от этого зависят размеры входного батча, таблиц блоков и метаданных внимания.
3. **CUDA graphs.** `max_cudagraph_capture_size` по умолчанию равен `min(max_num_seqs × (1 + num_speculative_tokens) × 2, 512 или 1024)` и дополнительно зажат `max_num_batched_tokens`.
4. **Прогрев сэмплера.** `Worker` после захвата графов делает dummy-run на `min(max_num_seqs, max_num_batched_tokens)` запросов, чтобы заранее выделить буферы логитов; именно здесь чаще всего вылезает OOM от завышенного значения.

## Значения и формат

- Целое число запросов, минимум 1. Человекочитаемые суффиксы для этого аргумента **не** включены (в отличие от `--max-num-batched-tokens`).
- Специальных значений нет. «Не задан» означает автоподбор, описанный в паспорте.
- Жесткая проверка: `max_num_batched_tokens >= max_num_seqs`, иначе `ValueError` на старте. При явно заданном `--max-num-seqs` автоматического понижения не происходит — движок падает.

## Когда использовать

- **Задавайте явно на управляемом сервере.** Это не оптимизация, а описание рабочей нагрузки: сколько параллельных диалогов инстанс обязан держать. Дефолт (256 или 1024) на 24-гигабайтной карте с длинным контекстом заведомо недостижим по KV и приводит к постоянным вытеснениям.
- **Понижайте**, если в периодическом логе видны `Preemptions: N` и низкий `Maximum concurrency`: лучше честная очередь, чем вытеснение с пересчетом prefill.
- **Повышайте**, если `Running` регулярно упирается в потолок при низком `GPU KV cache usage` — свободная память есть, а запросы стоят в очереди.
- В arriero это же число задает наблюдаемую границу «активно/в очереди» на прокси-цели: превышение приводит к очереди, а не к 503 (`docs/API_PROXY_FOUNDATION.md`, arriero).

## Влияние на производительность и память

- **VRAM.** Прямо влияет через ширину персистентного батча, буферы логитов и сетку CUDA graphs. Косвенно — через спрос на KV-cache: `max_num_seqs` активных запросов длиной `max_model_len` требуют `max_num_seqs × max_model_len` токенов KV, и если столько нет, разница компенсируется вытеснениями.
- **Throughput.** Растет с ростом значения, пока хватает KV-cache; после этого начинает падать из-за вытеснений и пересчета.
- **Latency.** Каждый дополнительный одновременный запрос удлиняет шаг, то есть увеличивает ITL для всех.
- **Время старта.** Растет: больше сеток CUDA graphs и более широкий прогрев сэмплера.

## Взаимодействие с другими аргументами

- `--max-num-batched-tokens`: обязательное `>=` соотношение; при автоподборе `max_num_seqs` дополнительно зажимается им сверху.
- `--max-model-len`: вместе задают верхнюю оценку спроса на KV; строка `Maximum concurrency for N tokens per request: X.XXx` в логе показывает, сколько запросов полной длины реально помещается — если это число меньше `--max-num-seqs`, вытеснения гарантированы.
- `--gpu-memory-utilization`: единственный способ увеличить KV-cache под уже выбранное число последовательностей.
- `--watermark`: смягчает последствия завышенного `--max-num-seqs`, придерживая свободные блоки при впуске новых и вытесненных запросов.
- `--scheduling-policy`: определяет, кто из ожидающих попадет в running при освободившемся слоте.
- `--enable-chunked-prefill`: при включенном режиме decode-запросы обслуживаются первыми, поэтому большое `--max-num-seqs` сильнее давит на ITL.
- `--max-cudagraph-capture-size`, `--enforce-eager`: ограничивают или отключают вклад этого аргумента в память графов.
- `--performance-mode`: `throughput` удваивает автоподобранное значение.
- `--max-loras`: отдельная квота на число LoRA-адаптеров в шаге; ограничивает состав батча независимо от `--max-num-seqs`.

## Типовые проблемы и диагностика

- **Симптом:** `max_num_batched_tokens (64) must be greater than or equal to max_num_seqs (256).` **Лечение:** поднять `--max-num-batched-tokens` или снизить `--max-num-seqs`.
- **Симптом:** `CUDA out of memory occurred when warming up sampler with N dummy requests. Please try lowering max_num_seqs or gpu_memory_utilization when initializing the engine.` **Причина:** прогрев сэмплера на полном числе запросов не поместился. **Лечение:** снизить значение.
- **Симптом:** `Preemptions: N` в периодическом логе и просадка throughput. **Причина:** одновременных запросов больше, чем помещается в KV-cache. **Проверка:** сравните `--max-num-seqs` со значением `Maximum concurrency` из строки `GPU KV cache size: ...`. **Лечение:** снизить `--max-num-seqs`, поднять `--gpu-memory-utilization` или уменьшить `--max-model-len`.
- **Симптом:** `Waiting: N reqs` стабильно > 0 при `GPU KV cache usage` в единицы процентов. **Причина:** значение занижено. **Лечение:** поднять.
- **Подтверждение принятого значения:** периодический лог `Running: N reqs, Waiting: M reqs` — `N` никогда не превышает заданное число.
- **Симптом (arriero):** прокси-запросы к vLLM-цели ждут вместо выполнения. **Проверка:** `--max-num-seqs`, статус модели (active/queued), приоритет цели и резервирования — порядок разбора описан в `docs/VLLM_OPERATIONS.md` (arriero).

## Примеры

```bash
vllm serve /models/Qwen3-4B --max-num-seqs 8 --max-num-batched-tokens 4096 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --max-num-seqs 64 --gpu-memory-utilization 0.9 --max-model-len 4096
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
- `docs/API_PROXY_FOUNDATION.md` (arriero)
