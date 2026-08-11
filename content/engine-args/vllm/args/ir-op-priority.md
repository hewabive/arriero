---
schema: 1
engine: vllm
primaryName: "--ir-op-priority"
title: "--ir-op-priority"
summary: Задаёт порядок провайдеров реализации для операций vLLM IR (сегодня это rms_norm и fused_add_rms_norm). Пришёл на смену `-cc.custom_ops` и позволяет выбрать конкретное ядро нормализации вместо native-пути torch.
group: KernelConfig
related:
  - --kernel-config
  - --compilation-config
  - --enforce-eager
  - --linear-backend
  - --optimization-level
---

# --ir-op-priority

## Кратко

Часть операций vLLM вынесена в собственный IR-слой: одна операция — несколько зарегистрированных реализаций («провайдеров»), выбор среди которых делается по списку приоритета. `--ir-op-priority` этот список и задаёт: первая реализация, поддерживающая платформу и фактические аргументы, побеждает.

Сегодня в реестре две операции — `rms_norm` и `fused_add_rms_norm`, — и провайдеров у них немного (`native`, `vllm_c`, `aiter`, `oink`). Аргумент имеет смысл, когда нужно вернуть кастомное ядро нормализации там, где компиляция по умолчанию уходит в `native`, либо наоборот исключить кастомное ядро при отладке.

## Оригинальная справка

```text
vLLM IR op priority for dispatching/lowering during the forward pass.
Platform defaults appended automatically during VllmConfig.__post_init__.
```

## Паспорт аргумента

- Флаги: `--ir-op-priority`
- Группа argparse: `KernelConfig`
- Тип значения: JSON-объект (датакласс `IrOpPriorityConfig`), поля — `rms_norm` и `fused_add_rms_norm`, каждое список строк; строка с запятыми принимается вместо списка
- Допустимые значения: имена зарегистрированных провайдеров конкретной операции. Список не статичен и собирается в runtime из `IrOp.registry` — реализации регистрируются в `vllm/kernels/*.py` декоратором `@ir.ops.<op>.register_impl("<provider>")`, и платформа импортирует свой набор через `Platform.import_ir_kernels()`. Для CUDA/ROCm/XPU это `native`, `vllm_c`, `aiter`, `oink`; сторонняя платформа может добавить свои
- Значение по умолчанию: `Field(default_factory=IrOpPriorityConfig)` — объект с двумя пустыми списками, то есть «пусто = не задано»
- Эффективное значение: **всегда дополняется платформой.** `KernelConfig.set_platform_defaults()` вызывается из `VllmConfig.__post_init__` и дописывает в конец каждого списка платформенные значения, которых там ещё нет. На CUDA это `["native"]` при компиляции через inductor и `["vllm_c", "native"]` в eager/Dynamo-режиме; при `VLLM_USE_OINK_OPS=1` для rms-операций впереди добавляется `oink`
- Где объявлен: `vllm/config/kernel.py:KernelConfig.ir_op_priority`
- Этап применения: сборка `VllmConfig` (дополнение платформенными значениями) → инициализация worker'а (`ir_op_priority.set_default()`) → каждый forward

## Что меняет в движке

`IrOpPriorityConfig` содержит по списку строк на операцию. В `WorkerBase` вызывается `vllm_config.kernel_config.ir_op_priority.set_default()`, который для каждой операции:

1. импортирует платформенные ядра (`current_platform.import_ir_kernels()`, по умолчанию `import vllm.kernels`);
2. проверяет ассертом, что **все** имена в списке зарегистрированы: `All providers in priority must be registered implementations.`;
3. фильтрует список — выбрасывает реализации, у которых статический признак `supported` ложен (например AITer на не-ROCm, oink без установленного пакета);
4. останавливается на первой реализации, у которой `supports_all_args` истинно; если такой нет, дописывает в конец `native` и предупреждает: `Op %s: No implementation in priority list supports all args, execution fallback to native is possible. To silence this warning, explicitly add 'native' to the end of the priority list`.

Дальше на каждом вызове операции выбирается первая реализация из отфильтрованного списка, чей динамический `supports_args(...)` принимает фактические тензоры. Именно поэтому у провайдеров есть условия: `vllm_c` требует совпадения dtype веса и активации и отсутствия `variance_size`; `aiter` — только fp16/bf16; `oink` — 2D-подобный вход и непрерывный вес.

`IrOpPriorityConfig` участвует в хеше компиляции — `compute_hash()` подмешивает UUID выбранных реализаций, поэтому смена приоритета инвалидирует кеш компиляции корректно.

Верхнеуровневый `--ir-op-priority` и поле внутри `--kernel-config` взаимно исключены пооперационно: `create_engine_config` переносит непустые списки в `KernelConfig.ir_op_priority` и падает, если для той же операции значение задано дважды — `Op priority for rms_norm specified via both ir_op_priority and KernelConfig.ir_op_priority, only one allowed at a time.`

## Значения и формат

Три эквивалентные записи:

- точечный под-флаг со списком через запятую (форма из апстрим-документации): `--ir-op-priority.rms_norm=vllm_c,native`;
- JSON одной строкой: `--ir-op-priority '{"rms_norm": ["vllm_c", "native"], "fused_add_rms_norm": ["vllm_c", "native"]}'`;
- через контейнерный аргумент: `--kernel-config '{"ir_op_priority": {"rms_norm": ["vllm_c"]}}'`.

Остальное:

