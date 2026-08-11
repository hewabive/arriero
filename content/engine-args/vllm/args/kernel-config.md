---
schema: 1
engine: vllm
primaryName: "--kernel-config"
title: "--kernel-config"
summary: JSON-объект `KernelConfig` — выбор MoE- и linear-ядер, приоритет реализаций vLLM IR и переключатели прогрева (FlashInfer-автотюнинг, JIT, CuTeDSL). Три его поля продублированы верхнеуровневыми флагами, остальные доступны только отсюда.
group: VllmConfig
related:
  - --moe-backend
  - --linear-backend
  - --ir-op-priority
  - --enable-flashinfer-autotune
  - --enable-bf16x3-router-gemm
  - --optimization-level
  - --compilation-config
  - --quantization
---

# --kernel-config

## Кратко

`--kernel-config` заполняет датакласс `KernelConfig` (`vllm/config/kernel.py`): какие ядра использовать для MoE-экспертов и квантованных linear-слоев, в каком порядке пробовать реализации операций vLLM IR и что делать во время прогрева ядер. Значение валидируется прямо на разборе CLI.

Это единственный конфиг из группы `VllmConfig`, который `--optimization-level` трогает напрямую: уровень выставляет `enable_flashinfer_autotune` (`False` на `-O0`, `True` на `-O1`…`-O3`), и если после применения уровня поле все еще `None`, движок падает с явной ошибкой.

## Оригинальная справка

```text
Kernel configuration.
```

## Паспорт аргумента

