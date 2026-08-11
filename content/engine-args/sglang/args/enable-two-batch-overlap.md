---
schema: 1
engine: sglang
primaryName: "--enable-two-batch-overlap"
title: "--enable-two-batch-overlap"
summary: Разбивает каждый батч на два микробатча, чтобы коммуникация одного перекрывалась вычислением другого. Инструмент крупных EP-развертываний: без MoE all-to-all backend'а требует `--enable-dp-attention` и несовместим с целым рядом подсистем.
group: exec.overlap
related:
  - --enable-single-batch-overlap
  - --tbo-token-distribution-threshold
  - --enable-dp-attention
  - --moe-a2a-backend
  - --deepep-mode
  - --enable-breakable-cuda-graph
  - --dwdp-size
  - --enable-eplb
  - --expert-distribution-recorder-mode
  - --enable-pdmux
  - --attn-cp-size
---

# --enable-two-batch-overlap

## Кратко

Two-batch overlap (TBO) решает одну задачу: на больших развертываниях с экспертным параллелизмом MoE-слой тратит заметную часть времени шага на all-to-all-обмен, во время которого вычислительные блоки простаивают. Флаг делит батч на два микробатча и переставляет операции так, чтобы обмен одного перекрывался вычислением другого. В апстрим-документации по экспертному параллелизму указано, что это дает до двукратного роста пропускной способности на большом EP.

Это не универсальная оптимизация. На одиночной карте без экспертного параллелизма перекрывать нечего, а список несовместимостей длинный: TBO выключает захват breakable CUDA graph, ломает adaptive-спекуляцию, запрещен под DWDP, не поддерживается сборщиком детальной статистики экспертов и требует `--enable-dp-attention`, если MoE all-to-all backend не задан.

## Оригинальная справка

```text
Enabling two micro batches to overlap.
```

## Паспорт аргумента