- валидатор `_to_list_str` принимает строку и режет её по запятым, попутно удаляя пробелы, поэтому `"vllm_c, native"` и `["vllm_c","native"]` эквивалентны;
- пустой список означает «не задано» — платформенные значения станут единственными;
- незарегистрированное имя провайдера — это ассерт при инициализации worker'а, а не мягкая ошибка;
- имена провайдеров, а не путей к классам: `vllm_c`, `native`, `aiter`, `oink`;
- добавлять `native` в конец списка полезно всегда — иначе получите предупреждение о возможном неявном откате.

## Когда использовать

- **Вернуть кастомное ядро нормализации при компиляции.** При inductor-компиляции платформенный дефолт — `native`, чтобы компилятор мог фьюзить нормализацию с соседними операциями. Если фьюзинг в вашей конфигурации не срабатывает, `--ir-op-priority.rms_norm=vllm_c,native` возвращает ядро vLLM.
- **Отладка численности.** Расхождения в выводе после смены версии: сравнить `native` (эталон torch) с `vllm_c` на одной и той же модели.
- **ROCm.** Явный `aiter,vllm_c,native` — типичный порядок из апстрим-документации.
- **Не трогайте без замера.** Платформенные дефолты подобраны под режим компиляции: `native` при inductor и `vllm_c` без него — это уже осмысленный выбор, а не заглушка.
- **Не воспринимайте как замену `--linear-backend`/`--moe-backend`.** IR-слой пока покрывает только две операции нормализации; GEMM-ядра выбираются совсем другим механизмом.

## Влияние на производительность и память

- **Latency.** Эффект локальный: нормализация — не доминирующая операция. Заметная разница возникает в eager-режиме, где кастомное ядро экономит несколько запусков, и наоборот при inductor-компиляции, где `native` открывает фьюзинг норм+квантизации (`-cc.pass_config.fuse_norm_quant`) — принудительный `vllm_c` этот фьюзинг закрывает и может оказаться медленнее, чем дефолт.
- **VRAM.** Не влияет: реализации работают в тех же буферах; `maybe_inplace`-перегрузка `fused_add_rms_norm` позволяет реализации переиспользовать память входа, но это свойство операции, а не приоритета.
- **Время старта.** Не влияет заметно; смена приоритета меняет хеш компиляции, поэтому первый старт после правки будет с полной перекомпиляцией.
- **Численность.** Между провайдерами возможны расхождения последнего бита — это нормально и это же делает аргумент полезным для отладки.

## Взаимодействие с другими аргументами

- `--kernel-config`: содержит то же поле. Задать одну и ту же операцию в обоих местах нельзя — `ValueError` на старте.
- `--compilation-config`: режим компиляции определяет платформенный дефолт (`inductor` + не-`NONE` ⇒ `native`, иначе `vllm_c, native`). Кроме того, `-cc.pass_config.fuse_norm_quant` и родственные проходы фьюзинга рассчитаны на `native`-путь.
- `--enforce-eager`: переводит компиляцию в `NONE`, из-за чего платформенный дефолт становится `vllm_c, native`, то есть смысл флага меняется без изменения самого флага.
- `--optimization-level`: через набор проходов фьюзинга косвенно влияет на то, выгоден ли `native`.
- `--linear-backend`, `--moe-backend`: отдельные механизмы выбора ядер (GEMM и MoE); с IR-приоритетом не пересекаются.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: All providers in priority must be registered implementations.` при инициализации worker'а. **Причина:** опечатка в имени провайдера или провайдер из другой платформы. **Лечение:** имена берутся из `vllm/kernels/*.py` установленной версии (`register_impl("...")`).
- **Симптом:** `Op rms_norm: No implementation in priority list supports all args, execution fallback to native is possible.` **Причина:** ни у одного из перечисленных провайдеров нет безусловной поддержки аргументов. **Лечение:** дописать `native` в конец списка — предупреждение исчезнет, поведение не изменится.
- **Симптом:** `ValueError: Op priority for rms_norm specified via both ir_op_priority and KernelConfig.ir_op_priority, only one allowed at a time.` **Лечение:** оставить один из двух способов записи.
- **Симптом:** задали `vllm_c`, а производительность упала. **Причина:** при inductor-компиляции принудительное кастомное ядро закрывает фьюзинг нормализации с квантизацией. **Лечение:** вернуть дефолт (снять флаг).
- **Симптом:** флаг задан, но ничего не изменилось. **Причина:** провайдер отфильтрован по статическому `supported` (например `aiter` на CUDA) — список молча схлопывается до платформенного дефолта.
- **Подтверждение принятого значения:** информационная строка `Final IR op priority after setting platform defaults: IrOpPriorityConfig(rms_norm=[...], fused_add_rms_norm=[...])` печатается при сборке конфига; фактически выбранные реализации видны на уровне debug (`Priority for vllm.ir.rms_norm set to [...]`).

## Примеры

```bash
vllm serve /models/Qwen3-4B --ir-op-priority.rms_norm=vllm_c,native --ir-op-priority.fused_add_rms_norm=vllm_c,native
```

```bash
vllm serve /models/Qwen3-4B --ir-op-priority '{"rms_norm": ["native"], "fused_add_rms_norm": ["native"]}' --max-model-len 8192
```

## Источники

- `vllm/vllm/config/kernel.py`
- `vllm/vllm/ir/op.py`
- `vllm/vllm/kernels/vllm_c.py`
- `vllm/vllm/kernels/aiter_ops.py`
- `vllm/vllm/kernels/oink_ops.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/vllm/v1/worker/worker_base.py`
- `vllm/docs/design/vllm_ir.md`
