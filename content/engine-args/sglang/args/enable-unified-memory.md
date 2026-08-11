---
schema: 1
engine: sglang
primaryName: "--enable-unified-memory"
title: "--enable-unified-memory"
summary: Для гибридных моделей (Mamba/GDN и SWA) заменяет два статически нарезанных пула одним байтовым буфером, который делится между под-пулами динамически. Экспериментальный путь с длинным списком проверяемых на старте ограничений.
group: memory
related:
  - --enable-page-major-kv-layout
  - --attention-backend
  - --linear-attn-backend
  - --mamba-backend
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --speculative-algorithm
  - --speculative-eagle-topk
  - --enable-hierarchical-cache
  - --enable-lmcache
  - --enable-hisparse
  - --dcp-size
  - --pp-size
---

# --enable-unified-memory

## Кратко

У гибридной модели два вида состояния — KV полного внимания и состояние SWA/Mamba — и по умолчанию они живут в отдельных пулах, размеры которых фиксируются на старте. Если рабочая нагрузка перекошена (длинные последовательности против множества коротких), один пул простаивает, второй становится узким местом. `--enable-unified-memory` кладет оба в один байтовый буфер с динамическим разделением. Это **экспериментальный** путь: он поддерживает только гибридные модели, требует Triton-ядер, неявно включает `--enable-page-major-kv-layout` и проверяет на старте больше десятка условий, каждое из которых при нарушении дает ассерт.

## Оригинальная справка

```text
Replace the statically-partitioned hybrid-model pools (full-attn KV + SWA/Mamba state) with one byte buffer split dynamically between sub-pools. Requires the Triton attention / linear-attn / Mamba backends; not yet compatible with PD disaggregation or speculative decoding.
```

## Паспорт аргумента

- Флаги: `--enable-unified-memory`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: сам флаг не переопределяется, но он **переопределяет чужой**: `_handle_page_major_kv_layout` принудительно выставляет `enable_page_major_kv_layout = True`
- Где объявлен: `ServerArgs.enable_unified_memory`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: экспериментальный; в тексте справки и в коде часть ограничений помечена как «not yet», ограничения снимаются по мере аудита отдельных путей
- Этап применения: `__post_init__` (`_handle_unified_memory_pool`, `_handle_page_major_kv_layout`) → построение пулов в `KVCacheConfigurator._init_pools` → forward и захват CUDA graph

## Что меняет в движке

При поднятом флаге `KVCacheConfigurator._init_pools` (`sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`) уходит на отдельную ветку и строит `req_to_token_pool`, KV-пул и аллокатор из одного буфера:

- hybrid-Mamba модель → `_init_unified_mamba_pools`, полный под-пул страничный, mamba-под-пул с page=1;
- hybrid-SWA модель (кроме DeepSeek V4) → `_init_unified_swa_pools`;
- любая другая модель → `ValueError` «--enable-unified-memory only supports hybrid Mamba and hybrid sliding-window-attention models (DeepSeek-V4 excluded)…». Ветка специально падает, а не откатывается на обычные пулы, чтобы флаг не оказался молчаливым no-op.

Аллокатор раздает **виртуальные** идентификаторы слотов из пространства шире `max_total_num_tokens`, а трансляция в плотные физические позиции происходит на границе доступа. Отсюда почти все ограничения: путь, который не умеет транслировать виртуальные идентификаторы, для unified-пула небезопасен.

`_handle_unified_memory_pool` проверяет на старте:

- спекулятивное декодирование — только `DSPARK` и только линейной цепочкой (`--speculative-eagle-topk` из `{None, 1}`), причем оба attention-бэкенда должны быть из набора `triton`, `trtllm_mla`, `cutedsl_mla`, `tokenspeed_mla`;
- PD-дизагрегация — только `--disaggregation-transfer-backend mooncake`, `--pp-size 1`, включенная lazy compaction и без `--enable-hisparse`; для hybrid-SWA PD вообще не поддержан, а для hybrid-Mamba — только MLA-варианты;
- `--enable-hierarchical-cache` и `--enable-lmcache` запрещены: unified-пул не поднимает host-пулы, а его слоты виртуальные;
- `--dcp-size` обязан быть `1`;
- piecewise-захват prefill CUDA graph запрещен, поддержан только монолитный decode-захват.

