---
schema: 1
engine: vllm
primaryName: "--compilation-config"
title: "--compilation-config"
summary: JSON-объект `CompilationConfig` — все настройки torch.compile и захвата CUDA graphs: режим компиляции, режим и размеры графов, набор fusion-проходов, кастомные операторы, каталог кэша. Самый частый способ точечно поправить то, что выставил `--optimization-level`.
group: VllmConfig
related:
  - --optimization-level
  - --performance-mode
  - --enforce-eager
  - --cudagraph-capture-sizes
  - --max-cudagraph-capture-size
  - --kernel-config
  - --gpu-memory-utilization
  - --max-num-batched-tokens
  - --max-num-seqs
---

# --compilation-config

## Кратко

`--compilation-config` (алиас `-cc`) целиком заполняет датакласс `CompilationConfig` (`vllm/config/compilation.py`) — крупнейший конфиг vLLM, отвечающий за две смежные, но независимые вещи: компиляцию модели через torch.compile/Inductor и захват CUDA graphs.

В отличие от большинства JSON-аргументов, значение здесь **валидируется прямо на разборе CLI**: `_compute_kwargs` находит датакласс и ставит argparse-тип `TypeAdapter(CompilationConfig).validate_json`, поэтому опечатка в ключе или недопустимое значение дают ошибку до загрузки весов.

Почти все его поля объявлены со значением `None` — это «решит движок»: сначала платформенный хук, затем таблица `--optimization-level`, и только незаполненные после этого поля получают жесткие значения.

## Оригинальная справка

```text
`torch.compile` and cudagraph capture configuration for the model.

As a shorthand, one can append compilation arguments via
-cc.parameter=argument such as `-cc.mode=3` (same as `-cc='{"mode":3}'`).

You can specify the full compilation config like so:
`{"mode": 3, "cudagraph_capture_sizes": [1, 2, 4, 8]}`
```

## Паспорт аргумента

- Флаги: `--compilation-config`, `-cc`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `-cc.<поле> <значение>`)
- Допустимые значения: поля `CompilationConfig`; ключевые перечислены ниже
- Значение по умолчанию: `Field(default_factory=CompilationConfig)` — конструируется объект со всеми значениями по умолчанию, а не `None`
- Эффективное значение: переопределяется многократно. `VllmConfig.__post_init__` в таком порядке: `--enforce-eager` и `TORCH_COMPILE_DISABLE=1` ставят `mode=NONE` и `cudagraph_mode=NONE`; breakable-cudagraph ставит `mode=NONE`; блочно-квантованные веса добавляют `+quant_fp8` в `custom_ops`; `current_platform.apply_config_platform_defaults()`; `mode` из `--optimization-level`, если он еще `None`; `ir_enable_torch_wrap`; автодобавление `none`/`all` в `custom_ops`; таблица `--optimization-level` для `cudagraph_mode`, `use_inductor_graph_partition` и `pass_config`; понижение `cudagraph_mode` до `NONE` при несовместимости с `mode`; понижение до `PIECEWISE` при динамической спекуляции; отключение `enable_sp`/`fuse_gemm_comms` при TP=1. Отдельно `EngineArgs.create_engine_config` вливает сюда `--cudagraph-capture-sizes` и `--max-cudagraph-capture-size`
- Где объявлен: `vllm/config/vllm.py:VllmConfig.compilation_config`
- Этап применения: разбор CLI → `create_engine_config` → `VllmConfig.__post_init__` → компиляция модели и захват CUDA graphs при старте

## Что меняет в движке

