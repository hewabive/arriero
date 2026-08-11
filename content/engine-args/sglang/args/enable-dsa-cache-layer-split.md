---
schema: 1
engine: sglang
primaryName: "--enable-dsa-cache-layer-split"
title: "--enable-dsa-cache-layer-split"
summary: Раскладывает слои GPU-кеша DSA (KV и индексатора) по CP-рангам, чтобы каждый ранг держал только свои. Единственный способ получить от context parallelism реальную экономию VRAM — и только на prefill-воркере PD с mooncake.
group: parallel
related:
  - --enable-prefill-cp
  - --cp-strategy
  - --attn-cp-size
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --pp-size
  - --mem-fraction-static
---

# --enable-dsa-cache-layer-split

## Кратко

Обычный prefill-CP не экономит память: после расчета внимания K/V собираются all-gather'ом и целиком пишутся в пул **каждого** ранга. `--enable-dsa-cache-layer-split` меняет это для моделей с DeepSeek Sparse Attention: пул кеша делится **по слоям**, каждый CP-ранг материализует только свои, а чужой слой при необходимости подтягивается broadcast'ом владельца в маленький локальный скретч-буфер. Условия применимости узкие и перечислены явно: DSA-модель, prefill-воркер PD-disaggregation, `--cp-strategy interleave`, transfer-backend mooncake, `--pp-size 1`.

## Оригинальная справка

```text
Split DSA (DeepSeek Sparse Attention) GPU KV/indexer cache layers across context-parallel ranks to reduce per-rank KV memory. Currently only supported with the mooncake transfer backend (mooncake / mooncake_tcp); mori/nixl support will be added later by the community.
```

## Паспорт аргумента

- Флаги: `--enable-dsa-cache-layer-split`
- Группа: `parallel`
- Тип значения: bool (`store_true`)
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным; автоматически не включается никогда. Значение уходит и в протокол PD-передачи — оно сериализуется в handshake (`enable_dsa_cache_layer_split` в `disaggregation/common/conn.py`), чтобы decode-сторона знала о раскладке
- Где объявлен: `ServerArgs.enable_dsa_cache_layer_split`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, с частичной поддержкой транспортов (mori/nixl обещаны позже)
- Этап применения: валидация в `_handle_model_specific_adjustments` → выбор класса пула в `KVCacheConfigurator` → чтение/запись слоев на forward → handshake PD-передачи

## Что меняет в движке

`LayerSplitDSATokenToKVPool` (`sglang/python/sglang/srt/mem_cache/dsa_cache_layer_split.py`) — подкласс обычного `DSATokenToKVPool`, в который вынесена вся логика шардирования; базовые пулы `KVCache`/`MLATokenToKVPool`/`DSATokenToKVPool` не трогаются. Каждый ранг:

- выделяет буферы только для тех слоев, которыми владеет (`_is_layer_owned`, диапазон из `get_layer_shard_range`); для чужих слоев размер буфера равен нулю;
- при обращении к чужому слою получает его broadcast'ом от владельца в отдельный `remote_buffer` — по одному слою за раз, а не целиком;
- то же самое делает для кеша индексатора DSA (`LayerSplitIndexKeyCache`).

Пять проверок в `_handle_model_specific_adjustments` очерчивают область применимости; каждая дает свой отказ на старте:

- модель обязана быть DSA (`is_deepseek_dsa`), иначе `--enable-dsa-cache-layer-split is only supported for DSA (DeepSeek Sparse Attention) models.`;
- `--disaggregation-mode prefill` обязателен: на decode-воркере запрещено явно («decode receives full cache shards through PD transfer»), а на не-PD-воркере — потому что он же выполняет обычный локальный decode;
- нужны `--enable-prefill-cp` и `--cp-strategy interleave`;
- `--disaggregation-transfer-backend` — только `mooncake` / `mooncake_tcp`;
- `--pp-size 1`: «CP + PP has not been validated for this feature».

## Значения и формат

- Булев флаг без значения; «выключено» = не указывать.
- Отключающего флага нет.
- Эффект зависит от `attn_cp_size`: именно на столько частей делятся слои. При `attn_cp_size == 1` делить нечего.
- Разбиение по слоям, а не по токенам или головам: гранулярность крупная, и распределение зависит от числа слоев модели.

