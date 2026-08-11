---
schema: 1
engine: sglang
primaryName: "--enable-hisparse"
title: "--enable-hisparse"
summary: Держит на GPU только небольшой «горячий» буфер KV, а полную последовательность — в закрепленной памяти хоста, подкачивая top-k на каждом шаге decode. Только для DSA-моделей и DeepSeek V4, только на decode-узле PD и только с `--disable-radix-cache`.
group: memory
related:
  - --hisparse-config
  - --disable-radix-cache
  - --disaggregation-mode
  - --disaggregation-decode-enable-radix-cache
  - --enable-hierarchical-cache
  - --enable-unified-memory
  - --prefill-only-disable-kv-cache
  - --dcp-size
  - --kv-cache-dtype
---

# --enable-hisparse

## Кратко

`--enable-hisparse` включает hierarchical sparse attention: каждый запрос занимает на GPU фиксированный буфер (порядка тысяч токенов) вместо полной длины последовательности, а весь KV лежит в pinned-памяти хоста; на каждом шаге decode CUDA-ядро подкачивает в буфер top-k релевантных позиций. Смысл — резко поднять конкурентность decode на длинном контексте. Область применимости узкая и жестко проверяется на старте: модели с DeepSeek Sparse Attention (DeepSeek V3.2, GLM-5.1) и DeepSeek V4, режим PD-дизагрегации, decode-роль, обязательный `--disable-radix-cache`.

## Оригинальная справка

```text
Enable hierarchical sparse attention
```

## Паспорт аргумента

- Флаги: `--enable-hisparse`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; несовместимые комбинации приводят к ассерту или `ValueError` на старте
- Где объявлен: `ServerArgs.enable_hisparse`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг узкого назначения; путь свежий и активно меняется, часть ограничений в коде помечена как временная
- Этап применения: валидация в `__post_init__` (`validate_hisparse`) → выбор классов KV-пула и аллокатора → создание `HiSparseCoordinator` в `ModelRunner.initialize()` до захвата CUDA graph → каждый шаг decode

## Что меняет в движке

Флаг переключает целое семейство объектов:

- **Пул и аллокатор.** Вместо `DSATokenToKVPool` создается `HiSparseDSATokenToKVPool`, вместо обычного аллокатора — `HiSparseTokenToKVPoolAllocator`, оба получают `host_to_device_ratio` из `--hisparse-config` (`mem_cache/kv_cache_configurator.py`). Для DeepSeek V4 сверху навешивается `DeepSeekV4HiSparseTokenToKVPoolAllocator`, и там же проверяется `assert self.is_hybrid_swa, "DeepSeek V4 HiSparse requires SWA mode."`.
- **Координатор.** `ModelRunner.maybe_init_hisparse_coordinator` создает `HiSparseCoordinator` с `top_k` (берется из `hf_text_config.index_topk`, если он есть у модели, иначе из конфига) и `device_buffer_size`. Планировщик подключает его в `init_hisparse_coordinator` и подает ему свой forward-stream.
- **Цикл планировщика.** При включенном HiSparse переход prefill→decode свой: вместо слияния с `last_batch` собирается отдельный батч из «готовых» запросов (`collect_ready_reqs` → `_build_hisparse_decode_batch`), а `batch_is_full` сбрасывается, чтобы планировщик мог принимать новые prefill'ы.
- **Учет емкости.** `Scheduler.max_token_pool_size` возвращает `size_full` аллокатора, то есть host-backed емкость, а не размер device-пула.

Проверки на старте выполняет `validate_hisparse` (`sglang/python/sglang/srt/arg_groups/hisparse_hook.py`):

- модель обязана быть DSA или DeepSeek V4 — иначе ассерт «--enable-hisparse is only supported for DSA (DeepSeek Sparse Attention) models (e.g., DeepSeek V3.2, GLM-5) and DeepSeek V4 now.»;
- обязателен `--disable-radix-cache` — «Hierarchical sparse attention currently requires --disable-radix-cache.».

В PD-режиме prefill-узел передает KV прямо в host-пул decode-узла по RDMA, минуя GPU получателя; для DeepSeek V4 так передается только C4-часть, c4_indexer и C128 остаются device-to-device.

Дополнительно на eligible-моделях автоматически включается shared-index prefetch (переиспользование плана подкачки якорного слоя следующими «skip»-слоями); отключается переменной `SGLANG_DISABLE_HISPARSE_PREFETCH=1`, доступен без pipeline parallelism и без спекулятивного декодирования.

## Значения и формат

