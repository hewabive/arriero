---
schema: 1
engine: sglang
primaryName: "--lora-eviction-policy"
title: "--lora-eviction-policy"
summary: Как выбирается жертва, когда все слоты GPU-пула адаптеров заняты: по давности использования (`lru`) или по порядку заселения (`fifo`). К вытеснению адаптеров из RAM хоста отношения не имеет.
group: lora
related:
  - --max-loras-per-batch
  - --max-loaded-loras
  - --lora-paths
  - --enable-lora
  - --lora-drain-wait-threshold
---

# --lora-eviction-policy

## Кратко

Слотов в GPU-пуле ровно `--max-loras-per-batch`. Когда для адаптера текущего батча свободного слота нет, один из занятых надо освободить — политику выбора и задает этот аргумент. `lru` (по умолчанию) отдает слот адаптера, к которому дольше всего не обращались, `fifo` — того, кто заехал в пул раньше всех. Политика применяется только к GPU-пулу; вытеснение из RAM хоста по `--max-loaded-loras` всегда идет по LRU и этим аргументом не управляется.

## Оригинальная справка

```text
LoRA adapter eviction policy when memory pool is full. 'lru': Least Recently Used (default, better cache efficiency). 'fifo': First-In-First-Out.
```

## Паспорт аргумента

- Флаги: `--lora-eviction-policy`
- Группа: `lora`
- Тип значения: строка
- Допустимые значения: `lru`, `fifo`
- Значение по умолчанию: `lru`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.lora_eviction_policy`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `LoRAMemoryPool` (через `LoRAManager`) → каждый вызов `prepare_lora_batch`

## Что меняет в движке

`get_eviction_policy(name)` (`sglang/python/sglang/srt/lora/eviction_policy.py`) создает `LRUEvictionPolicy` или `FIFOEvictionPolicy`. Обе реализуют один интерфейс `mark_used` / `select_victim` / `remove` поверх `OrderedDict`:

- **`lru`** на каждом обращении перекладывает uid в конец словаря (`mark_used` вызывается для **всех** адаптеров текущего батча, до подбора слотов) и при выборе жертвы идет от начала — то есть от самого давнего обращения.
- **`fifo`** записывает uid только при первом появлении (`if uid not in self.insertion_order`) и выбирает жертву в порядке заселения, игнорируя обращения.

Ключевая часть — не сама политика, а фильтрация кандидатов в `LoRAMemoryPool.prepare_lora_batch`:

1. сначала ищется пустой слот — если он есть, никакого вытеснения не происходит;
2. иначе кандидатами становятся слоты, чей адаптер **не нужен текущему батчу** и **не помечен `pinned`**;
3. при пустом множестве кандидатов бросается `ValueError: No available buffer slots found. Please ensure the number of active (pinned) loras is less than max_loras_per_batch.`;
4. из кандидатов **сначала** берутся настоящие адаптеры, и только если их нет — слот базовой модели (`uid = None`). То есть базовая модель вытесняется последней, когда батч состоит целиком из LoRA-запросов;
5. выбранная жертва отдается политике, слот помечается пустым, и в него копируются веса нового адаптера.

Для детерминизма между TP-процессами uid'ы батча предварительно сортируются: `sorted(cur_uids, key=lambda uid: (uid is not None, uid or ""))` — иначе разные seed'ы хеша Python дали бы разным рангам разный порядок обновления слотов и LRU.

Освобожденный слот не просто помечается пустым: при заезде адаптера, у которого нет какого-то из целевых модулей, соответствующий срез буфера обнуляется, а при возврате слота базовой модели обнуляется весь срез (`_clear_buffer_slot_for_base`) — чтобы захваченный в CUDA graph базовый путь не прочитал остатки предыдущего адаптера.

## Значения и формат

- Одна строка из двух; всё прочее argparse отвергнет как `invalid choice`.
- Неизвестное имя, дошедшее до фабрики иным путем, даст `ValueError: Unknown eviction policy: <name>`.
- Политика глобальная — одна на весь пул.
- Явного «без вытеснения» нет: его роль играют `pinned`-адаптеры и достаточное число слотов.

## Когда использовать

- Оставьте `lru`: при повторяющемся трафике по нескольким адаптерам он и задуман как более эффективный по кешу, что зафиксировано и в самой справке.
- `fifo` осмыслен, когда обращения к адаптерам близки к равномерным и вам нужна предсказуемая ротация, либо для сравнения при отладке нестабильной latency.
- **Не пытайтесь** политикой вылечить нехватку слотов: если активных адаптеров стабильно больше, чем `--max-loras-per-batch`, вытеснения будут при любой политике. Правильные ручки — `--max-loras-per-batch`, `pinned` в `--lora-paths` и `--lora-drain-wait-threshold`.
- **Не рассчитывайте**, что политика влияет на RAM хоста: вытеснение по `--max-loaded-loras` идет по своему, всегда-LRU пути в tokenizer-менеджере.

## Влияние на производительность и память

- Памяти не потребляет: политика хранит один `OrderedDict` с uid'ами, размер которого ограничен числом загруженных адаптеров.
- На latency влияет косвенно, через частоту промахов слота: каждый промах — копия весов адаптера с CPU в слот пула (`copy_weight_into_buffer`) перед батчем.
- На размер пула и на KV-кеш не влияет вообще.
- При `--enable-lora-overlap-loading` копия идет на отдельном stream'е и перекрывается вычислениями, так что цена промаха ниже, но не нулевая.

## Взаимодействие с другими аргументами

- `--max-loras-per-batch`: число слотов; именно оно определяет, как часто политика вообще будет вызываться.
- `--lora-paths` с `pinned: true`: закрепленные адаптеры исключены из кандидатов на любой политике.
- `--max-loaded-loras`: другой ярус иерархии со своей, неизменяемой LRU-политикой.
- `--lora-drain-wait-threshold`: борется не с вытеснением, а с голоданием в очереди планировщика, возникающим из-за той же нехватки слотов.
- `--enable-lora-overlap-loading`: меняет стоимость промаха, не логику выбора жертвы.

## Типовые проблемы и диагностика

- `argument --lora-eviction-policy: invalid choice: 'random'`.
- `ValueError: No available buffer slots found. Please ensure the number of active (pinned) loras is less than max_loras_per_batch.` — политика тут ни при чем: кандидатов не осталось из-за закрепленных адаптеров или из-за того, что все слоты нужны текущему батчу.
- Нестабильная latency на части адаптеров при `fifo` — ожидаемое поведение: горячий адаптер вытесняется наравне с холодным.
- Событий вытеснения в логе по умолчанию не видно — они пишутся на уровне `debug` (`Evicting LoRA <uid> from buffer slot <id>.`, `Selected LoRA <uid> for eviction (LRU)`). Косвенный индикатор без включения debug-логов — метрика `sglang:lora_pool_utilization`, стабильно равная 1.0.
- Значение аргумента видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-paths a=/models/lora/a b=/models/lora/b c=/models/lora/c --max-loras-per-batch 2 --lora-eviction-policy lru
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 32 --lora-target-modules all --max-loras-per-batch 4 --lora-eviction-policy fifo --log-level debug
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/eviction_policy.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