- Флаги: `--kernel-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `--kernel-config.<поле> <значение>`)
- Допустимые значения: поля `KernelConfig`; `moe_backend` и `linear_backend` ограничены литеральными списками `MoEBackend`/`LinearBackend`
- Значение по умолчанию: `Field(default_factory=KernelConfig)` — объект со значениями по умолчанию, а не `None`
- Эффективное значение: переопределяется трижды. `EngineArgs.create_engine_config` вливает `--enable-flashinfer-autotune`, `--enable-bf16x3-router-gemm`, `--moe-backend`, `--linear-backend` и верхнеуровневый `--ir-op-priority`. Затем `VllmConfig.__post_init__` вызывает `kernel_config.set_platform_defaults(self)`, который **дописывает** платформенные реализации в конец каждого списка `ir_op_priority`. И только после этого таблица `--optimization-level` заполняет `enable_flashinfer_autotune`, если он остался `None`
- Где объявлен: `vllm/config/vllm.py:VllmConfig.kernel_config`
- Этап применения: разбор CLI → `create_engine_config` → `VllmConfig.__post_init__` (платформенные умолчания и уровень оптимизации) → инициализация воркера (`ir_op_priority.set_default()`) → прогрев ядер → forward

## Что меняет в движке

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `moe_backend` | `"auto"` | ядро вычисления MoE-экспертов. Значения: `auto`, `triton`, `batched_triton`, `deep_gemm`, `deep_gemm_mega_moe`, `cutlass`, `flashinfer_trtllm`, `flashinfer_cutlass`, `flashinfer_cutedsl`, `flashinfer_b12x`, `marlin`, `humming`, `triton_unfused`, `aiter`, `flydsl`, `hpc`, `emulation` |
| `linear_backend` | `"auto"` | ядро GEMM для квантованных linear-слоев: `auto`, `cutlass`, `flashinfer_cutlass`, `flashinfer_cutedsl`, `flashinfer_trtllm`, `flashinfer_cudnn`, `flashinfer_b12x`, `marlin`, `humming`, `triton`, `deep_gemm`, `torch`, `aiter`, `machete`, `fbgemm`, `conch`, `exllama`, `emulation`, `xpu`, `xpu_woq` |
| `ir_op_priority` | вложенный объект с пустыми списками | приоритет реализаций операций vLLM IR. Сегодня два поля: `rms_norm` и `fused_add_rms_norm`; значение — список провайдеров, первый доступный побеждает |
| `enable_flashinfer_autotune` | `None` → из `--optimization-level` | запускать ли автотюнинг FlashInfer при прогреве |
| `enable_jit_warmup` | `true` | прогревать JIT-компиляцию ядер при старте |
| `enable_cutedsl_warmup` | `true` | помечено в исходниках как deprecated: устаревший путь прогрева CuTeDSL |
| `enable_bf16x3_router_gemm` | `false` | экспериментальный BF16x3 CuteDSL router GEMM для SM100 |

Важно про `ir_op_priority`: при **пустом** списке платформа подставляет свои значения целиком, при непустом — платформенные реализации **дописываются в конец**, а ваши остаются первыми. Механизм идемпотентен, поэтому повторный вызов `set_platform_defaults` не дублирует записи. Значение приоритета читается и в `--optimization-level`: предикат `enable_norm_fusion` включает fusion RMS-norm, если `ir_op_priority.rms_norm[0]` не равен `native`, а `enable_norm_pad_fusion` смотрит на `fused_add_rms_norm[0] == "aiter"`.

`compute_hash()` намеренно исключает `enable_cutedsl_warmup`, `enable_jit_warmup` и `enable_flashinfer_autotune`: это настройки прогрева, а не графа вычислений, и они не должны инвалидировать кэш компиляции. `moe_backend`, `linear_backend` и `ir_op_priority` в хеш входят.

## Значения и формат

- Обе формы: `--kernel-config '{"moe_backend":"triton","enable_jit_warmup":false}'` и `--kernel-config.moe_backend triton`. Точечные под-флаги должны использовать одно и то же написание флага и не смешиваться с полной JSON-строкой.
- Имена backend'ов нормализуются: регистр приводится к нижнему, дефисы — к подчеркиваниям, то есть `Deep-GEMM` и `deep_gemm` эквивалентны.
- `ir_op_priority` принимает и список, и строку с запятыми: `--kernel-config.ir_op_priority.rms_norm "aiter,native"` разбирается в `["aiter", "native"]`.
- `auto` в `moe_backend`/`linear_backend` означает автовыбор по модели и железу — это единственное «специальное» значение.
- Значения `emulation` в обоих списках — медленная дeквантизация в BF16, предназначенная для проверки корректности, а не для эксплуатации.

## Когда использовать

- **Обход дефекта или несовместимости конкретного ядра.** Типичный сценарий: автовыбор берет FlashInfer- или DeepGEMM-путь, который в вашей связке драйвер/CUDA/wheel падает или дает неверные числа — тогда фиксируют `triton` или `cutlass`.
- **`enable_flashinfer_autotune=false` для ускорения старта**, если автотюнинг занимает заметное время, а разница в throughput на вашей нагрузке несущественна.
- **`enable_jit_warmup=false`** только при отладке холодного старта: без прогрева первые запросы поймают JIT-компиляцию.
- **Не подбирайте `moe_backend`/`linear_backend` наугад.** Большинство значений применимы лишь к конкретной комбинации квантизации и SM-архитектуры; неподходящее значение падает на старте или молча деградирует в производительности.
- **`enable_bf16x3_router_gemm` и `emulation` в эксплуатации не используйте** — экспериментальный и отладочный пути соответственно.

## Влияние на производительность и память

- **Время старта.** Самая заметная статья: `enable_flashinfer_autotune` и `enable_jit_warmup` — это отдельные фазы перед открытием порта. Отключение обоих заметно ускоряет старт ценой холодных первых запросов.
- **Throughput/latency.** Выбор MoE- и linear-ядра на квантованных моделях меняет пропускную способность в разы; `auto` обычно и есть лучший выбор для поддержанных комбинаций.
- **VRAM.** Прямого влияния нет: ядра различаются рабочими буферами, но не размером весов или KV-cache. Косвенно — через fusion-проходы, которые включаются в зависимости от `ir_op_priority`.
- **Кэш компиляции.** Смена `moe_backend`, `linear_backend` или `ir_op_priority` меняет хеш и вызывает перекомпиляцию; смена флагов прогрева — нет.

## Взаимодействие с другими аргументами

- `--moe-backend`, `--linear-backend`: верхнеуровневые синонимы. Они применяются, только если отличаются от `auto`, и в этом случае **перетирают** значение из JSON без ошибки — в отличие от остальных пар.
- `--enable-flashinfer-autotune`: задавать его и `--kernel-config.enable_flashinfer_autotune` одновременно запрещено (`enable_flashinfer_autotune and kernel_config.enable_flashinfer_autotune are mutually exclusive`).
- `--enable-bf16x3-router-gemm`: верхнеуровневый синоним, перетирает поле в JSON.
- `--ir-op-priority`: верхнеуровневый синоним вложенного объекта; задать приоритет одной и той же операции в обоих местах нельзя — `Op priority for X specified via both ir_op_priority and KernelConfig.ir_op_priority, only one allowed at a time.`
- `--optimization-level`: заполняет `enable_flashinfer_autotune` и читает `ir_op_priority` при решении, включать ли fusion-проходы.
- `--compilation-config`: `pass_config` там и `ir_op_priority` здесь совместно определяют итоговый набор fusion'ов.
- `--quantization`: определяет, какие значения `linear_backend`/`moe_backend` вообще применимы.

## Типовые проблемы и диагностика

- **Симптом:** `KernelConfig.enable_flashinfer_autotune must be set after applying optimization level defaults.` **Причина:** внутренняя инвариантная проверка — поле осталось `None` после уровня. **Лечение:** задать его явно (`--enable-flashinfer-autotune` или `--kernel-config.enable_flashinfer_autotune`).
- **Симптом:** `Op priority for rms_norm specified via both ir_op_priority and KernelConfig.ir_op_priority, only one allowed at a time.` **Лечение:** оставить один из двух способов.
- **Симптом:** argparse отвергает значение с `ValidationError`. **Причина:** имя backend'а нет в литеральном списке этой версии. **Лечение:** сверить через `vllm serve --help=moe-backend` / `--help=linear-backend`.
- **Симптом:** старт длится заметно дольше ожидаемого, в логе видна фаза автотюнинга. **Лечение:** `--kernel-config.enable_flashinfer_autotune false` (или `-O0`, если приемлемо потерять и компиляцию).
- **Симптом:** первые запросы после старта аномально медленные. **Причина:** отключен `enable_jit_warmup`. **Лечение:** вернуть значение по умолчанию.
- **Подтверждение принятого значения:** строка `Final IR op priority after setting platform defaults: IrOpPriorityConfig(rms_norm=[...], fused_add_rms_norm=[...])` печатается на уровне info при каждом старте — по ней видно и ваши значения, и дописанные платформенные.

## Примеры

```bash
vllm serve /models/Qwen3-4B --kernel-config '{"moe_backend":"triton","enable_flashinfer_autotune":false}' --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --kernel-config.ir_op_priority.rms_norm "aiter,native" --kernel-config.enable_jit_warmup false
```

## Источники

- `vllm/vllm/config/kernel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/ir/op.py`
- `vllm/docs/design/vllm_ir.md`
- `vllm/docs/design/moe_kernel_features.md`
