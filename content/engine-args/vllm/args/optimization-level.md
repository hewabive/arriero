---
schema: 1
engine: vllm
primaryName: "--optimization-level"
title: "--optimization-level"
summary: Пресет из четырех уровней (`-O0`…`-O3`), который выставляет значения по умолчанию для `--compilation-config` и `--kernel-config`: режим torch.compile, режим CUDA graphs, набор fusion-проходов и автотюнинг FlashInfer. Меняет время старта на скорость работы; явно заданные пользователем поля не перекрывает.
group: VllmConfig
related:
  - --compilation-config
  - --kernel-config
  - --performance-mode
  - --enforce-eager
  - --enable-flashinfer-autotune
  - --cudagraph-capture-sizes
  - --max-cudagraph-capture-size
  - --tensor-parallel-size
---

# --optimization-level

## Кратко

`--optimization-level` — это не отдельная подсистема, а таблица значений по умолчанию. `VllmConfig.__post_init__` берет словарь `OPTIMIZATION_LEVEL_TO_CONFIG[level]` и рекурсивно применяет его к `compilation_config` и `kernel_config` через `_apply_optimization_level_defaults()`. Ключевое свойство: `_set_config_default` записывает значение **только если текущее равно `None`**, поэтому любое поле, заданное через `-cc.…`/`--kernel-config.…`, уровнем не перетирается.

Уровни различаются ровно тремя вещами: включена ли компиляция и CUDA graphs, какие fusion-проходы разрешены и включен ли автотюнинг FlashInfer. Ничего другого уровень не трогает — ни размеры батча, ни память, ни планировщик.

## Оригинальная справка

```text
The optimization level. These levels trade startup time cost for
performance, with -O0 having the best startup time and -O3 having the best
performance. -O2 is used by default. See OptimizationLevel for full
description.
```

## Паспорт аргумента

- Флаги: `--optimization-level`. Формы `-O0`, `-O1`, `-O2`, `-O3`, `-O=3` и `-O 3` не являются argparse-алиасами: их разворачивает препроцессор `FlexibleArgumentParser.parse_args` в `--optimization-level <n>`
- Группа argparse: `VllmConfig`
- Тип значения: целое `0`…`3` (`OptimizationLevel` — `IntEnum`)
- Допустимые значения: `0`, `1`, `2`, `3`. Список `choices` у argparse **отсутствует**: поскольку тип поля не встроенный, `_compute_kwargs` назначает argparse-тип `str`, и значение остается строкой до сборки `VllmConfig`, где его валидирует pydantic. Практическое следствие — ошибка про недопустимый уровень возникает не на разборе CLI, а при создании конфигурации
- Значение по умолчанию: `OptimizationLevel.O2`
- Эффективное значение: сам уровень не переопределяется, но применяется **после** платформенного хука `current_platform.apply_config_platform_defaults(self)` и после `--enforce-eager`/`TORCH_COMPILE_DISABLE`, которые уже могли выставить `compilation_config.mode` и `cudagraph_mode` в `NONE`. Такие значения уровень не восстанавливает
- Где объявлен: `vllm/config/vllm.py:VllmConfig.optimization_level`
- Этап применения: `VllmConfig.__post_init__` — сразу после `kernel_config.set_platform_defaults()` и до расчета сеток CUDA graphs

## Что меняет в движке

Точный набор полей по уровням (`OPTIMIZATION_LEVEL_00`…`_03` в `vllm/config/vllm.py`):

| Поле | `-O0` | `-O1` | `-O2` (по умолчанию) | `-O3` |
| --- | --- | --- | --- | --- |
| `compilation_config.mode` | `NONE` | `VLLM_COMPILE` | `VLLM_COMPILE` | `VLLM_COMPILE` |
| `compilation_config.cudagraph_mode` | `NONE` | `PIECEWISE` | `FULL_AND_PIECEWISE` | `FULL_AND_PIECEWISE` |
| `compilation_config.use_inductor_graph_partition` | `False` | `False` | `False` | `False` |
| `kernel_config.enable_flashinfer_autotune` | `False` | `True` | `True` | `True` |
| `pass_config.fuse_norm_quant` | `False` | по условию | по условию | по условию |
| `pass_config.fuse_act_quant` | `False` | по условию | по условию | по условию |
| `pass_config.fuse_act_padding` | `False` | по условию (ROCm/AITER) | по условию | по условию |
| `pass_config.fuse_mla_dual_rms_norm` | `False` | по условию (ROCm/AITER) | по условию | по условию |
| `pass_config.fuse_allreduce_rms` | `False` | `False` | по условию | по условию |
| `pass_config.fuse_rope_kvcache`, `fuse_qk_norm_rope_kvcache`, `fuse_rope_kvcache_cat_mla` | `False` | `False` | по условию | по условию |
| `pass_config.fuse_attn_quant`, `enable_sp`, `fuse_gemm_comms` | `False` | `False` | `False` | `False` |

