---
schema: 1
engine: sglang
primaryName: "--kt-max-deferred-experts-per-token"
title: "--kt-max-deferred-experts-per-token"
summary: Разрешает откладывать несколько наименее весомых экспертов токена, чтобы GPU не ждал CPU; их вклад прибавляется на следующем слое, поэтому ускорение покупается за счет точности.
group: exec.moe
related:
  - --kt-num-gpu-experts
  - --kt-cpuinfer
  - --kt-weight-path
  - --chunked-prefill-size
---

# --kt-max-deferred-experts-per-token

## Кратко

`--kt-max-deferred-experts-per-token K` включает конвейерный режим CPU-части KTransformers. Из `top_k` экспертов токена немедленно считаются `top_k - K` с наибольшим весом маршрутизации, а оставшиеся `K` отправляются отдельной задачей, результат которой не ждут: он попадает в буфер, который аккумулирует **следующий** MoE-слой. Это снижает время ожидания CPU на каждом слое, но означает, что вклад отложенных экспертов применяется на слой позже. Последний слой всегда работает с `0`, потому что «следующего слоя» для него нет.

## Оригинальная справка

```text
[ktransformers parameter] Maximum number of experts deferred to CPU per token. All MoE layers except the final one use this value; the final layer always uses 0.
```

## Паспорт аргумента

- Флаги: `--kt-max-deferred-experts-per-token`
- Группа: `exec.moe`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: не ограничены на уровне argparse; осмысленный диапазон — от `0` до `top_k` модели, рекомендация kt-kernel — `1`-`4`
- Значение по умолчанию: `null`; в обертке разворачивается в `0` (`layer_max_deferred = self.kt_config.max_deferred_experts_per_token or 0`), то есть конвейер выключен
- Эффективное значение: для последнего слоя модели принудительно `0` — но только если удалось прочитать `num_hidden_layers` из HF-конфига; `create_kt_config_from_server_args` оборачивает `get_hf_config()` в `try/except` и при неудаче оставляет `num_layers = None`, и тогда правило последнего слоя не применяется
- Где объявлен: `ServerArgs.kt_max_deferred_experts_per_token`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, реализация во внешнем пакете `kt_kernel`
- Этап применения: создание CPU-обертки слоя (значение фиксируется на слой) и каждый forward MoE-слоя

## Что меняет в движке

На стороне SGLang значение только вычисляется и передается: `KTEPWrapperMethod.create_weights` считает `layer_max_deferred`, обнуляет его для последнего слоя и отдает в конструктор `KTMoEWrapper`.

Вся механика — в `BaseMoEWrapper.submit_forward` (`ktransformers/kt-kernel/python/experts_base.py`):

