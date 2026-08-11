---
schema: 1
engine: sglang
primaryName: "--max-loaded-loras"
title: "--max-loaded-loras"
summary: Потолок числа адаптеров, одновременно зарегистрированных и кешированных в RAM хоста. При превышении tokenizer-менеджер выгружает LRU-адаптер, а запрос к нему позже автоматически перезагрузит его с диска.
group: lora
related:
  - --max-loras-per-batch
  - --lora-paths
  - --enable-lora
  - --enable-lora-overlap-loading
  - --lora-eviction-policy
  - --max-lora-rank
---

# --max-loaded-loras

## Кратко

`--max-loaded-loras` ограничивает **верхний ярус** LoRA-иерархии: сколько адаптеров одновременно живет в памяти хоста и числится в реестре. Не путайте с `--max-loras-per-batch` — тот отвечает за резидентность на GPU. Когда после загрузки очередного адаптера регистр превышает лимит, tokenizer-менеджер выгружает наименее недавно использованный незакрепленный адаптер; последующий запрос к нему прозрачно перезагрузит его с диска. Не задан — лимита нет вообще, и загруженные адаптеры копятся в RAM.

## Оригинальная справка

```text
If specified, it limits the maximum number of LoRA adapters loaded in CPU memory at a time. The value must be greater than or equal to `--max-loras-per-batch`.
```

## Паспорт аргумента

- Флаги: `--max-loaded-loras`
- Группа: `lora`
- Тип значения: `Optional[int]`
- Допустимые значения: целое ≥ `--max-loras-per-batch`; при `--enable-lora-overlap-loading` дополнительно ≤ `2 × --max-loras-per-batch`
- Значение по умолчанию: `null` — лимита нет
- Эффективное значение: не переопределяется; `check_lora_server_args` только проверяет соотношения
- Где объявлен: `ServerArgs.max_loaded_loras`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (валидация) → `TokenizerManager` при каждой загрузке адаптера и при разборе `lora_path` запроса

## Что меняет в движке

### Проверки на старте

В `check_lora_server_args`:

```python
assert self.max_loaded_loras >= self.max_loras_per_batch, ...
assert len(self.lora_paths) <= self.max_loaded_loras, ...
```

и отдельно для overlap-загрузки:

```python
max_loaded_loras_limit = self.max_loras_per_batch * 2
assert self.max_loaded_loras is not None and self.max_loaded_loras <= max_loaded_loras_limit, (
    "Enabling LoRA overlap loading requires pinning LoRA adapter weights in CPU memory, "
    f"so --max-loaded-loras must be less than or equal to double --max-loras-per-batch: {max_loaded_loras_limit}"
)
```

Обратите внимание: при `--enable-lora-overlap-loading` аргумент становится **обязательным** — значение `None` ассерт не проходит.

### Вытеснение в рантайме

`tokenizer_control_mixin.py`, сразу после успешной регистрации нового адаптера:

```python
while self.lora_registry.num_registered_loras > self.server_args.max_loaded_loras:
    lru_lora_name = await self.lora_registry.lru_lora_name(exclude_pinned=True)
    ...
    unload_result = await self._unload_lora_adapter_locked(...)
```

Ключевые детали: политика здесь **всегда LRU** (`--lora-eviction-policy` относится только к GPU-пулу), закрепленные адаптеры исключаются из кандидатов, а если незакрепленных кандидатов не осталось — бросается `ValueError: Didn't find any LoRA adapters when trying to evict LRU LoRA adapter.` Выгруженное имя удаляется из ответа `loaded_adapters`.

### Автоматическая перезагрузка

Выгрузка не окончательна. `TokenizerManager._resolve_lora_path` перед каждым запросом:

- проверяет `len(unique_lora_paths) > max_loaded_loras` и отклоняет запрос с `Received request with N unique loras requested but max loaded loras is M` — это защита от батча, который заведомо не помещается;
- находит адаптеры, которые были зарегистрированы когда-то, но сейчас выгружены, и **перезагружает их** из `lora_ref_cache` (лог `Reloading evicted adapter: <name>`), сохраняя исходный флаг `pinned`;
- имя, которое никогда не загружалось, дает `Got LoRA adapter that has never been loaded: <name>`.