`mode` уровень задает не через словарь, а отдельной веткой: если `compilation_config.mode` все еще `None`, он становится `VLLM_COMPILE` при уровне выше `O0` и `NONE` при `O0`.

«По условию» — это функции-предикаты из того же файла, вычисляемые уже на собранном конфиге:

- `fuse_norm_quant` — включается, если активен кастомный `rms_norm` или `quant_fp8`, либо IR-приоритет `rms_norm` не `native` (иначе fusion лучше делает Inductor);
- `fuse_act_quant` — если активен кастомный `silu_and_mul`/`quant_fp8` либо модель квантована в NVFP4;
- `fuse_allreduce_rms` — при `--tensor-parallel-size > 1` на Hopper/Blackwell с установленным FlashInfer (на ROCm — при включенном AITER и TP > 1);
- `fuse_act_padding` — AITER RMSNorm при hidden size 2880 (gpt-oss);
- `fuse_mla_dual_rms_norm`, `fuse_qk_norm_rope_kvcache`, `fuse_rope_kvcache` — ROCm/AITER;
- `fuse_rope_kvcache_cat_mla` — при `use_inductor_graph_partition` или когда splitting ops не содержат обновление KV-cache.

Отдельно стоит знать, что `fuse_attn_quant`, `enable_sp` и `fuse_gemm_comms` в `-O2`/`-O3` привязаны к константам `IS_QUANTIZED = False` и `IS_DENSE = False`. В этом commit'е они выключены на всех уровнях: соответствующая логика по свойствам модели закомментирована со ссылкой на upstream-issue 25689. Не рассчитывайте на sequence parallelism и async-TP «от `-O3`» — их включают вручную через `-cc.pass_config.enable_sp=true`.

`-O3` в этом commit'е побайтово совпадает с `-O2`; upstream оставил уровень как площадку под будущие дорогие оптимизации.

## Значения и формат

- `-O0` — старт как можно быстрее: без torch.compile, без CUDA graphs, без fusion, без автотюнинга.
- `-O1` — компиляция и piecewise CUDA graphs, дешевые fusion-проходы.
- `-O2` — плюс `FULL_AND_PIECEWISE` CUDA graphs и fusion allreduce+RMS; уровень по умолчанию.
- `-O3` — синоним `-O2`.
- Значения вне `0…3` argparse пропускает, но `VllmConfig` отвергает при сборке.
- Записи `-O2`, `-O=2`, `-O 2` и `--optimization-level 2` эквивалентны. Форма `--optimization_level` тоже работает: `FlexibleArgumentParser` считает `-` и `_` в имени флага равнозначными.

## Когда использовать

- **`-O0` при отладке и на быстрых итерациях.** Экономит десятки секунд старта; полезно, когда важно поймать ошибку конфигурации, а не измерить скорость.
- **`-O0` или `-O1`, когда падает сам torch.compile.** Это первый шаг диагностики: если на `-O0` модель поднимается, проблема в компиляции/графах, а не в весах или памяти.
- **`-O2` в эксплуатации.** Уровень по умолчанию и рекомендованный апстримом для production.
- **Не подменяйте уровнем точечные настройки.** Если нужен только другой режим CUDA graphs — задавайте `-cc.cudagraph_mode`, а не понижайте весь уровень: понижение заодно выключит fusion и автотюнинг.
- **Не ждите от `-O3` ускорения** относительно `-O2` в этой версии.

## Влияние на производительность и память

