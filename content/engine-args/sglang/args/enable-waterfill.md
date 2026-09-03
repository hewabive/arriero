---
schema: 1
engine: sglang
primaryName: "--enable-waterfill"
title: "--enable-waterfill"
summary: Превращает слитый shared expert в дополнительный маршрутизируемый слот и отправляет его на наименее загруженный EP-ранг, выравнивая нагрузку без перестановки весов. Принудительно включает shared-experts fusion и подтягивает a2a-бэкенд к `deepep`, если стоит что-то другое.
group: exec.moe
related:
  - --moe-a2a-backend
  - --deepep-mode
  - --disable-shared-experts-fusion
  - --enforce-shared-experts-fusion
  - --ep-num-redundant-experts
  - --enable-eplb
  - --ep-size
  - --init-expert-location
---

# --enable-waterfill

## Кратко

В моделях типа DeepSeek-V3 у каждого токена помимо восьми выбранных экспертов есть shared expert, который считается всегда. При shared-experts fusion он вшивается в тот же MoE-kernel, но остается «своим» для каждого ранга. Waterfill идет дальше: он расширяет topk с 8 до 9, где девятый слот — это shared expert, отправленный на тот ранг, который в этом батче загружен меньше всех. Выравнивание получается на каждом проходе и без переноса весов, в отличие от EPLB.

## Оригинальная справка

```text
Enable Waterfill: dispatch the fused shared expert as an extra routed expert slot to the least-loaded EP rank. Supports DeepEP and MegaMOE MoE A2A backends, implicitly enables shared-expert fusion, and supports --deepep-mode auto, normal, or low_latency when used with DeepEP. Use auto or low_latency for production DeepEP decode so CUDA graph remains enabled. Supported on DeepSeek-V3/R1 with EP >= 2.
```

## Паспорт аргумента

