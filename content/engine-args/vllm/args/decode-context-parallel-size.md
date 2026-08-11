---
schema: 1
engine: vllm
primaryName: "--decode-context-parallel-size"
title: "--decode-context-parallel-size"
summary: Число рангов, между которыми шардируется KV-cache по оси длины контекста. Не добавляет ни одного процесса и ни одной карты — переиспользует TP-ранги, убирая дублирование KV-cache при `--tensor-parallel-size` больше числа KV-голов модели.
group: ParallelConfig
related:
  - --tensor-parallel-size
  - --prefill-context-parallel-size
  - --dcp-comm-backend
  - --cp-kv-cache-interleave-size
  - --dcp-kv-cache-interleave-size
  - --block-size
  - --max-model-len
  - --gpu-memory-utilization
  - --enable-prefix-caching
  - --data-parallel-size
  - --disable-hybrid-kv-cache-manager
---

# --decode-context-parallel-size

## Кратко

При `--tensor-parallel-size` больше числа KV-голов модели KV-cache начинает **дублироваться**: у MLA-моделей одна KV-голова, поэтому `-tp 8` хранит одну и ту же KV-память восемь раз. `-dcp N` разрезает KV-cache вдоль оси токенов между `N` рангами и убирает это дублирование.

Ключевое свойство: DCP **не расширяет** мир процессов. Карт нужно столько же, сколько задаёт `pp × tp × pcp`; меняется только раскладка KV-памяти внутри уже существующих рангов.

## Оригинальная справка

```text
Number of ranks that shard the decode KV cache. DCP does not expand
the process world size. Without PCP, DCP reuses TP ranks. With PCP, DCP
either spans the PCP axis or the full TP x PCP block.
```

## Паспорт аргумента