- Флаг без аргумента. Все числовые параметры задаются в `--hisparse-config`.
- Prefill-узел про HiSparse ничего не знает и флага не требует — это исключительно decode-side оптимизация.
- Флаг не заменяет `--enable-hierarchical-cache`: это разные механизмы, и общей конфигурации у них нет.

## Когда использовать

- Decode-узел PD-развертывания на DSA-модели с очень длинным контекстом, где конкурентность упирается в KV на GPU: HiSparse превращает «полная длина на запрос» в «фиксированный буфер на запрос».
- Есть заведомый запас RAM хоста: host-пул сайзится множителем `host_to_device_ratio`, и апстрим для ориентира дает ~1 ТБ → 5, ~2 ТБ → 10.
- Не включайте на обычном (не-PD) инстансе и на модели без DSA — старт откажет.
- Не включайте, если нужен prefix caching: HiSparse требует его отключения, то есть переиспользование префиксов теряется полностью.

## Влияние на производительность и память

- VRAM на запрос падает радикально: вместо полного KV — буфер `device_buffer_size` токенов; за счет этого растет число одновременных decode-запросов.
- RAM хоста растет соответственно: полный KV всех активных запросов лежит в pinned-памяти, объем задается `host_to_device_ratio`.
- На каждом шаге decode добавляется подкачка top-k хост→устройство; на длинных последовательностях это основной источник накладных расходов, частично скрываемый shared-index prefetch'ем.
- Время старта: добавляется аллокация большого pinned-буфера и создание координатора до захвата CUDA graph.
- Пропускная способность prefill не меняется: prefill выполняется на другом узле.

## Взаимодействие с другими аргументами

- `--hisparse-config`: единственный способ задать `top_k`, `device_buffer_size`, `host_to_device_ratio`, `swap_in_block_size`.
- `--disable-radix-cache`: обязателен.
- `--disaggregation-mode decode`: штатный режим по апстрим-документации; на decode-узле дополнительно нельзя `--disaggregation-decode-enable-radix-cache` — комбинация отвергается `ValueError`.
- `--enable-hierarchical-cache` + `--dcp-size > 1`: `NotImplementedError` «--enable-hisparse with --dcp-size > 1 is not supported: the HiSparse host pool is constructed without DCP translation.».
- `--enable-unified-memory` в PD-режиме: ассерт о несовместимости — decode-side HiSparse отдает host/C4-строки прямо из аллокатора, минуя виртуально-физическую трансляцию unified-пула.
- `--prefill-only-disable-kv-cache`: несовместим — HiSparse использует собственное семейство пулов, а не no-op MHA-пул.
- `--kv-cache-dtype`: для DSA-моделей `auto` разрешается в `fp8_e4m3` на SM100+ и `bfloat16` на более старых, и от этого зависит выбор DSA decode-бэкенда (`flashmla_sparse` против `flashmla_kv`). DeepSeek V4 использует собственный бэкенд `dsv4`.

## Типовые проблемы и диагностика

- Ассерт «--enable-hisparse is only supported for DSA … models … and DeepSeek V4 now.» — модель не подходит.
- Ассерт «Hierarchical sparse attention currently requires --disable-radix-cache.» — не добавлен обязательный флаг.
- Ассерт «DeepSeek V4 HiSparse requires SWA mode.» — конфигурация пулов не в гибридном SWA-режиме.
- `ValueError: --disaggregation-decode-enable-radix-cache is incompatible with --enable-hisparse` — конфликт на decode-узле.
- `ValueError` про unified-KV путь на ROCm (`SGLANG_HACK_FLASHMLA_BACKEND=unified_kv_triton`) — временный guard для DeepSeek V4; переключите переменную на `triton` либо снимите HiSparse.
- Что принято движком, видно в дампе `server_args=` при старте; фактическую емкость host-пула проще всего сверять по объему pinned-памяти процесса.
- Для A/B-проверки shared-index prefetch есть переменная `SGLANG_DISABLE_HISPARSE_PREFETCH=1`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --trust-remote-code --context-length 81920 --tp-size 8 --dp-size 8 --enable-dp-attention --mem-fraction-static 0.85 --disable-radix-cache --disaggregation-mode decode --enable-hisparse --hisparse-config '{"top_k": 2048, "device_buffer_size": 6144, "host_to_device_ratio": 10, "swap_in_block_size": 960}'
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --trust-remote-code --tp-size 8 --disable-radix-cache --disaggregation-mode decode --enable-hisparse
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/hisparse_hook.py`
- `sglang/python/sglang/srt/mem_cache/sparsity/factory.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/hisparse_guide.mdx`
