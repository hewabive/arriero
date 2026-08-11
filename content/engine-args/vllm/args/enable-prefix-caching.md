---
schema: 1
engine: vllm
primaryName: "--enable-prefix-caching"
title: "--enable-prefix-caching"
summary: Включает переиспользование уже посчитанных KV-блоков между запросами с общим префиксом. Не задан — движок решает по модели; выключать имеет смысл ради воспроизводимых замеров или когда префиксы никогда не совпадают.
group: CacheConfig
related:
  - --prefix-caching-hash-algo
  - --prefix-match-unit
  - --block-size
  - --mamba-cache-mode
  - --mamba-block-size
  - --kv-offloading-size
  - --kv-events-config
---

# --enable-prefix-caching

## Кратко

Prefix caching позволяет новому запросу переиспользовать KV-блоки, уже посчитанные для другого запроса с тем же началом промпта: совпавшая часть prefill не считается заново, а берется из block pool по хэшу блока.

Отдельной памяти под это не выделяется — используются те же блоки, что и для активных последовательностей, просто освобожденные блоки не сбрасываются сразу, а остаются кандидатами на попадание. Флаг парный: `--no-enable-prefix-caching` выключает механизм.

## Оригинальная справка

```text
Whether to enable prefix caching.
```

## Паспорт аргумента

