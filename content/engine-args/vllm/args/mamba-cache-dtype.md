---
schema: 1
engine: vllm
primaryName: "--mamba-cache-dtype"
title: "--mamba-cache-dtype"
summary: Тип данных состояния mamba-слоев — и conv-state, и ssm-state сразу. Меняет размер mamba-страницы, а через нее и требуемый размер attention-блока в гибридных моделях.
group: CacheConfig
related:
  - --mamba-ssm-cache-dtype
  - --mamba-block-size
  - --mamba-cache-mode
  - --block-size
  - --dtype
  - --enable-mamba-cache-stochastic-rounding
---

# --mamba-cache-dtype

## Кратко

Mamba-слой хранит два тензора состояния: conv-state (окно свертки) и ssm-state (рекуррентное состояние). `--mamba-cache-dtype` задает тип обоих; `--mamba-ssm-cache-dtype` затем может переопределить тип только ssm-state.

Это аналог `--kv-cache-dtype`, но для другой подсистемы: он масштабирует байты на одно состояние, а в гибридных attention/mamba-моделях через размер mamba-страницы влияет и на выбранный размер attention-блока.

## Оригинальная справка

```text
The data type to use for the Mamba cache (both the conv as well as the
ssm state). If set to 'auto', the data type will be inferred from the model
config.
```

## Паспорт аргумента

- Флаги: `--mamba-cache-dtype`
- Группа argparse: `CacheConfig`
- Тип значения: enum (строка)
- Допустимые значения: `auto`, `float32`, `float16`, `bfloat16` (тип `MambaDType` в `vllm/config/cache.py`)
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` разрешается в dtype модели через `get_kv_cache_torch_dtype(mamba_cache_dtype, model_dtype)`; само поле не переопределяется движком
- Где объявлен: `vllm/config/cache.py:CacheConfig.mamba_cache_dtype`
- Этап применения: сборка `VllmConfig` → расчет mamba-страницы и выравнивание блоков → построение `MambaSpec` → forward

## Что меняет в движке

`MambaStateDtypeCalculator._mamba_state_dtype` вычисляет пару dtype:

```
conv_state_dtype = get_kv_cache_torch_dtype(mamba_cache_dtype, model_dtype)
temporal_state_dtype = conv_state_dtype, если mamba_ssm_cache_dtype == "auto", иначе явный тип
```

То есть conv-state управляется только этим аргументом, а ssm-state — этим аргументом плюс `--mamba-ssm-cache-dtype`.

Пара dtype вместе с формами состояний (`get_mamba_state_shape_from_config`) дает `MambaSpec.page_size_bytes` — размер одной mamba-страницы. Для гибридных моделей `_align_hybrid_block_size` требует, чтобы attention-страница была не меньше mamba-страницы, и при необходимости поднимает `cache_config.block_size`, а разницу добивает паддингом (`mamba_page_size_padded`). Поэтому более крупный dtype mamba-состояния способен принудительно увеличить размер блока всего KV-cache.

Некоторые модели переопределяют не этот аргумент, а его ssm-половину: `NemotronHForCausalLMConfig` при `mamba_ssm_cache_dtype == "auto"` подставляет значение из HF-конфига или `float32`.

## Значения и формат

- `auto` — тип берется от модели (`model_config.dtype`).
- `float32` — максимальная точность рекуррентного состояния, вдвое больше байт против bf16/fp16.
- `float16`, `bfloat16` — компактные варианты.
- Специального значения «выключено» нет; аргумент не `optional`.

## Когда использовать

- Повышать до `float32` — когда наблюдается численная деградация на длинных последовательностях, характерная для рекуррентных состояний. Обычно достаточно поднять только ssm-половину через `--mamba-ssm-cache-dtype`, оставив conv-state в dtype модели: это дешевле по памяти.
- Понижать относительно `auto` смысла почти нет: mamba-состояние и так невелико по сравнению с KV-cache attention-слоев, а понижение бьет по точности сильнее.
- Не задавайте `float16` вместе со стохастическим округлением наугад: движок требует именно `float16` **для ssm-кэша**, и проверка смотрит на `--mamba-ssm-cache-dtype`, а не на этот аргумент.

## Влияние на производительность и память

- **VRAM.** Линейно масштабирует байты одного mamba-состояния; общий расход зависит еще и от числа сохраняемых состояний, то есть от `--mamba-cache-mode` и `--mamba-block-size`.
- **Размер блока.** Через требование «attention-страница ≥ mamba-страница» может поднять `--block-size` и, следовательно, ухудшить гранулярность prefix caching.
- **Паддинг.** Чем крупнее mamba-страница, тем меньше относительный паддинг до attention-страницы (или наоборот, если она перевалит за очередную границу). Процент паддинга движок печатает явно.
- **Скорость.** Kernel'ы mamba2 работают с обоими типами; заметного замедления от `float32` для conv-state обычно нет, но трафик памяти растет.

## Взаимодействие с другими аргументами

- `--mamba-ssm-cache-dtype`: переопределяет тип только ssm-state; `auto` там означает «как `--mamba-cache-dtype`».
- `--dtype`: задает `model_config.dtype`, в который разрешается `auto`.
- `--block-size` и `--mamba-block-size`: размер страницы, вычисленный из dtype, определяет их взаимное выравнивание.
- `--mamba-cache-mode`: определяет, сколько состояний хранится; вместе с dtype дает итоговый расход памяти.
- `--enable-mamba-cache-stochastic-rounding`: требует `--mamba-ssm-cache-dtype float16`; conv-state в проверке не участвует.

## Типовые проблемы и диагностика

- **Симптом:** после смены dtype в логе `Setting attention block size to N tokens to ensure that attention page size is >= mamba page size.` и просевший hit rate prefix cache. **Причина:** mamba-страница выросла и потянула за собой attention-блок. **Лечение:** вернуть более компактный dtype либо принять новую гранулярность.
- **Симптом:** `Padding mamba page size by X% ...` с большим процентом. **Причина:** mamba-страница сильно меньше attention-страницы; разница уходит в паддинг. **Лечение:** подобрать dtype/`--block-size` так, чтобы страницы были ближе.
- **Симптом:** `Stochastic rounding for Mamba cache requires the SSM cache to be float16. Please set it explicitly, by specifying --mamba-ssm-cache-dtype float16 ...` **Причина:** включено стохастическое округление, а ssm-кэш не `float16`. **Лечение:** задать именно `--mamba-ssm-cache-dtype float16`.
- **Проверка:** список допустимых значений на своей сборке — `vllm serve --help`; фактический размер страницы косвенно виден по строкам выравнивания блока и по `GPU KV cache size: N tokens`.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --mamba-cache-dtype float32 --enable-prefix-caching
```

```bash
vllm serve /models/Nemotron-H-8B --mamba-cache-dtype bfloat16 --mamba-ssm-cache-dtype float32
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_utils.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_mixer2.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/vllm/platforms/interface.py`