1. При `max_deferred_experts_per_token > 0` вычисляется `protected_k = num_experts_per_tok - max_deferred`.
2. `select_deferred_experts` берет `top-protected_k` по весам маршрутизации; эти id остаются в «немедленном» тензоре, остальные заменяются на `-1` и попадают в «отложенный» тензор. Отложенными оказываются наименее весомые эксперты токена.
3. Немедленная задача пишет результат в `output_cpu[current_slot]`, где `current_slot = layer_idx % 2`.
4. Отложенная задача ставится в очередь следом и пишет в `output_cpu[next_slot]` — тот же буфер, который на следующем слое будет `current_slot`.
5. `sync_forward` вызывается с `allow_pending = 1`, если на этом слое есть отложенная задача, то есть возврат происходит, не дожидаясь ее завершения.
6. На следующем слое немедленная задача получает `incremental = True` и в `merge_results` **прибавляет** к своему результату уже лежащее в буфере содержимое (`ktransformers/kt-kernel/operators/amx/moe_base.hpp` и одноименные `merge_results` других backend'ов).

Итог: отложенные эксперты слоя `L` складываются с выходом CPU-части слоя `L+1`. Это не переупорядочивание вычислений, а приближение — математически результат отличается от синхронного счета.

## Значения и формат

- `0` (и незаданное значение) — синхронный режим: GPU дожидается всей CPU-части текущего слоя.
- `1`-`4` — рекомендованный kt-kernel диапазон: заметное снижение latency при приемлемом качестве.
- `5`-`7` — в документации kt-kernel помечены как «максимальное снижение latency, но возможна заметная потеря точности».
- `K >= top_k` даст `protected_k = 0`: `select_deferred_experts` вернет пустой немедленный тензор и отложит **всех** экспертов токена. Формально это работает, но тогда CPU-часть каждого слоя целиком применяется на слой позже.
- Значение одинаково для всех MoE-слоев, кроме последнего.

## Когда использовать

- Когда профиль показывает, что GPU простаивает в `sync_forward`, а CPU-часть — узкое место. Это типично при малом `--kt-num-gpu-experts` и ограниченном числе ядер.
- Когда нужно выжать latency на decode и есть возможность проверить качество на своей задаче (регрессионный прогон, а не «на глаз»).
- Не включайте вслепую на задачах, чувствительных к точности: изменение результата гарантировано по построению.
- Не используйте как замену `--kt-num-gpu-experts`: объем CPU-работы аргумент не уменьшает, он ее только перекладывает во времени.

## Влияние на производительность и память

- **Latency.** Основной эффект: на каждом слое GPU перестает ждать «хвост» CPU-задачи.
- **Пропускная способность CPU.** Суммарный объем вычислений не меняется; при полностью загруженном CPU выигрыш меньше, потому что отложенная задача все равно конкурирует за те же потоки.
- **Память.** Дополнительных аллокаций нет: используются те же два слота буфера (`KExpertsCPUBuffer.buffer_depth = 2`), которые выделяются под каждый размер батча независимо от этого аргумента. Пиновые CPU-буферы и выходные GPU-тензоры кешируются по захваченным размерам батча CUDA graph (`KTMoEWrapper.set_capture_batch_sizes`).
- **Качество.** Единственная реальная цена. Ошибка тем больше, чем больше `K` и чем весомее отложенные эксперты.

## Взаимодействие с другими аргументами

- `--kt-num-gpu-experts`: чем он больше, тем меньше CPU-работы и тем меньше смысла в конвейере.
- `--kt-cpuinfer`: при недостатке потоков отложенная задача не успевает завершиться к следующему слою и выигрыш съедается.
- `--kt-weight-path`: без него аргумент не читается.
- `--chunked-prefill-size`: задает `max_len` буферов CPU-части (`moe_config.max_len = chunked_prefill_size`), то есть размер порции, на которой измеряется эффект в prefill.
- Со спекулятивным декодированием и CUDA graph аргумент напрямую не связан, но набор захваченных размеров батча определяет, для каких batch size буферы будут преаллоцированы.

## Типовые проблемы и диагностика

- Качество просело после включения — уменьшайте `K` до `1`-`2` или возвращайте `0`. Это ожидаемое поведение, а не баг.
- Выигрыша по latency нет — CPU уже насыщен, либо `--kt-num-gpu-experts` настолько велик, что CPU-часть и так короткая.
- Нестабильный результат между запусками при одинаковых параметрах сэмплирования: конвейер меняет только состав задач, а не порядок аккумулирования внутри слоя; расхождения ищите в других местах (сэмплирование, батчинг), но помните, что отложенный вклад завязан на границы слоев.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`); отдельной строки лога про конвейер kt-kernel не печатает.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-INT8 --kt-method AMXINT8 --kt-cpuinfer 64 --kt-threadpool-count 2 --kt-num-gpu-experts 32 --kt-max-deferred-experts-per-token 2
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-Q4_K_M --kt-method LLAMAFILE --kt-cpuinfer 8 --kt-threadpool-count 1 --kt-num-gpu-experts 32 --kt-max-deferred-experts-per-token 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `ktransformers/kt-kernel/python/experts_base.py`
- `ktransformers/kt-kernel/operators/amx/moe_base.hpp`
- `ktransformers/kt-kernel/operators/moe-tp.hpp`
- `ktransformers/kt-kernel/README.md`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
