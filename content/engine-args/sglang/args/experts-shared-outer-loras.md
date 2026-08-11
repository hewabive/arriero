---
schema: 1
engine: sglang
primaryName: "--experts-shared-outer-loras"
title: "--experts-shared-outer-loras"
summary: Принудительно объявляет, что внешние LoRA-матрицы MoE (`lora_A` у gate/up и `lora_B` у down) общие для всех экспертов, то есть `expert_dim = 1`. По умолчанию это определяется автоматически по весам загруженных адаптеров.
group: lora
related:
  - --lora-use-virtual-experts
  - --max-lora-rank
  - --max-loras-per-batch
  - --lora-paths
  - --lora-target-modules
  - --enable-lora
  - --ep-size
---

# --experts-shared-outer-loras

## Кратко

MoE-адаптер может хранить LoRA-матрицы либо по одной на эксперта, либо в «shared outer» форме: `lora_A` у `gate_up` и `lora_B` у `down` общие для всех экспертов, а по экспертам различаются только внутренние матрицы. Разница видна в формах буферов пула: `expert_dim` равен числу экспертов или единице. SGLang определяет форму сам, разбирая веса загруженных адаптеров; `--experts-shared-outer-loras` и `--no-experts-shared-outer-loras` позволяют навязать ответ. Задавать его нужно лишь тогда, когда автодетект не работает или адаптеры подгружаются динамически.

## Оригинальная справка

```text
Force shared outer LoRA mode for MoE models. When set, w1/w3 lora_A and w2 lora_B are shared across experts (expert_dim=1). Use --no-experts-shared-outer-loras to force disable. By default this is auto-detected from adapter weights.
```

## Паспорт аргумента

- Флаги: `--experts-shared-outer-loras`, `--no-experts-shared-outer-loras`
- Группа: `lora`
- Тип значения: `Optional[bool]`, `action=argparse.BooleanOptionalAction`
- Допустимые значения: значения не принимает; задается наличием одного из двух флагов
- Значение по умолчанию: `null` — автодетект по весам адаптеров
- Эффективное значение: `LoRAManager.init_state` берет значение аргумента, если оно не `None`, иначе вызывает `_detect_shared_outer_loras()`
- Где объявлен: `ServerArgs.experts_shared_outer_loras`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `LoRAManager.init_state` — после загрузки стартовых адаптеров и **до** `init_memory_pool`, то есть значение фиксируется в формах буферов навсегда

## Что меняет в движке

### Автодетект

`_detect_shared_outer_loras` (`sglang/python/sglang/srt/lora/lora_manager.py`) проходит по весам всех загруженных адаптеров и смотрит только на `gate_up_proj … lora_A`:

- трехмерный тензор с `shape[0] == 1` ⇒ shared outer;
- трехмерный с `shape[0] == num_experts` ⇒ per-expert;
- двумерные веса с номером эксперта в имени (`experts.<N>.`) ⇒ per-expert.

Все адаптеры обязаны договориться. При расхождении бросается `RuntimeError: Mixed shared-outer LoRA formats detected across loaded adapters (conflict in adapter '<id>'). All MoE adapters must either all use shared outer experts (expert_dim=1) or all use per-expert weights.` Если ни один адаптер не дал признака, результат — `False`.

### Что меняется в буферах

`LoRAMemoryPool.get_lora_A_shape` / `get_lora_B_shape` (`sglang/python/sglang/srt/lora/mem_pool.py`):

```python
if self.experts_shared_outer_loras and module_name in ("gate_up_proj_moe", "gate_up_proj_shared_moe"):
    expert_dim = 1
...
if self.experts_shared_outer_loras and module_name in ("down_proj_moe", "down_proj_shared_moe"):
    expert_dim = 1
```

Обратите внимание на асимметрию: `expert_dim = 1` применяется к **A-буферу** только у `gate_up` и к **B-буферу** только у `down` — ровно то, что и означает «внешние» матрицы. Внутренние (`gate_up` B и `down` A) остаются размерными по экспертам.

Экономия существенная: у `gate_up_proj_moe` A-буфер имеет форму `[слоты, expert_dim, rank·2, hidden]`, и переход с `num_local_experts` на `1` делит его на число локальных экспертов. Для модели с 64 экспертами на ранг это два из четырех MoE-буферов, уменьшенных в 64 раза.

### Как это видят вычислительные пути

- Классический (`fused_moe_lora`): общий тензор раскрывается на всех экспертов через `expand(-1, num_experts, -1, -1)` — это view, без копирования.
- Виртуальные эксперты (`--lora-use-virtual-experts`): общий тензор используется напрямую, а в ядро уходят флаги `experts_shared_outer_loras_a` / `experts_shared_outer_loras_b`; при этом `num_experts_for_weight` становится равен 1, и виртуальный id вырождается в номер адаптера.