- Флаги: `--decode-context-parallel-size`, `-dcp`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: не ограничены списком; валидация `ge=1` плюс проверки соотношения с TP/PCP и с архитектурой модели
- Значение по умолчанию: `Field(default=1, ge=1)` — то есть `1` (DCP выключен) при минимуме `1`
- Эффективное значение: не переопределяется; но задаёт `dcp_world_size`, который умножает эффективный размер блока KV-cache и отключает частичные попадания prefix-cache
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.decode_context_parallel_size`
- Этап применения: сборка `VllmConfig` (валидация) → инициализация группы DCP в worker'е → раскладка KV-cache → attention на каждом шаге декодирования

## Что меняет в движке

**Валидация топологии** (`ParallelConfig._validate_parallel_config`):

- при `--prefill-context-parallel-size 1` DCP переиспользует TP-ранги, поэтому требуется `tp % dcp == 0`: `tp_size={tp} must be divisible by dcp_size={dcp}.`;
- при PCP > 1 допустимы только `dcp ∈ {1, pcp, tp × pcp}`, иначе `When PCP is enabled, DCP must be disabled, span the PCP axis, or span the full TP x PCP axis.`

**Валидация по модели** (`ModelConfig._verify_with_parallel_config`), для не-MLA (GQA/MQA):

- `tp` должен быть строго больше числа KV-голов, иначе шардировать нечего;
- `dcp ≤ tp / total_num_kv_heads`;
- число query-голов на KV-голову должно делиться на `dcp`.

Для MLA-моделей этих ограничений нет — там одна KV-голова по построению.

**KV-cache.** В `single_type_kv_cache_manager` и в координаторе при `dcp_world_size > 1` выполняется `self.block_size *= dcp_world_size`: логический блок покрывает в `dcp` раз больше токенов, потому что каждый ранг хранит лишь свою долю. Гибридные раскладки при DCP ограничены full-attention и Mamba-группами. Частичные попадания prefix-cache отключаются: `enable_partial_hash_hits = dcp_world_size == 1 and ...`.

**Attention.** Порядок раскладки токенов по рангам задаёт `--cp-kv-cache-interleave-size`, а способ сборки частичных результатов — `--dcp-comm-backend`. Для MLA с chunked-prefill рабочая область выравнивается по `lcm(block_size, dcp × cp_kv_cache_interleave_size)`.

## Значения и формат

- Целое `≥ 1`; `1` — DCP выключен.
- Без PCP значение должно делить `--tensor-parallel-size`.
- Верхняя граница для GQA/MQA — `tp / (число KV-голов)`; апстрим-документация формулирует это как «dcp лежит в `[1, tp_size/H]`».
- Практические ориентиры из документации vLLM: DeepSeek-R1 (MLA, 1 KV-голова) при `-tp 8` — `-dcp 8`; Kimi-K2 при `-tp 16` — `-dcp 16` (полное устранение дублирования) или `-dcp 8` (обмен только внутри узла); Qwen3-235B-A22B (4 KV-головы) при `-tp 8` — `-dcp 2`.

## Когда использовать

- Когда `-tp` подняли ради вычислительной мощности, а KV-cache стал дублироваться: типовой признак — `GPU KV cache size` растёт не пропорционально числу карт.
- На MLA-моделях с большим TP — там выигрыш максимальный.
- Порядок действий, рекомендованный апстримом: сначала поднимайте `-tp` до приемлемой производительности, затем добавляйте `-dcp`, чтобы убрать дублирование KV-cache.
- Не используйте на одной карте и на `-tp`, не превышающем число KV-голов: дублирования нет, шардировать нечего.
- Учитывайте потерю частичных попаданий prefix-cache: на нагрузке с длинными общими префиксами выигрыш по ёмкости может быть съеден пересчётом.

## Влияние на производительность и память

- **VRAM.** Основной эффект: KV-cache на каждом ранге уменьшается примерно в `dcp` раз, освободившийся бюджет уходит под большее число блоков. При фиксированном `--gpu-memory-utilization` это прямо повышает `Maximum concurrency`.
- **Обмен.** Платой становится дополнительная коммуникация на каждом шаге декодирования: частичные результаты внимания и LSE собираются по DCP-группе. Чем больше `dcp`, тем выше накладные расходы — апстрим прямо предупреждает об этом компромиссе.
- **Prefix caching.** Частичные попадания отключаются; полные попадания по блокам продолжают работать, но эффективный размер блока умножается на `dcp`.
- **Время старта.** Заметно не меняется.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`: должен делиться на `dcp` (при PCP=1) и превышать число KV-голов для не-MLA моделей.
- `--prefill-context-parallel-size`: меняет допустимый набор значений `dcp` на `{1, pcp, tp × pcp}`.
- `--dcp-comm-backend`: способ сборки частичных выходов; `a2a` требует `dcp > 1`.
- `--cp-kv-cache-interleave-size`, `--dcp-kv-cache-interleave-size`: гранулярность раскладки токенов по DCP-рангам.
- `--block-size`: должен быть не меньше interleave-размера и делиться на него.
- `--gpu-memory-utilization`, `--max-model-len`: DCP меняет цену одного токена KV-cache на ранге, а значит и оценку максимальной длины.
- `--enable-prefix-caching`: частичные попадания при DCP недоступны.
- `--disable-hybrid-kv-cache-manager`: при DCP гибридные раскладки ограничены full-attention и Mamba-группами.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: tp_size=6 must be divisible by dcp_size=4.` **Лечение:** привести `dcp` к делителю TP.
- **Симптом:** `Decode context parallelism for GQA/MQA requires --tensor-parallel-size (N) to be greater than the model's total number of KV heads (M).` **Причина:** дублирования нет. **Лечение:** `-dcp 1` или больший TP.
- **Симптом:** `--decode-context-parallel-size (N) exceeds the maximum supported value (M) for --tensor-parallel-size (T) and K model KV heads.` **Лечение:** взять значение не больше подсказанного.
- **Симптом:** `The model's number of query heads per KV head (N) must be divisible by --decode-context-parallel-size (M) for GQA/MQA.` **Лечение:** выбрать делитель.
- **Симптом:** `When PCP is enabled, DCP must be disabled, span the PCP axis, or span the full TP x PCP axis. ... valid DCP sizes are [...]` **Лечение:** взять значение из подсказанного списка.
- **Симптом:** `DCP with hybrid KV cache layouts only supports full-attention and Mamba groups, got: ...` **Причина:** модель со скользящим окном или другой спецификацией KV. **Лечение:** `-dcp 1`.
- **Подтверждение принятого значения:** строки `GPU KV cache size: N tokens` и `Maximum concurrency for M tokens per request: X.XXx` — при включении DCP на подходящей модели ёмкость растёт кратно; стартовая строка конфига содержит `decode_context_parallel_size=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --tensor-parallel-size 8 --decode-context-parallel-size 8 --gpu-memory-utilization 0.9
```

```bash
vllm serve /models/Qwen3-235B-A22B --tensor-parallel-size 8 --decode-context-parallel-size 2 --block-size 64 --cp-kv-cache-interleave-size 64
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/core/kv_cache_coordinator.py`
- `vllm/vllm/v1/core/single_type_kv_cache_manager.py`
- `vllm/vllm/model_executor/layers/attention/mla_attention.py`
- `vllm/docs/serving/context_parallel_deployment.md`
