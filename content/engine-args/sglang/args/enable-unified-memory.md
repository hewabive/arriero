---
schema: 1
engine: sglang
primaryName: "--enable-unified-memory"
title: "--enable-unified-memory"
summary: Для гибридных моделей (Mamba/GDN/KDA и SWA) заменяет статически нарезанные пулы одним байтовым буфером, который делится между под-пулами динамически. Экспериментальный путь: допустимые сочетания с PD, спекуляцией, DCP и backend'ами внимания проверяются на старте и меняются от релиза к релизу.
group: memory
related:
  - --enable-page-major-kv-layout
  - --attention-backend
  - --linear-attn-backend
  - --mamba-backend
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --disaggregation-decode-retraction-backup
  - --disaggregation-decode-enable-offload-kvcache
  - --speculative-algorithm
  - --speculative-eagle-topk
  - --enable-hierarchical-cache
  - --enable-lmcache
  - --enable-hisparse
  - --enable-two-batch-overlap
  - --kv-cache-dtype
  - --cuda-graph-backend-prefill
  - --dcp-size
  - --pp-size
---

# --enable-unified-memory

## Кратко

У гибридной модели два вида состояния — KV полного внимания и состояние SWA/Mamba — и по умолчанию они живут в отдельных пулах, размеры которых фиксируются на старте. Если рабочая нагрузка перекошена (длинные последовательности против множества коротких), один пул простаивает, второй становится узким местом. `--enable-unified-memory` кладет оба в один байтовый буфер с динамическим разделением. Это **экспериментальный** путь: он поддерживает только гибридные модели, неявно включает `--enable-page-major-kv-layout` и проверяет на старте длинный список сочетаний — каждое нарушение дает `AssertionError` или `ValueError` еще до загрузки весов.

## Оригинальная справка

```text
Replace the statically-partitioned hybrid-model pools (full-attn KV + SWA/Mamba state) with one byte buffer split dynamically between sub-pools. Requires the Triton attention / linear-attn / Mamba backends. Supported PD-disaggregation and speculative-decoding configurations are validated at startup.
```

Фраза про Triton в справке строже кода: обязательным Triton остается только Mamba-backend, для полного внимания и linear-attn допустимы и другие ядра (см. ниже).

## Паспорт аргумента

- Флаги: `--enable-unified-memory`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: сам флаг не переопределяется, но он **переопределяет чужой**: `handle_page_major_kv_layout` принудительно выставляет `enable_page_major_kv_layout = True`; при FULL-backend'е prefill CUDA graph без fa3/fa4 `handle_unified_memory_pool` переводит prefill-захват в `disabled`
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.enable_unified_memory`
- Статус: экспериментальный; набор допустимых сочетаний расширяется по мере аудита отдельных путей
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline` (`handle_kv4_compatibility`, `handle_page_major_kv_layout`, `handle_unified_memory_pool` в `arg_groups/kv_cache_hook.py`) → построение пулов в `KVCacheConfigurator._init_pools` → forward и захват CUDA graph; часть PD-ограничений проверяется только при первой передаче KV

## Что меняет в движке

При поднятом флаге `KVCacheConfigurator._init_pools` (`sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`) уходит на отдельную ветку и строит `req_to_token_pool`, KV-пул и аллокатор из одного буфера:

- модель одновременно hybrid-Mamba и hybrid-SWA (кроме DeepSeek V4) → `_init_unified_mamba_swa_pools`;
- hybrid-Mamba (Mamba2, GDN, KDA, Lightning и зарегистрированные linear-attn архитектуры) → `_init_unified_mamba_pools`, полный под-пул страничный, mamba-под-пул с page=1;
- hybrid-SWA (кроме DeepSeek V4) → `_init_unified_swa_pools`;
- любая другая модель → `ValueError` «--enable-unified-memory only supports hybrid Mamba and hybrid sliding-window-attention models (DeepSeek-V4 excluded)…». Ветка специально падает, а не откатывается на обычные пулы, чтобы флаг не оказался молчаливым no-op.

Размер общего буфера — весь профилированный бюджет KV, выровненный вниз до 4096 байт. Опциональный post-capture KV sizing (`SGLANG_ENABLE_POST_CAPTURE_KV_SIZING`, по умолчанию выключен) для unified-пула не применяется: буфер полностью выделяется до захвата графов и потом не растет.

