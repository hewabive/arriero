---
schema: 1
engine: sglang
primaryName: "--enable-linker-mla-dedup"
title: "--enable-linker-mla-dedup"
summary: Opt-in дедупликация чтения реплицированного MLA KV из Mooncake при direct linker UnifiedRadixCache — читает только attention-TP rank 0, остальные получают слои NCCL-broadcast'ом. Без Mooncake-linker старт падает.
group: memory
related:
  - --enable-unified-cache-external-linker
  - --unified-cache-external-linker-backend
  - --hicache-storage-backend-extra-config
  - --tp-size
  - --enable-dp-attention
---

# --enable-linker-mla-dedup

## Кратко

У MLA-подобных моделей KV-кеш одинаков на всех attention-TP rank'ах: каждый rank хранит полную реплику. Когда UnifiedRadixCache работает напрямую с Mooncake (`--enable-unified-cache-external-linker`), при попадании в префикс каждый rank по умолчанию сам читает из хранилища одни и те же страницы. Флаг оставляет чтение только rank'у 0 его attention-TP группы, а остальные rank'и получают каждый загруженный слой NCCL-broadcast'ом по GPU-сети. Это экономия пропускной способности Mooncake ценой отдельной NCCL-группы и staging-буфера в VRAM. Флаг новый в checkout'е; есть ли он в установленной сборке, проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Load replicated MLA KV on rank 0 and broadcast each layer with the Mooncake linker.
```

## Паспорт аргумента

- Флаги: `--enable-linker-mla-dedup`
- Группа: `memory`
- Тип значения: bool (флаг без значения)
- Допустимые значения: есть / нет
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; `handle_hicache` (`arg_groups/hicache_hook.py`) его не переписывает, а только отвергает конфигурацию без Mooncake-linker. Фактически дедупликация включается при построении linker'а, и только если пулы rank-replicated и размер attention-TP группы больше 1 — иначе флаг молча ничего не делает
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.enable_linker_mla_dedup`
- Статус: обычный, opt-in
- Этап применения: проверка в `__post_init__` (`handle_hicache`) → конструктор `MooncakeDirectLinker` при создании дерева кеша (создание NCCL-группы и staging-буфера) → каждый батч с загрузкой префикса из Mooncake

## Что меняет в движке

Проверка на старте (`handle_hicache`, выполняется первой строкой функции, до всех остальных HiCache-нормализаций):

```python
if cfg.enable_linker_mla_dedup and (
    not cfg.enable_unified_cache_external_linker
    or cfg.unified_cache_external_linker_backend != "mooncake"
):
    raise ValueError("--enable-linker-mla-dedup requires the Mooncake linker.")
```

Сама дедупликация живет в `MooncakeDirectLinker` (`mem_cache/storage/mooncake_store/mooncake_direct_linker.py`). В конструкторе:

- группа device-пулов собирается через `resolve_hybrid_device_pool_group`. В checkout'е direct linker поддерживают только стратегии DeepSeek-V4 и DSA (DeepSeek Sparse Attention); обе помечают группу `rank_replicated=True`. Для остальных пулов linker отказывает еще до флага («does not support the direct external linker»);
- при `enable_linker_mla_dedup and rank_replicated and tp_size > 1` строится `LinkerMLADedupBroadcaster` (`mem_cache/unified_cache/linker_mla_dedup.py`) — адаптер над примитивом `MLAHostDedupBroadcaster` из `mem_cache/mla_host_dedup.py`. Он создает **отдельную NCCL-группу** поверх TP-группы (при DP attention — поверх attention-TP), источник — rank 0 этой группы; в лог идет `MLA linker rank-0 loading enabled: tp_rank=…/…`.

На каждом батче с загрузкой (`start_layer_wise_loading`):

1. rank'и обмениваются SHA-256 от плана загрузки (rid и ключи страниц) через `all_gather_object` по TP-группе. Если планы где-то различаются, батч идет старым путем, где читают все rank'и, и в лог пишется `MLA linker load plans differ; using all-rank reads.`;
2. при совпадении только rank 0 ставит чтение в поток загрузки Mooncake; остальные rank'и сразу помечают слои «готовыми» на своей стороне и ждут broadcast;
3. по мере готовности слоя на rank 0 в forward-потоке запускается broadcast этого слоя всем rank'ам группы (каждый слой — ровно один раз, по порядку), так что forward и загрузка перекрываются послойно.

