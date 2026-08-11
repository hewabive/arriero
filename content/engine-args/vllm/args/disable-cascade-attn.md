---
schema: 1
engine: vllm
primaryName: "--disable-cascade-attn"
title: "--disable-cascade-attn"
summary: Cascade attention выключен по умолчанию (`True`); включают его парным `--no-disable-cascade-attn`. Даже включённый, он применяется только по эвристике и только на backend'ах, которые его реально поддерживают.
group: ModelConfig
related:
  - --enable-prefix-caching
  - --attention-backend
  - --enforce-eager
  - --speculative-config
  - --async-scheduling
  - --decode-context-parallel-size
---

# --disable-cascade-attn

## Кратко

Cascade attention — оптимизация для батча, где все активные запросы делят длинный общий префикс: вместо того чтобы каждый запрос читал префикс из KV-cache отдельно, один kernel считает внимание к общему префиксу для всех query разом, а второй — к «хвостам».

Обратите внимание на инверсию: дефолт этого поля — `True`, то есть **cascade attention выключен**, и включается он парным флагом `--no-disable-cascade-attn`. Включение — это opt-in в оптимизацию, а не отключение защиты.

## Оригинальная справка

```text
Disable cascade attention for V1. While cascade attention does not
change the mathematical correctness, disabling it could be useful for
preventing potential numerical issues. This defaults to True, so users
must opt in to cascade attention by setting this to False. Even when this
is set to False, cascade attention will only be used when the heuristic
tells that it's beneficial.
```

## Паспорт аргумента

- Флаги: `--disable-cascade-attn`, `--no-disable-cascade-attn`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: `--disable-cascade-attn` ⇒ `True` (выключить cascade), `--no-disable-cascade-attn` ⇒ `False` (разрешить cascade)
- Значение по умолчанию: `True`
- Эффективное значение: принудительно возвращается в `True` в нескольких местах — на CPU-платформе (`vllm/platforms/cpu.py:check_and_update_config`), при `VLLM_BATCH_INVARIANT`, при microbatching/DBO (`--all2all-backend` + ubatching) и при связке async scheduling с speculative decoding
- Где объявлен: `vllm/config/model.py:ModelConfig.disable_cascade_attn`
- Этап применения: сборка `VllmConfig` (переопределения) → инициализация model runner'а → **каждый шаг планировщика** (решение принимается заново на каждом forward)

## Что меняет в движке

**Сборка конфига.** `VllmConfig.__post_init__` может перебить пользовательский `False`:

- `speculative_config` + `scheduler_config.async_scheduling` ⇒ `disable_cascade_attn = True`, лог `Disabling cascade attention (not yet compatible with async speculative decoding).`;
- `envs.VLLM_BATCH_INVARIANT` ⇒ `True`, лог `Disabling cascade attention when VLLM_BATCH_INVARIANT is enabled.`;
- `parallel_config.use_ubatching` ⇒ `True`, лог `Disabling cascade attention when DBO is enabled.`;
- CPU-платформа выставляет `True` безусловно.

Плюс предупреждение при full CUDA graphs без piecewise: `No piecewise cudagraph for executing cascade attention. Will fall back to eager execution if a batch runs into cascade attentions.`

**Runtime.** `GPUModelRunner` держит `self.cascade_attn_enabled = not model_config.disable_cascade_attn`. На каждом шаге, если флаг включён и не используется ubatching, вызывается `_compute_cascade_attn_prefix_lens`, а внутри — `_compute_cascade_attn_prefix_len` для каждой KV-cache-группы:

1. `common_prefix_len = num_common_prefix_blocks × block_size`. Число общих блоков считает планировщик: блок общий, если его `ref_cnt` равен числу запросов с выделенным KV-cache. Такое разделение физических блоков возникает от prefix caching — **без `--enable-prefix-caching` общий префикс всегда 0 и cascade не включится никогда**;
2. длина обрезается по `min(num_computed_tokens)` и вниз до кратности `block_size`;
3. вызывается `attn_metadata_builder.use_cascade_attention(...)`.

**Поддержка на уровне backend'а.** Базовая реализация `AttentionMetadataBuilder.use_cascade_attention` (`vllm/v1/attention/backend.py`) возвращает `False`. Переопределяют её единицы; FlashInfer переопределяет так, что тоже всегда возвращает `False` — вызов настоящей эвристики там закомментирован как неработающий. Содержательная эвристика есть в FlashAttention (`vllm/v1/attention/backends/flash_attn.py:use_cascade_attention`):