Поля, которые действительно трогают руками:

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `mode` | `None` → `VLLM_COMPILE` при `-O1`…`-O3`, `NONE` при `-O0` | `0`/`NONE` — чистый eager; `1`/`STOCK_TORCH_COMPILE` — штатный torch.compile; `2`/`DYNAMO_TRACE_ONCE` — одна трассировка без guard'ов (требует отсутствия control flow по динамическим формам); `3`/`VLLM_COMPILE` — собственный Inductor-бэкенд vLLM с кэшем, piecewise-компиляцией и кастомными проходами |
| `cudagraph_mode` | `None` → `FULL_AND_PIECEWISE` на `-O2`/`-O3`, `PIECEWISE` на `-O1`, `NONE` на `-O0` | `NONE`, `PIECEWISE`, `FULL`, `FULL_DECODE_ONLY`, `FULL_AND_PIECEWISE`. `PIECEWISE` оставляет несовместимые с графами операции (attention) снаружи; `FULL_DECODE_ONLY` экономит память, отдавая prefill без графов |
| `cudagraph_capture_sizes` | `None` (выводится) | явный список размеров батча для захвата |
| `max_cudagraph_capture_size` | `None` (выводится) | потолок сетки; по умолчанию `min(max_num_seqs × (1 + num_speculative_tokens) × 2, 512)` (1024 на data-center Blackwell), затем зажимается `max_num_batched_tokens` |
| `cudagraph_num_of_warmups` | `0` | сколько первых прогонов считать прогревом, не записывая граф |
| `cudagraph_copy_inputs` | `false` | копировать входные тензоры во внутренний буфер; действует только при `PIECEWISE` |
| `cudagraph_specialize_lora` | `true` | отдельные графы для батчей с активными LoRA и без них; при выключенном LoRA не действует |
| `backend` | `""` (Inductor на CUDA-подобных платформах) | `eager`, `openxla`, полное имя функции-бэкенда |
| `custom_ops` | `[]` → авто | `all`/`none` плюс точечные `+op`/`-op`. Движок сам дописывает `none` при Inductor-компиляции и `all` иначе |
| `splitting_ops` | `None` | какие операции выносить из графов при piecewise-компиляции |
| `pass_config` | все поля `None` | набор fusion-проходов; значения по умолчанию берутся из `--optimization-level` |
| `use_inductor_graph_partition` | `None` → `False` | разбиение графа средствами Inductor вместо splitting ops |
| `compile_sizes`, `compile_ranges_endpoints` | `None` | дополнительная компиляция под конкретные формы |
| `inductor_compile_config`, `inductor_passes` | `{}` | сырые настройки и дополнительные проходы Inductor |
| `cache_dir` | `""` (выводится из хеша конфигурации) | каталог кэша скомпилированного графа |
| `compile_cache_save_format` | из `VLLM_COMPILE_CACHE_SAVE_FORMAT` | `binary` (безопасно для нескольких процессов) или `unpacked` (для разбора вручную, **не** безопасно) |
| `debug_dump_path` | `None` | куда сложить отладочный дамп компиляции |
| `compile_mm_encoder`, `cudagraph_mm_encoder` | `false` | компиляция и графы для мультимодального энкодера |
| `dynamic_shapes_config` | вложенный объект | тип динамических форм, проверка guard'ов, 32-битная индексация |

`eliminate_noops` в `pass_config` объявлен со значением `True`, а не `None`, поэтому таблица `--optimization-level` его никогда не перекрывает — он включен на всех уровнях.

`compute_hash()` этого конфига входит в ключ кэша компиляции: изменение любого влияющего поля вызывает полную перекомпиляцию при следующем старте.

## Значения и формат

Обе формы обрабатываются `FlexibleArgumentParser`:

- одной строкой: `--compilation-config '{"mode":3,"cudagraph_capture_sizes":[1,2,4,8]}'`;
- точечными под-флагами: `-cc.mode=3 -cc.cudagraph_mode=PIECEWISE`, вложенность через точку: `-cc.pass_config.enable_sp=true`;
- списки: валидным JSON (`-cc.cudagraph_capture_sizes '[1,2,4,8]'`) либо через суффикс `+` (`-cc.cudagraph_capture_sizes+ 1,2,4,8`).

Особенности разбора:

- `mode` принимает и число (`0`…`3`), и имя (`NONE`, `STOCK_TORCH_COMPILE`, `DYNAMO_TRACE_ONCE`, `VLLM_COMPILE`, в том числе в нижнем регистре).
- Все точечные под-флаги должны использовать **одно и то же написание флага**: `-cc.mode=3 -cc.backend=eager` сливаются в один словарь, а `-cc.mode=3 --compilation-config.backend eager` дадут два разных argparse-аргумента, и победит последний.
- Смешивать полную JSON-строку и точечные под-флаги нельзя по той же причине: собранный из точек словарь дописывается в конец командной строки и перетирает строку целиком.
- Числа в значениях понимают человекочитаемые суффиксы (`1k`, `8K`) — их разворачивает `_expand_json_human_readable_numbers` перед валидацией.
- Поля `local_cache_dir`, `enabled_custom_ops`, `disabled_custom_ops`, `traced_files`, `compilation_time`, `static_forward_context` служебные (`init=False`) — задавать их нельзя.

## Когда использовать

- **Точечно поправить то, что дал `--optimization-level`.** Например, оставить `-O2` (fusion, автотюнинг), но снизить режим графов: `-O2 -cc.cudagraph_mode=PIECEWISE` — компромисс по памяти между полным набором и `--enforce-eager`.
- **Ограничить память под графы**, не выключая их полностью: `-cc.cudagraph_capture_sizes '[1,2,4,8,16]'`.
- **Диагностировать падение компиляции**: `-cc.debug_dump_path /tmp/vllm-compile` плюс `-cc.mode=0` для сравнения.
- **Не трогайте `inductor_compile_config` и `splitting_ops` без конкретной причины.** Это внутренние ручки Inductor и piecewise-разбиения; ошибка в них проявляется как непонятное падение внутри компиляции.
- **Не используйте `-cc.mode=1`/`2` для «ускорения»** — рабочий путь vLLM это `3` (`VLLM_COMPILE`); остальные режимы существуют для отладки и специальных платформ.