Аллокатор раздает **виртуальные** идентификаторы слотов из пространства шире `max_total_num_tokens`, а трансляция в плотные физические позиции происходит на границе доступа. Отсюда почти все ограничения: путь, который не умеет транслировать виртуальные идентификаторы, для unified-пула небезопасен.

### Проверки на старте

`handle_page_major_kv_layout` включает page-major layout и проверяет модель и backend'ы:

- не-MLA модель должна иметь одинаковую ширину K и V (`head_dim == v_head_dim`, то же для SWA-слоев), иначе отказ «--enable-unified-memory requires uniform K/V rows…»;
- полное внимание: для MLA-моделей — `triton`, `fa3`, `trtllm_mla`, `flashinfer`, `cutedsl_mla`, `tokenspeed_mla`, `flashmla`; для MHA/SWA-моделей — `triton`, `fa3`, `fa4`, `flashinfer`, `trtllm_mha`;
- linear-attn decode — `triton` или `flashinfer`, prefill — `triton` или `flashkda`; для MLA-гибридов (KDA-семейство, Kimi-Linear) дополнительно `cutedsl` и `helion`;
- `--mamba-backend` — только `triton` (или не задан).

`handle_unified_memory_pool` проверяет остальное:

- **спекулятивное декодирование** — только `DSPARK` и только линейной цепочкой (`--speculative-eagle-topk` из `{None, 1}`), причем attention-бэкенды обеих ролей должны быть из набора `triton`, `trtllm_mla`, `cutedsl_mla`, `tokenspeed_mla`;
- **PD-дизагрегация** — только `--disaggregation-transfer-backend mooncake`, `--pp-size 1`, без спекулятивного декодирования (с mooncake оно запрещено), с включенной lazy compaction (`SGLANG_DISABLE_LAZY_COMPACTION` не задан) и без `--enable-hisparse`. Decode KV offload (`--disaggregation-decode-enable-offload-kvcache`) допускается только с `--hicache-storage-backend file` и только не для MLA, не для hybrid-Mamba и не для hybrid-SWA моделей — то есть не для тех семей, под которые unified-пул вообще строится. `--disaggregation-decode-retraction-backup host_pool` запрещен для hybrid-Mamba, hybrid-SWA и вместе с decode radix cache;
- `--enable-two-batch-overlap` запрещен;
- `--enable-lmcache` запрещен: LMCache индексирует device-буферы теми идентификаторами, что получает, а они виртуальные. HiCache (`--enable-hierarchical-cache`) для всех форм unified-пула поддержан;
- `--dcp-size > 1` — только MLA-модели, не hybrid-SWA, без PD и с полным вниманием на `flashinfer`, `trtllm_mla`, `cutedsl_mla` или `tokenspeed_mla`;
- prefill CUDA graph разрешен. Исключение — backend `full`: его метаданные есть только у `fa3`/`fa4`, и с другими attention-бэкендами prefill-захват выключается с предупреждением, без отказа старта.

`handle_kv4_compatibility` отвергает FP4 KV-кеш (`--kv-cache-dtype nvfp4` / `fp4_mx_block16`): unified MHA-пул не выделяет FP4 block scales. Отдельные модельные обработчики добавляют свои запреты (например, Qwen4-Exp unified memory не поддерживает).

Одно PD-ограничение проверяется только в рантайме: attention TP prefill- и decode-узла должны совпадать. Иначе при первой передаче mooncake бросает `RuntimeError` «--enable-unified-memory does not support different prefill / decode attention TP sizes…» — сервер к этому моменту уже запущен.

## Значения и формат

- Флаг без аргумента.
- Ручек «сколько отдать под KV, сколько под состояние» нет: в этом и смысл — деление динамическое.
- Общий объем буфера по-прежнему определяется `--mem-fraction-static` и производными от него ограничениями.

## Когда использовать

- Гибридная Mamba/GDN/KDA или SWA-модель, у которой измеренно простаивает один из пулов: например, нагрузка «много коротких запросов» упирается в state-пул при полупустом KV-пуле, или наоборот.
- Не включайте на обычной (не гибридной) модели и на DeepSeek V4 — старт упадет с явным `ValueError`.
- Не включайте вместе с LMCache, TBO, FP4 KV-кешем, PD на неподдержанной топологии и любым спекулятивным декодированием, кроме линейного DSPARK: список исключений длинный и проверяется жестко.
- Учитывайте, что путь экспериментальный: обновление SGLang может изменить набор допустимых комбинаций, а установленная в окружении версия может отставать от checkout'а, по которому написан этот документ.

