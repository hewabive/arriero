---
schema: 1
engine: vllm
primaryName: "--kv-sharing-fast-prefill"
title: "--kv-sharing-fast-prefill"
summary: Экспериментальная оптимизация для моделей с разделяемым KV (YOCO-подобных, например Gemma 3n и Gemma 4): слои, читающие чужой KV, на prefill обрабатывают только позиции, нужные для логитов. Работает лишь в моделях, которые ее поддерживают в коде.
group: CacheConfig
related:
  - --speculative-config
  - --max-num-batched-tokens
  - --enforce-eager
---

# --kv-sharing-fast-prefill

## Кратко

В схемах с разделяемым KV (KV sharing, YOCO) часть слоев не заводит собственный KV-cache, а читает уже посчитанный. Для таких слоев на этапе prefill не нужны все токены промпта — достаточно тех позиций, с которых будут сниматься логиты.

Флаг разрешает подменять attention-метаданные у подходящих слоев так, чтобы эта экономия была реализуема. Это не общая оптимизация: выигрыш возникает только в моделях, которые явно ее поддерживают, и апстрим прямо предупреждает, что для корректности нужны изменения на стороне модели.

## Оригинальная справка

```text
In some KV sharing setups, e.g. YOCO (https://arxiv.org/abs/2405.05254),
some layers can skip tokens corresponding to prefill. This flag enables
attention metadata for eligible layers to be overridden with metadata
necessary for implementing this optimization in some models (e.g. Gemma3n)
NOTE: KV cache sharing is not supported for MRv2 (v2 model runner).
```

## Паспорт аргумента

- Флаги: `--kv-sharing-fast-prefill`, `--no-kv-sharing-fast-prefill`
- Группа argparse: `CacheConfig`
- Тип значения: bool (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения (`true`) или парный `--no-kv-sharing-fast-prefill` (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; при включении движок безусловно печатает предупреждение о том, что оптимизация требует поддержки со стороны модели
- Где объявлен: `vllm/config/cache.py:CacheConfig.kv_sharing_fast_prefill`
- Этап применения: сборка `VllmConfig` (валидация и предупреждение) → построение модели → подготовка входов на каждом шаге

## Что меняет в движке

Три независимых эффекта.

1. **Валидация в `VllmConfig`.** При включенном флаге вместе с EAGLE-спекуляцией старт падает: «Fast prefill optimization for KV sharing is not compatible with EAGLE as EAGLE requires correct logits for all tokens while fast prefill gives incorrect logits for prompt tokens.» Это точная формулировка ограничения: при fast prefill логиты промптовых токенов **некорректны**, и любой потребитель, которому они нужны, ломается.
2. **Model runner.** `GPUModelRunner` при включенном флаге заводит статический буфер `kv_sharing_fast_prefill_logits_indices` и на каждом шаге вызывает `_prepare_kv_sharing_fast_prefill`: индексы логитов копируются в буфер, хвост добивается последним индексом (чтобы индексы всегда были валидны для CUDA-graph-паддинга), а декодерная часть модели диспетчеризуется на размер `num_logits`, а не на размер батча. Полные CUDA-графы для этой части исключаются (`invalid_modes={CUDAGraphMode.FULL}`).
3. **Модель.** Флаг читают конкретные реализации: `gemma3n.py` и `gemma4.py` включают по нему альтернативные пути и заводят собственные статические буферы под `max_num_batched_tokens`. Для моделей без такой поддержки флаг меняет только метаданные и буферы, не давая выигрыша.

Отдельно: в списке несовместимостей Model Runner V2 значится «KV sharing fast prefill», поэтому включенный флаг делает V2-раннер недоступным.

## Значения и формат

- `--kv-sharing-fast-prefill` — включить.
- `--no-kv-sharing-fast-prefill` — выключить (значение по умолчанию).
- Промежуточных состояний нет: в отличие от `--enable-prefix-caching`, «не задан» здесь означает именно `false`, а не «решит движок».

## Когда использовать

- Только на моделях, где оптимизация реализована в коде — сегодня это семейства Gemma 3n и Gemma 4 — и только если вы измеряете prefill-latency и видите выигрыш.
- Аргумент экспериментальный: движок сам предупреждает, что «`--kv-sharing-fast-prefill` requires changes on model side for correctness and to realize prefill savings». Не включайте его как «общее ускорение».
- Не включайте вместе со спекулятивным декодированием на EAGLE — старт откажет.
- Не включайте, если вам нужны логиты или эмбеддинги промптовых токенов: они при этой оптимизации неверны.

## Влияние на производительность и память

- **Prefill.** На поддерживающих моделях сокращает объем вычислений в слоях с разделяемым KV пропорционально доле промпта, не участвующей в снятии логитов.
- **VRAM.** Добавляются статические буферы: индексный буфер в model runner и (для Gemma 3n/4) буферы позиций и hidden states размером `max_num_batched_tokens`.
- **CUDA graphs.** Для декодерной части полные графы отключены — на короткие батчи это может стоить части выигрыша от графов.
- **Decode.** Не затрагивается.

## Взаимодействие с другими аргументами

- `--speculative-config`: EAGLE-спекуляция несовместима, старт падает с явным сообщением.
- `--max-num-batched-tokens`: задает размер статических буферов, которые модель аллоцирует под эту оптимизацию.
- `--enforce-eager`: отключает CUDA graphs целиком, поэтому эффект от исключения FULL-режима исчезает.
- Аргументы KV-cache (`--block-size`, `--kv-cache-dtype`) на эту оптимизацию не влияют: она про метаданные внимания, а не про раскладку кэша.

## Типовые проблемы и диагностика

- **Симптом:** `Fast prefill optimization for KV sharing is not compatible with EAGLE ...` на старте. **Причина:** одновременно включены fast prefill и EAGLE-спекуляция. **Лечение:** отключить одно из двух.
- **Симптом:** `Model Runner V2 does not yet support: KV sharing fast prefill`. **Причина:** попытка использовать V2-раннер вместе с флагом. **Лечение:** не включать V2 либо отказаться от флага.
- **Симптом:** флаг включен, prefill не ускорился. **Причина:** модель не реализует оптимизацию. **Проверка:** предупреждение `--kv-sharing-fast-prefill requires changes on model side for correctness and to realize prefill savings.` в логе старта — оно печатается всегда и не означает, что модель поддерживает механизм. **Лечение:** выключить флаг.
- **Симптом:** неверные логиты/скоринг на промптовых токенах, странные результаты pooling-задач. **Причина:** это заявленное поведение оптимизации. **Лечение:** `--no-kv-sharing-fast-prefill`.

## Примеры

```bash
vllm serve /models/gemma-3n-E4B-it --kv-sharing-fast-prefill --max-num-batched-tokens 4096
```

```bash
vllm serve /models/gemma-3n-E4B-it --no-kv-sharing-fast-prefill
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/model_executor/models/gemma3n.py`
- `vllm/vllm/model_executor/models/gemma4.py`