## Когда использовать

- Дезагрегированная установка (`--disaggregation-mode prefill`) на DSA-модели, где prefill-воркеру не хватает VRAM под кеш при нужной длине контекста. Это ровно тот случай, ради которого функция сделана.
- Нужно поднять `--context-length` или `--mem-fraction-static` на prefill-воркере, а свободной памяти нет.
- Не включать на обычном (не-PD) сервере: отказ на старте, и по сути правильный — такой воркер сам делает decode, которому нужен полный локальный кеш.
- Не включать с nixl/mori-транспортом: поддержки пока нет, это заявлено в самой справке.
- Не рассчитывать на ускорение: механизм торгует коммуникацию на память.

## Влияние на производительность и память

- VRAM: главный и единственный положительный эффект. Per-rank GPU-кеш DSA (и KV, и индексатор) уменьшается примерно в `attn_cp_size` раз, освобождая бюджет под больший KV-пул или больший контекст.
- Latency: растет. Каждое обращение к чужому слою — это broadcast по CP-группе плюс копирование в скретч-буфер; на prefill-воркере это укладывается в общую стоимость длинного промпта, но бесплатным не бывает.
- Дополнительная память: скретч-буфер под один удаленный слой на каждый пул; величина мала относительно освобождаемого объема.
- PD-передача: decode-сторона получает полные шарды через транспорт mooncake; путь передачи ветвится по флагу в handshake.

## Взаимодействие с другими аргументами

- `--enable-prefill-cp` + `--cp-strategy interleave`: обязательная связка. `zigzag` не поддерживается.
- `--attn-cp-size`: определяет число шардов слоев.
- `--disaggregation-mode`: только `prefill`.
- `--disaggregation-transfer-backend`: только `mooncake` / `mooncake_tcp`.
- `--pp-size`: должен быть `1`.
- `--mem-fraction-static`: освободившуюся память имеет смысл вернуть в KV-пул, подняв долю.

## Типовые проблемы и диагностика

- `ValueError: --enable-dsa-cache-layer-split is only supported for DSA (DeepSeek Sparse Attention) models.`
- `ValueError: --enable-dsa-cache-layer-split is not supported on decode workers. This flag is a prefill-CP optimization; decode receives full cache shards through PD transfer.`
- `ValueError: --enable-dsa-cache-layer-split is only supported on PD prefill workers. Non-PD workers also run decode and require ordinary local decode cache semantics.`
- `ValueError: --enable-dsa-cache-layer-split requires --enable-prefill-cp and --cp-strategy interleave (or legacy --enable-nsa-prefill-context-parallel with --nsa-prefill-cp-mode round-robin-split).`
- `ValueError: --enable-dsa-cache-layer-split currently only supports the mooncake transfer backend (mooncake / mooncake_tcp). Got --disaggregation-transfer-backend '…'. mori/nixl support will be added later by the community.`
- `ValueError: --enable-dsa-cache-layer-split is not supported with pipeline parallelism (pp_size > 1) yet. …`
- Память не освободилась — проверьте `attn_cp_size` в дампе `server_args=`: при значении 1 делить нечего. Величину освобождения видно по строке `KV Cache is allocated. …` и по `max_total_num_tokens=…` до и после.
- Что смотреть в логе: `enable_dsa_cache_layer_split=` в дампе `server_args=` и сводку размеров пула при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tensor-parallel-size 8 --dp-size 1 --disaggregation-mode prefill --disaggregation-transfer-backend mooncake --enable-prefill-cp --cp-strategy interleave --enable-dsa-cache-layer-split
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tensor-parallel-size 8 --dp-size 1 --disaggregation-mode prefill --disaggregation-transfer-backend mooncake --enable-prefill-cp --cp-strategy interleave --enable-dsa-cache-layer-split --mem-fraction-static 0.9
```

## Источники

- `sglang/python/sglang/srt/mem_cache/dsa_cache_layer_split.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/cp/utils.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/disaggregation/common/conn.py`
- `sglang/python/sglang/srt/disaggregation/mooncake/conn.py`
