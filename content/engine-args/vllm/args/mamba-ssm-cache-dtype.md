---
schema: 1
engine: vllm
primaryName: "--mamba-ssm-cache-dtype"
title: "--mamba-ssm-cache-dtype"
summary: Тип данных только для ssm-state mamba-слоев; conv-state остается на --mamba-cache-dtype. Дешевый способ поднять точность рекуррентного состояния и единственный, который принимает проверка стохастического округления.
group: CacheConfig
related:
  - --mamba-cache-dtype
  - --enable-mamba-cache-stochastic-rounding
  - --mamba-block-size
  - --mamba-cache-mode
  - --dtype
---

# --mamba-ssm-cache-dtype

## Кратко

Состояние mamba-слоя состоит из conv-state и ssm-state. Численно чувствителен именно ssm-state: он рекуррентно накапливается по всей последовательности. `--mamba-ssm-cache-dtype` позволяет поднять точность только ему, не удваивая память conv-state.

Значение `auto` здесь означает не «по модели», а «как `--mamba-cache-dtype`»: цепочка разрешения двухступенчатая.

## Оригинальная справка

```text
The data type to use for the Mamba cache (ssm state only, conv state will
still be controlled by mamba_cache_dtype). If set to 'auto', the data type
for the ssm state will be determined by mamba_cache_dtype.
```

## Паспорт аргумента

- Флаги: `--mamba-ssm-cache-dtype`
- Группа argparse: `CacheConfig`
- Тип значения: enum (строка)
- Допустимые значения: `auto`, `float32`, `float16`, `bfloat16` (тип `MambaDType` в `vllm/config/cache.py`)
- Значение по умолчанию: `auto`
- Эффективное значение: для моделей NemotronH `NemotronHForCausalLMConfig.update_mamba_ssm_cache_dtype` при `auto` подставляет `mamba_ssm_cache_dtype` из HF-конфига модели, а при его отсутствии — `float32`, и логирует это (`Updating mamba_ssm_cache_dtype to '%s' for NemotronH model`). Для прочих моделей `auto` разрешается в тип conv-state
- Где объявлен: `vllm/config/cache.py:CacheConfig.mamba_ssm_cache_dtype`
- Этап применения: сборка `VllmConfig` → расчет mamba-страницы и выравнивание блоков → построение `MambaSpec` → forward

## Что меняет в движке

`MambaStateDtypeCalculator._mamba_state_dtype` реализует ровно две строки логики:

```
conv_state_dtype = get_kv_cache_torch_dtype(mamba_cache_dtype, model_dtype)
temporal_state_dtype = conv_state_dtype если mamba_ssm_cache_dtype == "auto" иначе STR_DTYPE_TO_TORCH_DTYPE[mamba_ssm_cache_dtype]
```

Полученная пара определяет `MambaSpec.page_size_bytes`. Дальше действует та же цепочка, что и для `--mamba-cache-dtype`: mamba-страница участвует в выравнивании с attention-страницей, при необходимости поднимая `--block-size` и добавляя паддинг.

Отдельное свойство: проверка стохастического округления смотрит **именно на это поле**. `VllmConfig` падает, если `mamba_config.enable_stochastic_rounding` включено, а `cache_config.mamba_ssm_cache_dtype != "float16"` — причем `auto`, разрешившийся в `float16`, проверку не проходит: сравнивается строковое значение поля.

При `--use-replayssm` к состоянию добавляется кольцевой буфер из трех тензоров, и их типы задаются отдельно: `x_cache` и `B_cache` — в dtype активаций модели, `dt_cache` — всегда `float32`. Этот аргумент на них не влияет.

## Значения и формат

- `auto` — «как `--mamba-cache-dtype`» (для NemotronH — как в HF-конфиге, иначе `float32`).
- `float32` — типичный выбор для устойчивости рекуррентного накопления.
- `float16` — обязателен, если включено стохастическое округление.
- `bfloat16` — компромисс по диапазону/памяти.

## Когда использовать

- Когда на длинном контексте на mamba-модели видны численные артефакты, а поднимать оба состояния до `float32` не хочется: `--mamba-ssm-cache-dtype float32` дешевле, чем `--mamba-cache-dtype float32`.
- Когда включаете `--enable-mamba-cache-stochastic-rounding`: тогда значение обязано быть ровно `float16`, и задавать его надо явно.
- Не задавайте на NemotronH без причины: там `auto` уже даёт осмысленное значение из конфига модели (по умолчанию `float32`, «единственный тип, про который известно, что он не дает проблем с точностью»).
- Понижать до `float16`/`bfloat16` ради экономии не стоит: mamba-состояние мало относительно KV-cache, а деградация точности заметна.

## Влияние на производительность и память

- **VRAM.** Меняет размер только ssm-половины состояния. `float32` вместо `bfloat16` удваивает эту половину, но не conv-state.
- **Размер блока.** Через размер mamba-страницы может потянуть вверх `--block-size` в гибридных моделях.
- **Точность.** Основная причина трогать аргумент: рекуррентное состояние накапливает ошибку по всей длине последовательности.
- **Скорость.** Прямого влияния на kernel нет; растет трафик памяти при чтении/записи состояния.

## Взаимодействие с другими аргументами

- `--mamba-cache-dtype`: задает conv-state и является дефолтом для этого поля при `auto`.
- `--enable-mamba-cache-stochastic-rounding`: жестко требует `float16` **здесь**; проверка не смотрит на `--mamba-cache-dtype`.
- `--dtype`: определяет `model_config.dtype`, в который в конечном счете разрешается цепочка `auto`.
- `--mamba-cache-mode`, `--mamba-block-size`: определяют число хранимых состояний; dtype — цену одного.
- `--block-size`: выравнивается с mamba-страницей в гибридных моделях.

## Типовые проблемы и диагностика

- **Симптом:** `Stochastic rounding for Mamba cache requires the SSM cache to be float16. Please set it explicitly, by specifying --mamba-ssm-cache-dtype float16, or disable stochastic rounding by not specifying --enable-mamba-cache-stochastic-rounding.` **Причина:** поле не равно строке `float16` (в том числе когда оно `auto`, даже если разрешилось бы в fp16). **Лечение:** задать значение явно.
- **Симптом:** на NemotronH в конфиге видно `float32`, хотя ничего не задавали. **Причина:** штатное переопределение `auto` из HF-конфига. **Проверка:** строка `Updating mamba_ssm_cache_dtype to 'float32' for NemotronH model` в логе.
- **Симптом:** после подъема точности вырос `--block-size` и упал hit rate prefix cache. **Причина:** mamba-страница выросла и потянула за собой attention-страницу. **Проверка:** `Setting attention block size to N tokens to ensure that attention page size is >= mamba page size.`
- **Проверка допустимых значений на своей сборке:** `vllm serve --help`.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --mamba-ssm-cache-dtype float32 --enable-prefix-caching
```

```bash
vllm serve /models/Nemotron-H-8B --mamba-ssm-cache-dtype float16 --enable-mamba-cache-stochastic-rounding
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/mamba.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_utils.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/vllm/platforms/interface.py`