## Влияние на производительность и память

- Общий объем VRAM не меняется — меняется только то, что граница между KV и состоянием подвижна. Выигрыш проявляется как рост эффективной конкурентности на перекошенной нагрузке.
- Обязательный page-major layout сам по себе меняет раскладку KV и ограничивает выбор ядер внимания и Mamba; на моделях, где разрешенные ядра медленнее штатных, это может съесть выигрыш.
- Если в окружении включен `SGLANG_ENABLE_POST_CAPTURE_KV_SIZING`, с unified-пулом он не действует: резерв под CUDA graph снова закладывается в `--mem-fraction-static` заранее, и KV-пул выходит меньше, чем с post-capture sizing.
- Виртуально-физическая трансляция добавляет небольшой оверхед на доступ к слотам.
- Время старта заметно не меняется.

## Взаимодействие с другими аргументами

- `--enable-page-major-kv-layout`: включается автоматически и не может быть отключен при поднятом unified-пуле.
- `--attention-backend` / `--linear-attn-backend` / `--mamba-backend`: должны входить в разрешенные наборы (см. выше); нарушение — ассерт с перечислением допустимых значений.
- `--speculative-algorithm`: только `DSPARK`, только с `--speculative-eagle-topk` из `{None, 1}` и без PD.
- `--disaggregation-mode` != `null`: требует `--disaggregation-transfer-backend mooncake`, `--pp-size 1`, отсутствия спекуляции и `--enable-hisparse`, одинакового attention TP на обеих сторонах.
- `--disaggregation-decode-retraction-backup`: при незаданном значении unified hybrid-SWA получает `cpu_tensor`; явный `host_pool` для гибридных моделей отвергается.
- `--enable-hierarchical-cache`: поддержан. `--enable-lmcache`: жестко запрещен.
- `--enable-two-batch-overlap`: запрещен.
- `--kv-cache-dtype nvfp4` / `fp4_mx_block16`: запрещены.
- `--dcp-size` > 1: только для MLA-моделей без SWA и без PD, с ограниченным набором attention-бэкендов.
- `--cuda-graph-backend-prefill full`: работает только с `fa3`/`fa4`, иначе prefill-захват отключается.

## Типовые проблемы и диагностика

- `ValueError: --enable-unified-memory only supports hybrid Mamba and hybrid sliding-window-attention models (DeepSeek-V4 excluded)…` — модель не подходит.
- Ассерт «--enable-unified-memory requires uniform K/V rows (head_dim == v_head_dim)…» — у модели асимметричные K/V.
- Ассерт «--enable-page-major-kv-layout: the resolved attention backends [...] are not in the allowed set [...]» — задан неподдерживаемый attention backend; аналогичные ассерты есть для linear-attn decode/prefill и для `--mamba-backend`.
- Ассерт «--enable-unified-memory is not yet compatible with --enable-lmcache…» — уберите LMCache.
- Ассерт «--enable-unified-memory only supports --speculative-algorithm DSPARK (chain draft)…» — снимите спекулятивное декодирование или перейдите на линейный DSPARK.
- Ассерт «--enable-unified-memory does not support --enable-two-batch-overlap…» — снимите TBO.
- `ValueError: FP4 KV cache does not yet support --enable-unified-memory…` — верните FP8/BF16 KV.
- Предупреждение «--enable-unified-memory: disabling the FULL prefill cuda-graph backend…» — prefill-захват выключен из-за несовместимого attention backend; decode-захват не затронут.
- `RuntimeError: --enable-unified-memory does not support different prefill / decode attention TP sizes…` уже после старта — выровняйте attention TP prefill- и decode-узлов.
- Что реально принято, показывает дамп `server_args=` при старте — в нем уже видно принудительно поднятый `enable_page_major_kv_layout`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/qwen3-next-hybrid --enable-unified-memory --attention-backend triton --linear-attn-backend triton --mamba-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/kimi-linear --enable-unified-memory --attention-backend triton --mamba-backend triton --page-size 64 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/unified_memory_pool.py`
- `sglang/python/sglang/srt/disaggregation/mooncake/conn.py`
- upstream PR #39477 «Support unified memory page-envelope transfers in PD» (коммит `5931fd60ee` в checkout) и PR #37507 «[unified-memory] Hierarchical cache for every unified pool shape» (коммит `506698761d`)