- Флаги: `--enable-prefix-caching`, `--no-enable-prefix-caching`
- Группа argparse: `CacheConfig`
- Тип значения: bool (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения (`true`) либо парный `--no-enable-prefix-caching` (`false`); «не задан» — это `None`, то есть «решит движок»
- Значение по умолчанию: `None` в `EngineArgs.enable_prefix_caching`. Само поле датакласса `CacheConfig.enable_prefix_caching` объявлено как `True`, но `EngineArgs` до него никогда не доходит с `None` — значение доопределяется раньше
- Эффективное значение: `EngineArgs._set_default_chunked_prefill_and_prefix_caching_args` подставляет `model_config.is_prefix_caching_supported`. Дополнительно движок может выключить механизм сам: на RISC-V CPU — безусловно, и в `EngineCore._initialize_kv_caches` — если у модели есть non-causal attention-слои
- Где объявлен: `vllm/config/cache.py:CacheConfig.enable_prefix_caching`
- Этап применения: разбор CLI → `create_engine_config` → инициализация KV-cache → планировщик и block pool на каждом шаге

## Что меняет в движке

При включенном prefix caching `EngineCore.__init__` строит `request_block_hasher` — функцию, которая при поступлении запроса считает цепочку хэшей блоков промпта (`get_request_block_hasher`, хэш-функция берется по `--prefix-caching-hash-algo`). Планировщик создает `KVCacheManager` с `enable_caching=True`, и block pool ведет индекс «хэш блока → блок»: освобожденный блок не сбрасывается, а остается в кэше до вытеснения.

Тот же хэшер строится и при выключенном prefix caching, если сконфигурирован KV-connector (`vllm_config.kv_transfer_config is not None`): P/D-дизагрегация и offloading опираются на те же block hashes.

Что решает дефолт: `ModelConfig.is_prefix_caching_supported` возвращает `False` для attention-free и encoder-decoder генеративных моделей, а также для pooling-моделей с bidirectional attention и для pooling с `MEAN`/`CLS`/`STEP`-пулингом; для обычных decoder- и hybrid-моделей — `True`.

Переопределения после старта:

- модель с non-causal attention-слоями: `Disabling prefix caching: model has non-causal attention layers.` — chunked prefill и prefix caching оба ломают non-causal prefill, поэтому оба выключаются;
- RISC-V CPU: `Prefix caching is not supported for RISC-V CPUs; disabling it for V1 backend.`;
- pooling-модель, где вы включили механизм вручную вопреки дефолту: предупреждение `This model does not officially support prefix caching. Enabling this manually may cause the engine to crash or produce incorrect outputs.`

Для mamba и гибридных моделей флаг переключает целый режим кэша: `MambaModelConfig.verify_and_update_config` при включенном prefix caching ставит `mamba_cache_mode` в `align` (если тот был `none`) и приравнивает `mamba_block_size` к `block_size`, а при выключенном — принудительно возвращает `none` и ставит `mamba_block_size = max_model_len`.

## Значения и формат

- `--enable-prefix-caching` — включить.
- `--no-enable-prefix-caching` — выключить.
- Флаг не указан — `None`: движок сам решает по свойствам модели (см. выше). Это не то же самое, что явный `--enable-prefix-caching`: явное включение на pooling-модели даст предупреждение, а неявное просто не включится.

## Когда использовать

- Явно включать стоит, когда нагрузка построена на длинном общем префиксе (системный промпт, few-shot, повторяющийся контекст агента) и вы хотите гарантированного поведения независимо от того, как движок классифицирует модель.
- Явно выключать стоит для воспроизводимых замеров latency/throughput: попадания в кэш делают тайминги зависимыми от истории запросов, и бенчмарк перестает быть сравнимым.
- Выключать также имеет смысл при жестких требованиях к изоляции: общий block pool между запросами разных потребителей означает, что время до первого токена зависит от чужих промптов. Это наблюдаемый side-channel, и он существует независимо от выбранной хэш-функции.
- Не выключайте «ради экономии VRAM»: кэшированные блоки живут в том же пуле и вытесняются, когда нужны под активные запросы.

## Влияние на производительность и память

- **VRAM.** Дополнительной памяти не требуется. Блоки, которые раньше просто освобождались, теперь до вытеснения остаются в кэше.
- **Prefill.** Совпавший префикс не пересчитывается — экономия пропорциональна длине общего префикса. Это единственный источник выигрыша: decode ускорения не получает.
- **Гранулярность.** Попадание возможно только на границе хэш-блока. При одной KV-cache группе она равна `block_size × decode_context_parallel_size`; при нескольких группах — GCD блоков групп либо явный `--prefix-match-unit`.
- **Накладные расходы.** На каждый запрос считается цепочка хэшей блоков промпта; стоимость зависит от `--prefix-caching-hash-algo` (`sha256` по умолчанию, `xxhash` заметно дешевле).
- **Latency.** Разброс TTFT растет: запрос с попаданием отвечает существенно быстрее запроса без него.

## Взаимодействие с другими аргументами

- `--prefix-caching-hash-algo`: выбирает хэш-функцию; читается только когда хэшер вообще строится (prefix caching включен либо активен KV-connector).
- `--prefix-match-unit`: тонкая граница совпадения при нескольких KV-cache группах.
- `--block-size`: определяет физическую границу блока и, при одной группе, границу совпадения префикса.
- `--mamba-cache-mode`, `--mamba-block-size`: на mamba/гибридных моделях полностью зависят от этого флага (см. выше). `--mamba-block-size` вообще запрещен без prefix caching: `--mamba-block-size can only be set with --enable-prefix-caching`. Режим `align` дополнительно требует chunked prefill.
- `--kv-offloading-size`: CPU-offload построен поверх prefix caching. При выключенном prefix caching offload молча отключается с предупреждением `Detected prefix caching disabled, disabling CPU offload since it requires prefix caching.`
- `--kv-events-config`: при включенных KV-событиях и выключенном prefix caching выводится `KV cache events are on, but prefix caching is not enabled. Use --enable-prefix-caching to enable.`

## Типовые проблемы и диагностика

- **Симптом:** `Prefix cache hit rate: 0.0%` в периодическом логе при явно общем префиксе. **Причина:** общий префикс короче одного хэш-блока, либо запросы различаются в самом начале (например, из-за меняющихся служебных заголовков или таймстампа в системном промпте). **Проверка:** счетчики `vllm:prefix_cache_queries` и `vllm:prefix_cache_hits` в `/metrics`. **Лечение:** стабилизировать начало промпта; при нескольких KV-cache группах — уменьшить `--prefix-match-unit`.
- **Симптом:** механизм включен в командной строке, но в логе `Disabling prefix caching: model has non-causal attention layers.` **Причина:** модель содержит non-causal слои; движок выключает и chunked prefill, и prefix caching. **Лечение:** только смена модели — это не настраивается.
- **Симптом:** после включения нестабильные или неверные ответы на pooling-модели. **Причина:** ручное включение вопреки `is_prefix_caching_supported`; предупреждение об этом есть в логе старта. **Лечение:** убрать флаг.
- **Симптом:** непредсказуемые тайминги в бенчмарке. **Причина:** кэш живет между прогонами. **Лечение:** `--no-enable-prefix-caching` либо сброс кэша через `POST /reset_prefix_cache` (dev-роутер) между прогонами.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-prefix-caching --max-model-len 32768
```

```bash
vllm serve /models/Qwen3-4B --no-enable-prefix-caching --max-num-seqs 8
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/v1/simple_cpu_offload_connector.py`
- `vllm/docs/design/prefix_caching.md`