- Флаги: `--enable-two-batch-overlap`
- Группа: `exec.overlap`
- Тип значения: bool (флаг без значения)
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; сам движок его не включает
- Где объявлен: `ServerArgs.enable_two_batch_overlap`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_check_two_batch_overlap`, модельные проверки DSA) → инициализация MoE-конфигурации (`initialize_moe_config`) → создание attention backend'а (`TboAttnBackend`) → подготовка каждого батча (разбиение) → захват CUDA graph

## Что меняет в движке

### Разбиение батча

`TboDPAttentionPreparer` (`sglang/python/sglang/srt/batch_overlap/two_batch_overlap.py`) на каждом батче считает индекс разреза `compute_split_seq_index`:

- в режиме extend/mixed — по длинам последовательностей, через `_split_extend_seqs`;
- в decode и target-verify — просто пополам по числу последовательностей;
- в idle/prebuilt — ноль.

Дальше индекс агрегируется по DP-рангам: TBO выполняется, только если **все** ранги могут его выполнить и совпадают по forward mode (`can_run_tbo`). Иначе шаг идет обычным путем. Отдельно TBO не применяется на extend-фазе, если включен a2a MoE-backend в low-latency режиме DeepEP.

### Backend внимания и CUDA graph

При включенном TBO (и не для draft-воркера) attention backend оборачивается в `TboAttnBackend` (`attention_backend_setup.py`), а `decode_attn_backend_group` не создается. Выравнивание размеров захватываемых графов меняется: `get_cuda_graph_batch_size_alignment` домножается на 2, а ширина выравнивания на запрос становится 1, потому что TBO режет строки одного запроса между микробатчами. Захват breakable CUDA graph при TBO отключается — «two-batch overlap» стоит в списке причин.

### Проверки на старте

- Без EP a2a backend'а (`--moe-a2a-backend none`) требуется `--enable-dp-attention`: `ValueError: When enabling two batch overlap without an EP a2a backend (moe_a2a_backend='none'), --enable-dp-attention is required (DeepSeek-V4 non-EP DP TBO path).`
- DSA-модели с разделяемым index-topk (`index_topk_freq > 1` или паттерн с `S`): `ValueError: --enable-two-batch-overlap is not supported with DSA index-topk sharing …` — TBO-путь не пробрасывает topk-индексы между слоями.
- DWDP: `assert not self.enable_two_batch_overlap, "DWDP's prefetch event protocol does not support two-batch overlap"`.
- Adaptive-спекуляция отказывается работать: `enable_two_batch_overlap=True is not supported (adaptive state swap would discard the TboAttnBackend wrapper)`.
- Детальный сборщик распределения экспертов: `assert not server_args.enable_two_batch_overlap, "DetailSinglePassGatherer does not support TBO yet"`.

## Значения и формат

- Флаг без значения; парной формы нет.
- Не задан — обычный однобатчевый путь.
- Флаг заявляет намерение, но фактическое применение решается на каждом батче: `can_run_tbo` может оказаться ложным (несогласованный forward mode между DP-рангами, вырожденный батч, low-latency DeepEP на extend).
- На XPU не поддерживается (`Two-batch overlap (--enable-two-batch-overlap) | Not yet supported` в документации по платформе).

## Когда использовать

- На многокарточных развертываниях MoE с экспертным параллелизмом и DeepEP — сценарий, ради которого флаг написан; типовые запуски есть в конфигурациях DeepSeek-V4 в апстрим-документации.
- На не-EP пути DeepSeek-V4 с DP-вниманием — тогда перекрывается `all_gatherv`/`reduce_scatterv` DP-слоя.
- Не включать на однокарточном хосте: коммуникации, которую можно перекрыть, там нет, а издержки на разбиение батча и на потерю breakable-графа остаются.
- Не включать вместе с adaptive-спекуляцией, DWDP или детальным сборщиком статистики экспертов — старт откажет или подсистема отключится.
- Не рассчитывать на эффект при малом батче: разбиение пополам делает каждый микробатч вдвое меньше, а мелкие GEMM'ы хуже загружают карту.

## Влияние на производительность и память

- VRAM: два микробатча означают два набора промежуточных буферов внимания и MoE; при равном общем числе токенов пик по активациям заметно не растет, но набор захваченных CUDA graph'ов меняется (выравнивание удваивается, ширина на запрос равна 1).
- RAM хоста: не влияет.
- Время старта: захват графов дольше — TBO-обертка инициализирует backend дважды.
- Throughput: цель флага; на большом EP апстрим заявляет до 2×.
- Latency: на маленьком батче ухудшается — половинные микробатчи дают менее эффективные ядра при том же объеме коммуникации.

## Взаимодействие с другими аргументами

- `--tbo-token-distribution-threshold`: определяет, разрезать ли батч по границе последовательностей или разрубить одну последовательность на два микробатча.
- `--enable-single-batch-overlap`: независимый механизм (перекрытие внутри одного микробатча); флаги совместимы и обычно применяются вместе на больших EP.
- `--enable-dp-attention`: обязателен при `--moe-a2a-backend none`.
- `--moe-a2a-backend` / `--deepep-mode`: определяют, какая коммуникация перекрывается; low-latency DeepEP отключает TBO на extend-фазе.
- `--enable-breakable-cuda-graph`: захват отключается при TBO.
- `--dwdp-size`: несовместим.
- `--enable-eplb` / `--expert-distribution-recorder-mode`: детальный сборщик статистики не поддерживает TBO.
- `--attn-cp-size`: входит в ту же формулу выравнивания размеров CUDA graph.

## Типовые проблемы и диагностика

- `ValueError: When enabling two batch overlap without an EP a2a backend (moe_a2a_backend='none'), --enable-dp-attention is required …`
- `ValueError: --enable-two-batch-overlap is not supported with DSA index-topk sharing (index_topk_freq > 1 or an index_topk_pattern containing shared layers) …`
- `AssertionError: DWDP's prefetch event protocol does not support two-batch overlap`
- `AssertionError: DetailSinglePassGatherer does not support TBO yet`
- Флаг включен, а прироста нет — TBO мог не применяться ни на одном батче: проверьте, что forward mode согласован между DP-рангами и что нагрузка достаточно велика для разбиения.
- Что смотреть: `enable_two_batch_overlap=true` в дампе `server_args=`, отсутствие breakable-графа в логе захвата и распределение токенов между микробатчами при подборе `--tbo-token-distribution-threshold`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --enable-two-batch-overlap --moe-a2a-backend deepep
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --enable-two-batch-overlap --enable-dp-attention --dp-size 8 --tbo-token-distribution-threshold 0.4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/batch_overlap/two_batch_overlap.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/attention_backend_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/speculative/adaptive_spec_params.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
