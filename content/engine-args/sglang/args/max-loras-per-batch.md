---
schema: 1
engine: sglang
primaryName: "--max-loras-per-batch"
title: "--max-loras-per-batch"
summary: Число слотов GPU-пула LoRA. Буферы под все слоты выделяются на старте и вычитаются из KV-кеша; одновременно это потолок числа разных адаптеров (включая базовую модель) в одном батче.
group: lora
related:
  - --max-lora-rank
  - --lora-target-modules
  - --max-loaded-loras
  - --lora-eviction-policy
  - --lora-drain-wait-threshold
  - --enable-lora
  - --enable-lora-overlap-loading
  - --lora-paths
  - --mem-fraction-static
---

# --max-loras-per-batch

## Кратко

`--max-loras-per-batch` — это **число слотов в предвыделенном GPU-пуле** LoRA. Каждый буфер пула имеет первую размерность, равную этому числу, и все они создаются при инициализации `ModelRunner`, до профилирования KV-кеша, — то есть аргумент напрямую отнимает VRAM у KV-пула независимо от того, приходят ли LoRA-запросы. Второй смысл — планировочный: в один батч не попадет больше этого числа различных адаптеров, причем базовая модель (запрос без адаптера) занимает **отдельный слот**.

## Оригинальная справка

```text
Maximum number of adapters for a running batch, include base-only request.
```

## Паспорт аргумента