- Флаги: `--enable-waterfill`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-*` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но сам переопределяет три вещи в `__post_init__` — `--moe-a2a-backend` подтягивается к `deepep`, если это не `deepep`/`megamoe`; `--disable-shared-experts-fusion` принудительно сбрасывается в `false`; `--enforce-shared-experts-fusion` принудительно ставится в `true`
- Где объявлен: `ServerArgs.enable_waterfill`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но подсистема экспериментальная — в апстрим-документации помечена как Experimental
- Этап применения: `__post_init__` (`_a2a_backend_overrides`, `_a2a_fusion_adjustments`, `_handle_a2a_moe`) → построение TopK-модулей → `prepare_moe_topk` после загрузки весов → каждый forward-проход

## Что меняет в движке

**На разборе конфигурации.** `_a2a_backend_overrides` пишет `moe_a2a_backend is overridden to 'deepep' because Waterfill requires the DeepEP or MegaMOE backend.` Затем `_a2a_fusion_adjustments` при заданном `--disable-shared-experts-fusion` печатает `disable_shared_experts_fusion is overridden to False because Waterfill requires shared expert fusion.` и сбрасывает его. Наконец, `_handle_a2a_moe` выставляет `enforce_shared_experts_fusion = True` и логирует `Waterfill is enabled with moe_a2a_backend='...'.`

**При построении модели.** В `TopK` и `HashTopK` (`sglang/python/sglang/srt/layers/moe/topk.py`, `hash_topk.py`) поле `enable_waterfill` вычисляется как `num_fused_shared_experts > 0 and <флаг>`. То есть если модель по своим причинам не слила shared expert (архитектура вне списка, неподходящая квантизация, включенный TBO/SBO), Waterfill останется выключенным — молча, без ошибки. Проверять надо по факту.

**После загрузки весов.** `prepare_moe_topk` (`model_runner_components/moe_ep_setup.py`) создает по одному `WaterfillBalancer` на каждый подходящий TopK-модуль, читая `n_routed_experts` из конфига модели (иначе `ValueError: Waterfill requires model config n_routed_experts.`) и прибавляя к нему `--ep-num-redundant-experts`. В лог уходит `Prepared N Waterfill TopK modules.`

**На forward.** `WaterfillBalancer.expand_topk` расширяет `topk_ids`/`topk_weights` на один слот. Вес девятого слота — `1 / routed_scaling_factor`, чтобы после общего домножения на этот коэффициент вклад shared expert остался единичным. Выбор ранга:

- по умолчанию работает статический режим: локальные счетчики маршрутизации считаются Triton-ядром, коммуникации нет;
- переменная `SGLANG_DISABLE_STATIC_WATERFILL=1` переводит в динамический режим, где на каждом слое выполняется дополнительный EP-`all_reduce` счетчиков — точнее, но дороже;
- при батче меньше 64 токенов (`MIN_BATCH_FOR_BALANCE`) балансировка пропускается, и shared expert раскладывается локально: на малом батче выравнивать нечего.

## Значения и формат

- Флаг без значения. Отсутствие — shared expert считается на своем ранге, как обычно.
- Значение имеет смысл только при `--ep-size` больше единицы и на модели, где shared-experts fusion реально произошел. Ассертов на это в коде нет: справка описывает границу поддержки (DeepSeek-V3/R1, EP >= 2), а не проверку.
- Совместимые a2a-бэкенды — `deepep` и `megamoe`; любое другое значение будет заменено на `deepep`.

## Когда использовать

- Крупная EP-развертка DeepSeek-V3/R1, где виден перекос между рангами, но EPLB со своими паузами на перенос весов не подходит.
- Вместе со статической раскладкой `--init-expert-location`: апстрим-рецепт для DeepSeek-V4 применяет их в паре.
- В связке с DeepEP на decode — держите `--deepep-mode auto` или `low_latency`: `normal` отключает CUDA graph, и выигрыш от выравнивания съедается ростом latency.
- Не включайте на батчах меньше 64 токенов как основном режиме: балансировка там не выполняется.
- Не включайте вместе с `--disable-shared-experts-fusion`: конфликт будет разрешен не в вашу пользу, молча.

## Влияние на производительность и память

- **VRAM.** Расширение topk с 8 до 9 увеличивает на 12.5% объем данных, проходящих через a2a-диспетчер, и соответствующие временные буферы. Постоянных весов не добавляется.
- **Latency, статический режим.** Одно Triton-ядро подсчета на слой плюс слитое ядро расширения; коммуникации нет.
- **Latency, динамический режим.** Дополнительный `all_reduce` по EP-группе на каждом MoE-слое — заметная цена, включайте только если статический режим не выравнивает.
- **Throughput.** Выигрыш ровно в том, что shared expert перестает быть постоянной добавкой к нагрузке своего ранга и уходит туда, где есть запас.
- **CUDA graph.** Сам Waterfill графы не отключает; отключает их комбинация `deepep` + `--deepep-mode normal`.

## Взаимодействие с другими аргументами

- `--moe-a2a-backend`: `deepep` или `megamoe`; иначе перезапишется на `deepep`.
- `--deepep-mode`: поддерживаются все три значения, но для decode в проде осмысленны `auto` и `low_latency`.
- `--disable-shared-experts-fusion`: принудительно сбрасывается.
- `--enforce-shared-experts-fusion`: принудительно включается — на DeepSeek-V4, где fusion иначе не происходит, это как раз то, что делает Waterfill применимым.
- `--ep-num-redundant-experts`: учитывается при вычислении числа физических экспертов на ранг для пересчета идентификатора shared-слота.
- `--enable-eplb`: совместимы; статический EPLB переводит `topk_ids` в физические идентификаторы до Waterfill.
- `--ep-size`: при 1 механизм бессмыслен.

## Типовые проблемы и диагностика

- В логе нет `Prepared N Waterfill TopK modules.` — Waterfill не активировался: shared-experts fusion не произошел. Ищите строку `... Shared experts fusion optimization is disabled.` с конкретной причиной.
- `ValueError: Waterfill requires model config n_routed_experts.` — модель не публикует это поле; Waterfill к ней неприменим.
- `RuntimeError: Waterfill TopK must be prepared by ModelRunner before forward.` — TopK-модуль дошел до forward без балансировщика; признак нештатного пути инициализации.
- Предупреждение `moe_a2a_backend is overridden to 'deepep' ...` — вы задали несовместимый a2a-бэкенд.
- Предупреждение `disable_shared_experts_fusion is overridden to False ...` — вы задали взаимоисключающие флаги.
- Latency выросла после включения — проверьте `--deepep-mode`: `normal` отключает CUDA graph (`Cuda graph is disabled because deepep_mode=...`).
- Выравнивания не видно — сравните `[Expert Balancedness]` до и после (нужен `--expert-balancedness-report-mode server_log` или `both`) и попробуйте динамический режим через `SGLANG_DISABLE_STATIC_WATERFILL=1`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode auto --enable-waterfill
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend megamoe --enable-waterfill --init-expert-location /tmp/expert_distribution_recorder_1754900000.0.pt
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/moe/waterfill.py`
- `sglang/python/sglang/srt/layers/moe/topk.py`
- `sglang/python/sglang/srt/layers/moe/hash_topk.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/moe_ep_setup.py`
- `sglang/python/sglang/kernels/ops/moe/deepep_waterfill_kernels.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/cookbook/autoregressive/DeepSeek/DeepSeek-V4.mdx`