Запись в Mooncake (offload) от флага не зависит: для rank-replicated пулов ее и так делает только rank 0 (`offload_owner`).

## Значения и формат

- Флаг без значения; `false` по умолчанию.
- Задан без `--enable-unified-cache-external-linker` или с `--unified-cache-external-linker-backend mori` — `ValueError` на старте.
- Задан при `--tp-size 1` (или attention-TP размера 1 под DP attention) — группы для broadcast нет, флаг не действует, ошибки нет.
- Размер staging-чанка для broadcast задается переменной окружения `SGLANG_MLA_DEDUP_CHUNK_TOKENS` (по умолчанию `2048`); значение `≤ 0` дает `ValueError` при построении linker'а.

## Когда использовать

- Direct linker на Mooncake с DeepSeek-V4 или DSA-моделью, attention-TP больше 1, и узким местом при попаданиях в префикс стала пропускная способность Mooncake (сеть до хранилища или его чтение): без флага одни и те же страницы читаются `attn_tp_size` раз.
- Не включайте, если GPU одного attention-TP связаны медленно (без NVLink): тогда broadcast по NCCL может стоить дороже, чем параллельное чтение из хранилища на всех rank'ах.
- Для HiCache (`--enable-hierarchical-cache`) флаг не предназначен: direct linker и HiCache взаимоисключающие.

## Влияние на производительность и память

- Трафик к Mooncake при загрузке префикса падает примерно в `attn_tp_size` раз; взамен каждый слой проходит broadcast внутри группы.
- VRAM: на каждом rank'е выделяется staging-буфер порядка `число слоев × SGLANG_MLA_DEDUP_CHUNK_TOKENS × байт KV на токен` (не меньше одной физической строки страницы). Буфер создается уже после выделения KV-пула, то есть из того запаса VRAM, который `--mem-fraction-static` оставляет вне пула; большой `SGLANG_MLA_DEDUP_CHUNK_TOKENS` съедает именно этот запас.
- Дополнительный NCCL-коммуникатор создается на старте — немного памяти и времени инициализации.
- Каждый батч с загрузкой добавляет CPU-коллектив `all_gather_object` для сверки планов; на латентности это заметно меньше, чем само чтение, но это синхронизация всех rank'ов.

## Взаимодействие с другими аргументами

- `--enable-unified-cache-external-linker`: обязателен; он же взаимоисключающий с `--enable-hierarchical-cache` и с заданным `--hicache-storage-backend`.
- `--unified-cache-external-linker-backend`: должен быть `mooncake` (значение по умолчанию); с `mori` старт падает.
- `--hicache-storage-backend-extra-config`: конфигурация Mooncake-хранилища linker'а берется отсюда; на дедупликацию не влияет.
- `--tp-size`, `--enable-dp-attention`: определяют группу broadcast'а — полная TP-группа без DP attention, attention-TP группа с ним. При размере группы 1 флаг бесполезен.

## Типовые проблемы и диагностика

- `ValueError: --enable-linker-mla-dedup requires the Mooncake linker.` — нет `--enable-unified-cache-external-linker` или backend не `mooncake`.
- Флаг задан, но строки `MLA linker rank-0 loading enabled` в логе нет — группа пулов не rank-replicated или attention-TP размера 1. Проверьте строку `Mooncake direct linker storage topology: rank_replicated=…, tp_rank=…/…` — она печатается всегда.
- Частые `MLA linker load plans differ; using all-rank reads.` — rank'и вставили в дерево разные страницы, и дедупликация для этих батчей не работает; выигрыш по трафику пропадает, корректность сохраняется.
- `RuntimeError: Mooncake layer-wise KV load failed.` — ошибка чтения на rank'е-источнике; при дедупликации она касается всей группы, смотрите лог потока `mooncake-load-tp0`.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --tp-size 8 --enable-unified-cache-external-linker --unified-cache-external-linker-backend mooncake --enable-linker-mla-dedup
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --tp-size 8 --enable-dp-attention --dp-size 2 --enable-unified-cache-external-linker --enable-linker-mla-dedup
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/arg_groups/hicache_hook.py`
- `sglang/python/sglang/srt/mem_cache/storage/mooncake_store/mooncake_direct_linker.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/linker_mla_dedup.py`
- `sglang/python/sglang/srt/mem_cache/mla_host_dedup.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/linker_pool_assembler.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_pool_assembler.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