- Флаги: `--max-loras-per-batch`
- Группа: `lora`
- Тип значения: int
- Допустимые значения: строго положительное целое; `assert self.max_loras_per_batch > 0, "max_loras_per_batch must be positive"` — проверка стоит в самом начале `check_lora_server_args` и выполняется даже при выключенной LoRA
- Значение по умолчанию: `8`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.max_loras_per_batch`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (валидация) → `LoRAMemoryPool.init_buffers` при инициализации `ModelRunner` (до профилирования KV-пула) → планировщик на каждом шаге сборки батча

## Что меняет в движке

### Предвыделение (что именно резервируется)

`LoRAMemoryPool` (`sglang/python/sglang/srt/lora/mem_pool.py`) на каждый слой и каждый целевой модуль создает два тензора `torch.zeros`:

- `A_buffer`: `[max_loras_per_batch, max_lora_rank * c, input_dim]`
- `B_buffer`: `[max_loras_per_batch, output_dim, max_lora_rank]`

где `c` — «упаковочный множитель» модуля (`qkv_proj` — 3, `gate_up_proj` — 2, `in_proj_qkvz` — 4, остальные — 1), а `input_dim`/`output_dim` берутся из конфигурации модели и делятся на соответствующий TP-размер (`moe_tp_size` для routed-экспертов, `attn_tp_size` для attention-проекций, `tp_size` для остального). dtype — dtype модели. Для MoE-модулей добавляется размерность экспертов, и буферы становятся четырехмерными.

**Расход считается точно.** Для Llama-3.1-8B (bf16, 32 слоя, hidden 4096, 8 KV-голов, intermediate 14336, TP=1) с целевыми модулями `qkv_proj`, `o_proj`, `gate_up_proj`, `down_proj` сумма по слою равна `81 920 × rank` элементов, по всем слоям — `2 621 440 × rank`, то есть ровно **5 МиБ на единицу ранга на один слот**:

| `--max-lora-rank` | На слот | При `--max-loras-per-batch 8` |
| --- | --- | --- |
| 16 | 80 МиБ | 640 МиБ |
| 64 | 320 МиБ | 2.5 ГиБ |
| 256 | 1.25 ГиБ | 10 ГиБ |

Добавление `lm_head`/`embed_tokens` в целевые модули добавляет к этому буферы размера словаря — они самые дорогие из всех.

Эти буферы выделяются в `ModelRunner.initialize()` (`maybe_init_lora_manager`), а KV-пул профилируется позже, в `alloc_memory_pool()`, по **фактически свободной** памяти. Поэтому вся LoRA-аллокация один к одному уменьшает `max_total_num_tokens`.

### Что происходит в рантайме (swap, а не аллокация)

Слоты не выделяются заново — они переиспользуются. `LoRAMemoryPool.prepare_lora_batch`:

1. для каждого адаптера батча, которого нет в пуле, ищется слот: сначала пустой, затем — жертва;
2. кандидатами на вытеснение считаются слоты, чей адаптер **не нужен текущему батчу** и **не закреплен** (`pinned`); при пустом множестве кандидатов бросается `ValueError: No available buffer slots found. Please ensure the number of active (pinned) loras is less than max_loras_per_batch.`;
3. из кандидатов сначала выбираются настоящие адаптеры, и только если их нет — слот базовой модели (`None`);
4. жертва выбирается политикой `--lora-eviction-policy`;
5. веса нового адаптера копируются с CPU в слот (`copy_weight_into_buffer`), отсутствующие в адаптере модули обнуляются, чтобы не осталось следов предыдущего.

То есть **`--max-loras-per-batch` определяет резидентность, а не общее число адаптеров**: их может быть загружено гораздо больше (см. `--max-loaded-loras`), просто они будут ездить туда-сюда.

### Планировщик

`LoRAManager.validate_lora_batch(lora_ids)` возвращает `False`, если `len(lora_ids) > max_loras_per_batch`. При наличии закрепленных адаптеров расчет тоньше:

```python
required_slots = len(lora_ids) - pinned_loras_in_batch
mem_pool_vacancy = self.memory_pool.max_loras_per_batch - self.num_pinned_loras
return required_slots <= mem_pool_vacancy
```

Заявка, чей адаптер не помещается, **пропускается** в очереди (`continue` в цикле по `waiting_queue`), а не отвергается. Именно из этого и растет tail latency, с которой борется `--lora-drain-wait-threshold`.

Смежные ограничения того же числа:

- закрепить можно не более `max_loras_per_batch - 1` адаптеров;
- при `--enable-lora-overlap-loading` требуется `--max-loaded-loras <= 2 × max_loras_per_batch`;
- `--max-loaded-loras` не может быть меньше этого значения.

## Значения и формат

- Целое > 0. Ноль и отрицательные отвергаются ассертом при старте — даже без `--enable-lora`.
- Значение `1` означает «только базовая модель **или** один адаптер»: слот один, и он будет постоянно перезаписываться. Апстрим-примеры для одного адаптера используют `2` именно поэтому — «один слот под адаптер и один под базовую модель».
- Верхней границы нет; ограничитель — VRAM.
- Единица измерения — слоты (адаптеры), а не запросы: сколько угодно запросов к одному адаптеру занимают один слот.

## Когда использовать

- Обслуживаете N адаптеров и хотите, чтобы они уживались в одном батче: берите `N + 1` (плюс слот под базовую модель), если VRAM позволяет.
- VRAM в дефиците — уменьшайте: это самый прямой способ вернуть память KV-кешу, и апстрим-справка прямо советует «set to a smaller value when memory is scarce».
- Один адаптер и чисто адаптерный трафик — хватит `2`.
- **Не завышайте «про запас»**: неиспользуемые слоты стоят ровно столько же, сколько используемые, и платят за них все запросы, включая те, что LoRA не трогают.
- **Не путайте** со числом загруженных адаптеров: держать в RAM сотню адаптеров при 4 слотах — штатный режим.

## Влияние на производительность и память

- **VRAM.** `max_loras_per_batch × max_lora_rank × Σ(размеры модулей) × слои × размер элемента`, вычитается из KV-пула (см. таблицу выше).
- **Throughput.** Больше слотов — больше разных адаптеров в одном батче, меньше пропусков в очереди и меньше swap'ов. При перекошенном трафике это заметно.
- **Latency.** Каждый промах слота = синхронная H2D-копия весов адаптера перед батчем (или асинхронная при `--enable-lora-overlap-loading`). Чем меньше слотов, тем чаще копии.
- **Метрики.** При `--enable-metrics` публикуются `sglang:lora_pool_slots_total` (равно этому аргументу), `sglang:lora_pool_slots_used` и `sglang:lora_pool_utilization`. Утилизация, стабильно равная 1.0, — прямой сигнал, что слотов не хватает.
- **CUDA graph.** Метаданные батча backend'а (`lora_ranks`, `scalings`, `weight_indices`) размерны по этому числу; вклад незначителен на фоне буферов весов.

## Взаимодействие с другими аргументами

- `--max-lora-rank`: второй множитель в формуле объема. Пара «слоты × ранг» и есть цена LoRA в VRAM.
- `--lora-target-modules`: третий множитель. `all` вместе с `lm_head`/`embed_tokens` резко увеличивает пул.
- `--max-loaded-loras`: должен быть ≥ этого значения; при overlap-загрузке ≤ его удвоения.
- `--lora-eviction-policy`: как выбирается жертва, когда все слоты заняты.
- `--lora-drain-wait-threshold`: лечит голодание, возникающее именно из-за нехватки слотов.
- `--lora-paths` c `pinned`: закрепленные адаптеры уменьшают доступную ёмкость; потолок закрепления — `max - 1`.
- `--mem-fraction-static`: KV-пул считается по свободной памяти уже после LoRA-буферов, так что при увеличении числа слотов пул сжимается автоматически.
- В arriero пул адаптеров входит в фактический VRAM-draw инстанса и должен быть учтен в `config/resources.json` (`docs/RESOURCE_MANAGEMENT.md`); аналитическая оценка по весам модели его не видит.

## Типовые проблемы и диагностика

- `AssertionError: max_loras_per_batch must be positive` — значение 0 или отрицательное.
- `ValueError: No available buffer slots found. Please ensure the number of active (pinned) loras is less than max_loras_per_batch.` — все слоты заняты закрепленными адаптерами или адаптерами текущего батча.
- `AssertionError: max_loaded_loras should be greater than or equal to max_loras_per_batch.`
- Заявки к «холодным» адаптерам стоят в очереди, GPU при этом не загружен — слотов меньше, чем активных адаптеров; поднимайте значение или включайте `--lora-drain-wait-threshold`.
- KV-пул меньше ожидаемого: сравните `max_total_num_tokens` из стартовой строки планировщика с прогоном без LoRA — разница и есть цена пула.
- Значение видно в дампе `server_args=` и в метрике `sglang:lora_pool_slots_total`; фактическую занятость показывает `sglang:lora_pool_slots_used`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-paths lora1=/models/lora/lora1 --max-loras-per-batch 2 --max-lora-rank 64
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 16 --lora-target-modules qkv_proj o_proj --max-loras-per-batch 16 --max-loaded-loras 64 --lora-eviction-policy lru
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/lora/utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