Таким образом кеш адаптеров в RAM ведет себя как LRU с прозрачным промахом: цена промаха — чтение весов с диска (или из HF-кеша) прямо на пути запроса.

## Значения и формат

- Целое. Аргумент не задан — ограничения нет, и число адаптеров в RAM растет неограниченно.
- Минимум — `--max-loras-per-batch`: иначе GPU-пул физически не смог бы набрать батч.
- При overlap-загрузке допустимый диапазон сужается до `[max_loras_per_batch, 2 × max_loras_per_batch]`.
- Число стартовых `--lora-paths` не может превышать это значение.
- Значение считает **адаптеры**, а не байты: реальный расход RAM зависит от ранга и целевых модулей каждого адаптера.

## Когда использовать

- Адаптеры загружаются динамически и их номенклатура открытая (мультиарендный сервис): без лимита RAM хоста растет линейно с числом когда-либо загруженных адаптеров.
- Включаете `--enable-lora-overlap-loading` — там аргумент обязателен, и его смысл усиливается: веса становятся pinned, то есть неосвобождаемыми.
- **Не занижайте до значения, близкого к `--max-loras-per-batch`**, при разнообразном трафике: адаптеры начнут вытесняться из RAM и перечитываться с диска, а это самый дорогой промах в иерархии.
- **Не нужен**, если набор адаптеров фиксирован `--lora-paths` и невелик.

## Влияние на производительность и память

- **RAM хоста.** Это единственный аргумент, ограничивающий верхний ярус. Один адаптер весит примерно `rank × Σ(размеры целевых модулей) × слои × размер элемента` — тот же порядок, что и один слот GPU-пула (для Llama-3.1-8B в bf16 с четырьмя группами модулей это ~5 МиБ на единицу ранга).
- **Pinned-память.** При `--enable-lora-overlap-loading` веса закрепляются (`weight.pin_memory()` с кешем по ключу), поэтому лимит `2 × max_loras_per_batch` существует именно как защита от исчерпания закрепленной памяти.
- **Latency.** Промах на этом ярусе означает чтение весов адаптера с диска в момент обработки запроса — на порядки дороже, чем промах слота GPU.
- **VRAM.** Не затрагивается: на GPU одновременно живет ровно `--max-loras-per-batch` адаптеров.

## Взаимодействие с другими аргументами

- `--max-loras-per-batch`: нижняя граница; при overlap-загрузке ещё и верхняя (удвоенная).
- `--enable-lora-overlap-loading`: делает аргумент обязательным и ужесточает потолок.
- `--lora-paths`: их количество не может превышать лимит; закрепленные (`pinned`) адаптеры никогда не вытесняются с этого яруса.
- `--lora-eviction-policy`: **не влияет** на этот ярус — здесь всегда LRU.
- `--max-lora-rank`, `--lora-target-modules`: определяют, сколько RAM стоит один «слот» этого лимита.
- В arriero расход RAM на кеш адаптеров относится к host-пулу инстанса (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `AssertionError: max_loaded_loras should be greater than or equal to max_loras_per_batch. max_loaded_loras=2, max_loras_per_batch=8`.
- `AssertionError: The number of LoRA paths should not exceed max_loaded_loras.`
- `AssertionError: Enabling LoRA overlap loading requires pinning LoRA adapter weights in CPU memory, so --max-loaded-loras must be less than or equal to double --max-loras-per-batch: N` — в том числе когда аргумент просто не задан.
- `ValueError: Received request with 12 unique loras requested but max loaded loras is 8` — в одном batched-запросе перечислено больше уникальных адаптеров, чем разрешено держать.
- `ValueError: Didn't find any LoRA adapters when trying to evict LRU LoRA adapter.` — все зарегистрированные адаптеры закреплены.
- В логе видно и вытеснение (`Unloading least recently used LoRA adapter '<name>' (current number of adapters: N, max allowed: M)`), и обратную подгрузку (`Reloading evicted adapter: <name>`). Частые пары этих строк — сигнал, что лимит занижен.
- Значение видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 64 --lora-target-modules all --max-loras-per-batch 4 --max-loaded-loras 32
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-paths lora1=/models/lora/lora1 lora2=/models/lora/lora2 --max-loras-per-batch 2 --max-loaded-loras 4 --enable-lora-overlap-loading
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/lora/lora_registry.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