## Влияние на производительность и память

- **VRAM.** Захваченные CUDA graphs занимают память; их оценка вычитается из бюджета `--gpu-memory-utilization` **до** KV-cache (`profile_cudagraph_memory`). Чем шире сетка и чем «полнее» режим (`FULL_AND_PIECEWISE` > `PIECEWISE` > `NONE`), тем меньше остается на KV-cache.
- **Время старта.** Компиляция Inductor и захват графов — основная часть времени до открытия HTTP-порта. `mode=NONE` или `cudagraph_mode=NONE` убирают ее почти полностью.
- **Latency/throughput.** Графы убирают накладные расходы на запуск ядер, критичные на малых батчах; fusion-проходы дают выигрыш в основном на квантованных моделях и при TP > 1.
- **Кэш.** Любое изменение конфигурации меняет `compute_hash()`, то есть первый старт после правки компилируется заново; последующие берут результат из `cache_dir`.

## Взаимодействие с другими аргументами

- `--optimization-level`: задает значения по умолчанию для полей, оставшихся `None`. Явное поле всегда выигрывает у уровня.
- `--enforce-eager`: жестче — принудительно ставит `mode=NONE` и `cudagraph_mode=NONE` независимо от того, что задано здесь, и печатает предупреждение с подсказкой `-cc.mode=none -cc.cudagraph_mode=none`.
- `--cudagraph-capture-sizes` и `--max-cudagraph-capture-size`: верхнеуровневые синонимы одноименных полей; задавать флаг и поле одновременно запрещено (`cudagraph_capture_sizes and compilation_config.cudagraph_capture_sizes are mutually exclusive`). Кроме того, при заданном списке `max_cudagraph_capture_size` должен совпадать с его максимумом.
- `--kernel-config`: соседний конфиг, тоже управляемый уровнем оптимизации; `pass_config` здесь и `ir_op_priority` там взаимно влияют на то, какие fusion-проходы включатся.
- `--max-num-seqs`, `--max-num-batched-tokens`, `--speculative-config`: из них выводится автоматическая сетка размеров графов.
- `--performance-mode`: `interactivity` меняет автоподбор `cudagraph_capture_sizes`; явный список здесь его отменяет.

## Типовые проблемы и диагностика

- **Симптом:** argparse отвергает значение с длинным `ValidationError` в тексте ошибки. **Причина:** ключ или тип не соответствуют `CompilationConfig`; валидация идет прямо на разборе CLI. **Лечение:** сверить имя поля с `vllm/config/compilation.py`.
- **Симптом:** `Cudagraph mode ... is not compatible with compilation mode ... Overriding to NONE.` **Причина:** запрошен piecewise-режим графов, но `mode` не `VLLM_COMPILE`. **Лечение:** согласовать `mode` и `cudagraph_mode`.
- **Симптом:** `customized max_cudagraph_capture_size(=N) should be consistent with the max value of cudagraph_capture_sizes(=M)`. **Лечение:** задавать что-то одно.
- **Симптом:** OOM на этапе `Capturing CUDA graphs`. **Лечение:** сузить `cudagraph_capture_sizes`, задать `max_cudagraph_capture_size` или перейти на `cudagraph_mode=FULL_DECODE_ONLY`/`PIECEWISE`.
- **Симптом:** предупреждение `Inductor compilation was disabled by user settings, optimizations settings that are only active during inductor compilation will be ignored.` **Причина:** `backend=eager` или `mode != VLLM_COMPILE` при заданных fusion-настройках.
- **Симптом:** `Sequence Parallelism requires TP>1, disabling` после `-cc.pass_config.enable_sp=true`. **Лечение:** либо TP > 1, либо не включать.
- **Симптом:** модель компилируется при каждом старте. **Причина:** конфигурация (в том числе `--max-num-batched-tokens`, входящий в хеш `SchedulerConfig`) меняется между запусками. **Лечение:** зафиксировать все значения в конфигурации инстанса.
- **Подтверждение принятого значения:** фазы компиляции и `Capturing CUDA graphs` в логе старта; при `mode=NONE` их нет вовсе.

## Примеры

```bash
vllm serve /models/Qwen3-4B --compilation-config '{"cudagraph_mode":"PIECEWISE","cudagraph_capture_sizes":[1,2,4,8,16]}' --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B -cc.mode=3 -cc.cudagraph_mode=FULL_DECODE_ONLY -cc.debug_dump_path=/tmp/vllm-compile
```

## Источники

- `vllm/vllm/config/compilation.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/docs/design/torch_compile.md`
- `vllm/docs/design/cuda_graphs.md`
- `vllm/docs/design/optimization_levels.md`
- `vllm/tests/utils_/test_argparse_utils.py`