`_handle_page_major_kv_layout` затем включает page-major layout и проверяет бэкенды. Для MLA-модели с unified-пулом список разрешенных полных бэкендов расширен (`triton`, `fa3`, `trtllm_mla`, `flashinfer`, `cutedsl_mla`, `tokenspeed_mla`), поскольку unified MLA-пул отдает плотные пер-слойные представления; в остальных случаях допустим только `triton`.

## Значения и формат

- Флаг без аргумента.
- Ручек «сколько отдать под KV, сколько под состояние» нет: в этом и смысл — деление динамическое.
- Общий объем буфера по-прежнему определяется `--mem-fraction-static` и производными от него ограничениями.

## Когда использовать

- Гибридная Mamba/GDN или SWA-модель, у которой измеренно простаивает один из пулов: например, нагрузка «много коротких запросов» упирается в state-пул при полупустом KV-пуле, или наоборот.
- Есть возможность работать на Triton-бэкендах внимания и mamba/linear-attn.
- Не включайте на обычной (не гибридной) модели — старт упадет с явным `ValueError`.
- Не включайте вместе с HiCache/LMCache, PD-дизагрегацией на неподдержанной топологии и почти любым спекулятивным декодированием: список исключений длинный и проверяется жестко.
- Учитывайте, что путь экспериментальный: обновление SGLang может изменить набор допустимых комбинаций.

## Влияние на производительность и память

- Общий объем VRAM не меняется — меняется только то, что граница между KV и состоянием подвижна. Выигрыш проявляется как рост эффективной конкурентности на перекошенной нагрузке.
- Обязательный page-major layout сам по себе меняет раскладку KV и ограничивает выбор ядер внимания; на моделях, где Triton медленнее альтернатив, это может съесть выигрыш.
- Захват CUDA graph доступен только монолитный (decode); piecewise-prefill выключен, что на некоторых конфигурациях стоит времени prefill.
- Виртуально-физическая трансляция добавляет небольшой оверхед на доступ к слотам.
- Время старта заметно не меняется.

## Взаимодействие с другими аргументами

- `--enable-page-major-kv-layout`: включается автоматически и не может быть отключен при поднятом unified-пуле.
- `--attention-backend` / `--linear-attn-backend` / `--mamba-backend`: должны быть Triton-совместимы (для MLA-моделей набор шире, см. выше); нарушение — ассерт с перечислением допустимых значений.
- `--speculative-algorithm`: только `DSPARK`, только с `--speculative-eagle-topk` из `{None, 1}`.
- `--disaggregation-mode` != `null`: требует `--disaggregation-transfer-backend mooncake`, `--pp-size 1`, отсутствия `--enable-hisparse`, а для hybrid-SWA не поддерживается вовсе.
- `--enable-hierarchical-cache`, `--enable-lmcache`: жестко запрещены.
- `--dcp-size` > 1: запрещен (`UnifiedMHATokenToKVPool.set_kv_buffer` не имеет DCP-пути записи).
- `--cuda-graph-backend-prefill`: piecewise-режим приводит к `ValueError`, отключайте его.

## Типовые проблемы и диагностика

- `ValueError: --enable-unified-memory only supports hybrid Mamba and hybrid sliding-window-attention models (DeepSeek-V4 excluded)…` — модель не подходит.
- Ассерт «--enable-page-major-kv-layout requires the Triton attention backend for the full-attention layers … got [...], allowed [...]» — задан неподдерживаемый attention backend.
- Ассерт «--enable-unified-memory is not yet compatible with hierarchical / host-tiered KV cache …» — уберите HiCache/LMCache.
- Ассерт «--enable-unified-memory only supports --speculative-algorithm DSPARK …» — снимите спекулятивное декодирование.
- `ValueError: --enable-unified-memory supports monolithic (decode) cuda-graph capture only; disable piecewise prefill capture …` — отключите piecewise-захват.
- Ассерт «--enable-unified-memory is not yet compatible with decode context parallelism (--dcp-size > 1)…» — снимите DCP.
- Что реально принято, показывает дамп `server_args=` при старте — в нем уже видно принудительно поднятый `enable_page_major_kv_layout`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/qwen3-next-hybrid --enable-unified-memory --attention-backend triton --linear-attn-backend triton --mamba-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/kimi-linear --enable-unified-memory --attention-backend triton --mamba-backend triton --page-size 64 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/mem_cache/unified_memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/multi_ended_allocator.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
