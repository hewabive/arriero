---
schema: 1
engine: sglang
primaryName: "--max-lora-rank"
title: "--max-lora-rank"
summary: Ранг, под который выделяются буферы GPU-пула адаптеров. Линейный множитель расхода VRAM и жесткий потолок: адаптер большего ранга не загрузится ни на старте, ни динамически.
group: lora
related:
  - --max-loras-per-batch
  - --lora-target-modules
  - --lora-paths
  - --enable-lora
  - --lora-backend
  - --mem-fraction-static
  - --max-loaded-loras
---

# --max-lora-rank

## Кратко

Буферы LoRA-пула выделяются один раз, под фиксированный ранг: `A` имеет форму `[слоты, rank × c, input_dim]`, `B` — `[слоты, output_dim, rank]`. `--max-lora-rank` задает этот ранг. Если аргумент не указан, он выводится как максимум по рангам адаптеров из `--lora-paths` (а при пустом списке отсутствие аргумента — ошибка старта). Значение работает и как потолок: адаптер с бо́льшим рангом отвергается проверкой `LoRAMemoryPool.can_support`. Адаптер меньшего ранга загружается нормально — он просто занимает часть буфера, и разница остается неиспользованной.

## Оригинальная справка

```text
The maximum rank of LoRA adapters. If not specified, it will be automatically inferred from the adapters provided in --lora-paths.
```

## Паспорт аргумента

- Флаги: `--max-lora-rank`
- Группа: `lora`
- Тип значения: `Optional[int]`
- Допустимые значения: положительное целое; собственной проверки диапазона нет
- Значение по умолчанию: `null` — «вывести из `--lora-paths`»
- Эффективное значение: `LoRAManager.init_lora_shapes` подставляет `max(x.r for x in configs)` (или `0`, если адаптеров нет); при пустом `--lora-paths` отсутствие аргумента приводит к ассерту ещё в `check_lora_server_args`
- Где объявлен: `ServerArgs.max_lora_rank`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (валидация связки) → `LoRAManager.init_lora_shapes` → `LoRAMemoryPool.init_buffers` (аллокация VRAM, до профилирования KV-пула) → проверка каждого загружаемого адаптера

## Что меняет в движке

### Формы буферов и цена в VRAM

`LoRAMemoryPool.get_lora_A_shape` / `get_lora_B_shape` (`sglang/python/sglang/srt/lora/mem_pool.py`) строят по модулю и слою:

- стандартный модуль: `A = [max_loras_per_batch, max_lora_rank * c, input_dim]`, `B = [max_loras_per_batch, output_dim, max_lora_rank]`;
- MoE-модуль: те же формы с дополнительной размерностью экспертов;

где `c` — упаковочный множитель (`qkv_proj` — 3, `gate_up_proj` — 2, `in_proj_qkvz` — 4, иначе 1). Размерности делятся на соответствующий TP-размер: `moe_tp_size` для routed-экспертов, `attn_tp_size` для attention-проекций, `tp_size` для остального. dtype совпадает с dtype модели.

Суммарный объем **линеен по рангу**. Для Llama-3.1-8B (bf16, 32 слоя, hidden 4096, 8 KV-голов, intermediate 14336, TP=1, целевые модули `qkv_proj`, `o_proj`, `gate_up_proj`, `down_proj`) арифметика такая:

| Модуль | Элементов на слой на слот |
| --- | --- |
| `qkv_proj` (`c=3`, out 6144) | `3·rank·4096 + 6144·rank = 18432·rank` |
| `o_proj` (4096 → 4096) | `rank·4096 + 4096·rank = 8192·rank` |
| `gate_up_proj` (`c=2`, out 28672) | `2·rank·4096 + 28672·rank = 36864·rank` |
| `down_proj` (14336 → 4096) | `rank·14336 + 4096·rank = 18432·rank` |
| **итого** | **`81 920·rank`** |

Умножая на 32 слоя и 2 байта: `5 242 880 × rank` байт, то есть ровно **5 МиБ на единицу ранга на один слот пула**. Отсюда `rank 16` → 80 МиБ/слот, `rank 64` → 320 МиБ/слот, `rank 256` → 1.25 ГиБ/слот; полный расход умножается на `--max-loras-per-batch`.

Буферы выделяются в `ModelRunner.initialize()`, а KV-пул профилируется позже по фактически свободной памяти, — значит вся эта VRAM уходит из KV-кеша.

### Потолок для адаптеров

`LoRAMemoryPool.can_support(config)`:

```python
if config.r > self.max_lora_rank:
    return False
```

Отказ превращается в сообщение `LoRA adapter <name> with rank R is incompatible with the current LoRA memory pool configuration. Please ensure that the LoRA adapter's rank is within the configured --max-lora-rank and that the target modules are included in --lora-target-modules.` На старте это `RuntimeError` и падение сервера, при динамической загрузке — ошибка в HTTP-ответе. Пул **не пересоздается** под больший ранг.