- `common_prefix_len < 256` ⇒ нет;
- alibi, sliding window или local attention ⇒ нет;
- меньше 8 запросов в батче ⇒ нет;
- `dcp_world_size > 1` ⇒ нет;
- дальше грубая модель производительности: если для обычного пути не используется FlashDecoding, cascade выбирается; иначе сравниваются оценки числа CTA и волн для cascade и FlashDecoding.

Итог: `--no-disable-cascade-attn` — это разрешение, а не гарантия. На большинстве конфигураций оно не изменит ничего.

## Значения и формат

- Только два состояния. «Не задан» = `True` = cascade выключен.
- `--no-disable-cascade-attn` разрешает cascade; фактическое применение решается за шаг до forward и может меняться от батча к батчу.
- Численные результаты cascade математически эквивалентны обычному пути; расхождения возможны только на уровне точности с плавающей точкой (другой порядок редукций) — именно об этом «potential numerical issues» в справке.

## Когда использовать

- Разрешать (`--no-disable-cascade-attn`) имеет смысл на нагрузке с длинным общим системным промптом и высокой конкурентностью: восемь и больше одновременных запросов, общий префикс от 256 токенов, включённый prefix caching, backend FLASH_ATTN.
- Не разрешать, если вам нужна побитовая воспроизводимость между прогонами: другой порядок суммирования даёт другой последний бит.
- Не разрешать на FLASHINFER — эффекта нет, эвристика backend'а жёстко возвращает `False`.
- Явный `--disable-cascade-attn` (то есть подтверждение дефолта) осмыслен только как самодокументирование запускающего скрипта.

## Влияние на производительность и память

- **VRAM.** Дополнительной памяти cascade не требует: он читает те же блоки KV-cache. Отдельного буфера под него не выделяется.
- **Throughput/latency.** Выигрыш — в экономии полосы памяти при чтении общего префикса; он растёт с длиной префикса и числом одновременных запросов, и обнуляется, когда эвристика решает, что FlashDecoding быстрее.
- **CUDA graphs.** Батч, ушедший в cascade, не имеет piecewise-графа и исполняется eager (см. предупреждение выше). На конфигурации с full CUDA graphs это означает нерегулярные всплески latency: часть шагов идёт по графу, часть — нет.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: фактическая предпосылка. Без общих физических блоков `num_common_prefix_blocks` всегда 0.
- `--attention-backend`: решает всё. FLASH_ATTN — единственный backend с содержательной эвристикой; FLASHINFER, FLEX_ATTENTION, ROCm-варианты и CPU возвращают `False`.
- `--enforce-eager`: убирает CUDA graphs целиком, поэтому предупреждение про piecewise перестаёт быть актуальным; сама cascade-логика продолжает работать.
- `--speculative-config` вместе с `--async-scheduling`: принудительно выключает cascade.
- `--decode-context-parallel-size` > 1: эвристика FlashAttention отказывает.

## Типовые проблемы и диагностика

- **Симптом:** `--no-disable-cascade-attn` задан, а прироста нет. **Причина:** не выполнено одно из условий эвристики (короткий префикс, менее 8 запросов, sliding window, не тот backend). **Проверка:** строка `Using ... attention backend out of potential backends: ...` в логе старта и профиль нагрузки.
- **Симптом:** в логе `No piecewise cudagraph for executing cascade attention. Will fall back to eager execution if a batch runs into cascade attentions.` **Причина:** full CUDA graphs без piecewise при разрешённом cascade. **Лечение:** либо вернуть дефолт `--disable-cascade-attn`, либо перейти на piecewise-режим CUDA graphs.
- **Симптом:** в логе `Disabling cascade attention (not yet compatible with async speculative decoding).` / `Disabling cascade attention when DBO is enabled.` / `Disabling cascade attention when VLLM_BATCH_INVARIANT is enabled.` **Причина:** штатное переопределение вашего `False`. **Действие:** ничего; это не ошибка конфигурации.
- **Симптом:** результаты перестали совпадать бит-в-бит между запусками. **Причина:** cascade меняет порядок редукций. **Лечение:** дефолтное значение либо `VLLM_BATCH_INVARIANT` (который сам выключит cascade).
- **Подтверждение принятого значения:** прямой строки «cascade enabled» нет; ориентируйтесь на перечисленные warning'и и на выбранный attention backend.

## Примеры

```bash
vllm serve /models/Qwen3-4B --no-disable-cascade-attn --enable-prefix-caching --attention-backend FLASH_ATTN
```

```bash
vllm serve /models/Qwen3-4B --disable-cascade-attn --max-num-seqs 16
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/platforms/cpu.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/attention/backend.py`
- `vllm/vllm/v1/attention/backends/flash_attn.py`
- `vllm/vllm/v1/attention/backends/flashinfer.py`
- `vllm/vllm/v1/core/single_type_kv_cache_manager.py`