- **Время старта.** Главная статья расхода уровня: `-O0` пропускает компиляцию Inductor, захват CUDA graphs и автотюнинг FlashInfer — это самая заметная часть минуты, которую вLLM тратит до открытия порта.
- **VRAM.** Косвенно: `-O0` не захватывает CUDA graphs, поэтому их оценка не вычитается из бюджета `--gpu-memory-utilization` и под KV-cache остается больше памяти. `-O1` (piecewise) и `-O2` (full + piecewise) требуют больше памяти под графы, причем `FULL_AND_PIECEWISE` — больше всех.
- **Latency/throughput.** `-O0` заметно медленнее на decode из-за отсутствия графов и fusion; разница `-O1` против `-O2` определяется тем, применим ли на вашей конфигурации `fuse_allreduce_rms` (нужен TP > 1 и FlashInfer).
- **Кэш компиляции.** Смена уровня меняет `compilation_config`, а значит и хеш кэша torch.compile: первый запуск после смены уровня компилируется заново.

## Взаимодействие с другими аргументами

- `--compilation-config` (`-cc`): уровень задает значения по умолчанию для его полей; любое явно заданное поле выигрывает. Комбинация `-O0 -cc.cudagraph_mode=PIECEWISE` вполне допустима.
- `--kernel-config`: уровень управляет только полем `enable_flashinfer_autotune`.
- `--enable-flashinfer-autotune`: верхнеуровневый флаг того же поля; задавать его и `--kernel-config.enable_flashinfer_autotune` одновременно запрещено (`... are mutually exclusive`). Если после уровня поле осталось `None`, движок падает с `KernelConfig.enable_flashinfer_autotune must be set after applying optimization level defaults.`
- `--enforce-eager`: применяется раньше и жестче — выставляет `mode=NONE` и `cudagraph_mode=NONE`, и уровень их не возвращает.
- `--performance-mode`: ортогонален. Уровень решает, *как* компилировать и захватывать графы; `--performance-mode` — *какие размеры* графов захватывать и какие батч-лимиты подбирать.
- `--cudagraph-capture-sizes`, `--max-cudagraph-capture-size`: явные размеры сетки; уровень на них не влияет.
- `--tensor-parallel-size`: от него зависит, включится ли `fuse_allreduce_rms` на `-O2`.

## Типовые проблемы и диагностика

- **Симптом:** старт занимает минуту и больше, а нужен быстрый цикл проверок. **Лечение:** `-O0`.
- **Симптом:** падение внутри Inductor/Dynamo при старте. **Проверка:** поднимается ли инстанс с `-O0`. **Лечение:** временно `-O1`/`-O0`, для разбора — `-cc.debug_dump_path`.
- **Симптом:** предупреждение `Inductor compilation was disabled by user settings, optimizations settings that are only active during inductor compilation will be ignored.` **Причина:** `mode` не равен `VLLM_COMPILE` (обычно из-за `-O0`, `--enforce-eager` или `TORCH_COMPILE_DISABLE=1`), а fusion-настройки заданы. **Лечение:** либо вернуть компиляцию, либо убрать бессмысленные настройки.
- **Симптом:** `Cudagraph mode ... is not compatible with compilation mode ... Overriding to NONE.` **Причина:** запрошен piecewise-режим графов без vLLM-компиляции. **Лечение:** согласовать `-O`/`-cc.mode` и `-cc.cudagraph_mode`.
- **Симптом:** каждый рестарт заново компилирует модель. **Причина:** уровень (или любое поле `compilation_config`) меняется между запусками. **Лечение:** зафиксировать уровень в аргументах инстанса.
- **Подтверждение принятого значения:** строка `Final IR op priority after setting platform defaults: ...` печатается всегда, а фактические `mode`/`cudagraph_mode` видны в сводке конфигурации движка при старте; на `-O0` в логе нет ни фазы компиляции, ни `Capturing CUDA graphs`.
- **Симптом (arriero):** после смены уровня инстанс стал не проходить по памяти или, наоборот, освободил VRAM. **Причина:** графы CUDA учитываются в профилировании памяти. **Лечение:** пересчитать оценку памяти инстанса после смены уровня.

## Примеры

```bash
vllm serve /models/Qwen3-4B -O0 --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --optimization-level 2 -cc.cudagraph_mode=PIECEWISE --max-num-seqs 8
```

## Источники

- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/compilation.py`
- `vllm/vllm/config/kernel.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/docs/design/optimization_levels.md`
- `vllm/tests/test_config.py`