### Вывод из адаптеров

Если аргумент не задан, `init_lora_shapes` берет максимум по рангам загруженных адаптеров. Практическое следствие: один адаптер ранга 256 в `--lora-paths` задает ранг для всех слотов, и пул раздувается в 16 раз относительно набора из адаптеров ранга 16. Отсюда и рекомендация апстрима задавать `--max-lora-rank` явно в динамическом режиме: иначе догружаемое обязано быть «не больше» стартового набора.

## Значения и формат

- Целое. Типичные ранги адаптеров — степени двойки (8, 16, 32, 64, 128, 256), но ограничения на это нет.
- Значение меньше ранга уже перечисленных в `--lora-paths` адаптеров даст ошибку при их загрузке — вывод из адаптеров и явное значение не смешиваются, явное побеждает и проверяется.
- Задавать его при пустом `--lora-paths` обязательно **вместе** с `--lora-target-modules`: ассерт требует обоих.
- Отдельного «эффективного ранга на адаптер» нет: адаптер ранга 8 в буфере под ранг 64 использует первые 8 строк, остальное обнулено.

## Когда использовать

- Динамическая загрузка адаптеров: фиксируйте ранг заранее по максимуму того, что планируете обслуживать. Апстрим-пример использует `--max-lora-rank 256` вместе с `--lora-target-modules all`.
- Набор `--lora-paths` неоднороден по рангу, и вы хотите **урезать** пул, отказавшись обслуживать самые «толстые» адаптеры: задайте меньший ранг явно — они отвалятся при загрузке с понятным сообщением.
- Экономия VRAM: снижение ранга с 256 до 64 уменьшает пул вчетверо. Это самая эффективная ручка после `--max-loras-per-batch`.
- **Не завышайте про запас**: незанятая часть буфера стоит столько же, сколько занятая, и оплачивается сокращением KV-кеша для всех запросов.
- **Не рассчитывайте** увеличить ранг «на лету»: пул строится один раз при инициализации.

## Влияние на производительность и память

- **VRAM: линейно по рангу**, множители — число слотов, набор целевых модулей и число слоев (см. таблицу).
- **RAM хоста:** сам аргумент не влияет; вес адаптера в CPU-кеше определяется его собственным рангом, а не этим значением.
- **Скорость ядер:** ранг входит в размерности GEMM. Больший ранг — больше работы на каждый LoRA-модуль; на практике это заметно меньше, чем базовый GEMM, но не бесплатно.
- **Качество:** аргумент не меняет поведение адаптера. Адаптер ранга 8 в буфере под 64 считает ровно то же, что и в буфере под 8.
- **Время старта:** аллокация буферов пропорциональна их размеру.

## Взаимодействие с другими аргументами

- `--max-loras-per-batch`: второй сомножитель объема пула.
- `--lora-target-modules`: третий. Добавление `lm_head`/`embed_tokens` вводит буферы размера словаря и меняет порядок величины.
- `--lora-paths`: источник вывода значения; одновременно набор, который будет проверен на соответствие.
- `--enable-lora`: при пустом `--lora-paths` требует эту пару аргументов.
- `--lora-backend`: на размер пула не влияет.
- `--mem-fraction-static`: KV-пул считается по свободной памяти уже после буферов LoRA.
- В arriero увеличение ранга — прямое увеличение VRAM-draw инстанса; после изменения пересчитайте заявку в `config/resources.json` (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `AssertionError: When no initial --lora-paths is provided, you need to specify both --max-lora-rank and --lora-target-modules for LoRA initialization.`
- `LoRA adapter <name> with rank R is incompatible with the current LoRA memory pool configuration ...` — ранг адаптера выше настроенного (или его модули шире `--lora-target-modules`; сообщение общее для обоих случаев).
- OOM сразу после загрузки весов модели, до профилирования KV-пула — почти всегда пул LoRA: перемножьте ранг, слоты и модули по формуле выше.
- KV-пул неожиданно мал — та же причина, но без падения: сравните `max_total_num_tokens` со стартом без LoRA.
- Ранг не задавали и получили гигантский пул — сработал вывод по максимуму из `--lora-paths`.
- Фактический расход проверяется по строкам `LoRA adapter loading starts/completes: ... avail mem=X GB`, которые печатают свободную VRAM до и после операций с пулом. Само значение аргумента видно в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 64 --lora-target-modules qkv_proj o_proj gate_up_proj down_proj --max-loras-per-batch 4
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 256 --lora-target-modules all --max-loras-per-batch 2 --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/lora/utils.py`
- `sglang/python/sglang/srt/lora/lora_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