### Ограничение YAML-конфига

Как и `--lora-strict-loading`, аргумент объявлен через `BooleanOptionalAction`, а `ConfigArgumentMerger` такие опции не поддерживает: при попытке задать `experts_shared_outer_loras` в файле `--config` будет `Unsupported config option 'experts_shared_outer_loras' with action 'BooleanOptionalAction'`.

## Значения и формат

- `--experts-shared-outer-loras` включает, `--no-experts-shared-outer-loras` выключает, отсутствие обоих — автодетект.
- Значение фиксируется один раз, при инициализации `LoRAManager`, и на пересозданный пул не влияет: динамически догруженный адаптер обязан соответствовать уже выбранной форме.
- Флаг относится только к MoE-модулям. На плотной модели он не читается.
- «Внешние» матрицы — это `lora_A` у объединенного `gate_up` (w1/w3) и `lora_B` у `down` (w2), как и написано в справке.

## Когда использовать

- Динамическая загрузка MoE-адаптеров при пустом `--lora-paths`: автодетекту нечего разбирать, он вернет `False`, и пул выделится под per-expert форму. Если ваши адаптеры shared-outer, задайте флаг явно — иначе буферы будут в `num_experts` раз больше нужного, а веса не сойдутся по форме при загрузке.
- Известно, что весь ваш парк адаптеров одного формата, и вы хотите зафиксировать это в конфигурации запуска, а не полагаться на разбор весов.
- `--no-experts-shared-outer-loras` — когда автодетект ошибочно решил, что форма общая (нестандартная упаковка весов), и надо принудительно вернуть per-expert буферы.
- **Не задавайте наугад**: несовпадение формы проявится ассертом о размерности при копировании весов адаптера в буфер, а не понятным сообщением о конфигурации.
- **Не пытайтесь** им «сэкономить память» на адаптерах, которые на самом деле per-expert: буферы уменьшатся, а веса перестанут влезать.

## Влияние на производительность и память

- **VRAM.** Единственный аргумент группы, меняющий форму буферов не через ранг и не через число слотов. Для `gate_up_proj_moe` (A) и `down_proj_moe` (B) размер делится на число локальных экспертов; при десятках экспертов это заметная доля MoE-части пула.
- **Скорость.** Классический путь раскрывает общий тензор через `expand` — это view, дополнительных копий и заметных затрат нет. Виртуальный путь дополнительно упрощает индексацию (`num_experts_for_weight = 1`).
- **RAM хоста.** Не меняется: форма весов задается самим адаптером.
- **Время старта.** Автодетект стоит одного прохода по весам загруженных адаптеров; явное значение его отменяет.

## Взаимодействие с другими аргументами

- `--lora-use-virtual-experts`: комбинация обрабатывается отдельной веткой в обоих MoE-хуках; при виртуальных экспертах раскрытие тензора не выполняется.
- `--lora-paths`: источник автодетекта. Пустой список ⇒ автодетект даст `False`.
- `--max-lora-rank`, `--max-loras-per-batch`, `--lora-target-modules`: остальные множители размера пула.
- `--ep-size`: число **локальных** экспертов на ранге зависит от экспертного параллелизма; именно на него делится размерность при shared-outer.
- `--enable-lora`: без неё значение не читается.
- В arriero изменение формы буферов меняет VRAM-draw инстанса — пересчитайте заявку в `config/resources.json` (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `RuntimeError: Mixed shared-outer LoRA formats detected across loaded adapters (conflict in adapter '<id>')` — в `--lora-paths` смешаны адаптеры двух форматов; разведите их по разным серверам.
- `AssertionError: LoRA buffer shape torch.Size([...]) does not match weight shape torch.Size([...])` при загрузке адаптера — форма пула не совпала с формой весов; чаще всего это неверно заданный (или, наоборот, не заданный) флаг.
- `Unsupported config option 'experts_shared_outer_loras' with action 'BooleanOptionalAction'` — попытка задать через `--config`.
- MoE-часть пула неожиданно большая при динамической загрузке — автодетект вернул `False` из-за отсутствия стартовых адаптеров.
- Подтверждение в логе печатается только для включенного режима: `Shared outer LoRA mode enabled: gate_up lora_A and down lora_B will be shared across experts (expert_dim=1).` Значение аргумента видно в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B-Instruct --enable-lora --max-lora-rank 32 --lora-target-modules all --max-loras-per-batch 2 --experts-shared-outer-loras
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B-Instruct --lora-paths moe=/models/lora/moe --max-loras-per-batch 2 --no-experts-shared-outer-loras
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/python/sglang/srt/lora/lora_moe_runners.py`
- `sglang/python/sglang/kernels/ops/moe/virtual_experts.py`
- `sglang/python/sglang/srt/server_args_config_parser.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
