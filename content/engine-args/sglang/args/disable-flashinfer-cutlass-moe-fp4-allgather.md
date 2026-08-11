---
schema: 1
engine: sglang
primaryName: "--disable-flashinfer-cutlass-moe-fp4-allgather"
title: "--disable-flashinfer-cutlass-moe-fp4-allgather"
summary: Отключает оптимизацию, при которой скрытые состояния квантуются в FP4 до all-gather между DP-рангами. Работает только в одной узкой связке — FlashInfer Cutlass MoE + DP-attention + `modelopt_fp4` без a2a-бэкенда; вне ее флаг ни на что не влияет.
group: exec.moe
related:
  - --moe-runner-backend
  - --moe-a2a-backend
  - --enable-dp-attention
  - --quantization
  - --ep-size
  - --dp-size
---

# --disable-flashinfer-cutlass-moe-fp4-allgather

## Кратко

При DP-attention без a2a-бэкенда каждому MoE-слою нужно собрать токены всех DP-рангов, посчитать экспертов и разложить результат обратно. Оптимизация, которую выключает этот флаг, переносит квантизацию в FP4 **до** этого all-gather: по сети едут четырехбитные значения вместо bf16, а раскладка обратно делается `reduce_scatterv` вместо all-reduce с последующим scatter. Флаг — аварийный выключатель для случая, когда оптимизация ломается или ее хочется исключить при сравнении.

## Оригинальная справка

```text
Disables quantize before all-gather for flashinfer cutlass moe.
```

## Паспорт аргумента

- Флаги: `--disable-flashinfer-cutlass-moe-fp4-allgather`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-*` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; значение публикуется как `moe.disable_fp4_allgather` и дальше только читается
- Где объявлен: `ServerArgs.disable_flashinfer_cutlass_moe_fp4_allgather`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: публикация MoE-флагов при инициализации → каждый dispatch и combine стандартного диспетчера

## Что меняет в движке

Предикат `should_use_flashinfer_cutlass_moe_fp4_allgather()` (`sglang/python/sglang/srt/layers/moe/utils.py`) истинен, когда одновременно выполнены **все** условия:

- флаг не выставлен;
- `--moe-a2a-backend none`;
- MoE-раннер — `flashinfer_cutlass`;
- включен `--enable-dp-attention`;
- квантизация модели — `modelopt_fp4`;
- размер EP-группы равен размеру attention-DP-группы.

Достаточно одному условию не выполниться, и путь не включается — тогда флаг ничего не меняет.

Когда предикат истинен, `StandardDispatcher` (`token_dispatcher/standard.py`) в `dispatch` квантует скрытые состояния FlashInfer-ядрами `fp4_quantize` и `nvfp4_block_scale_interleave` (при их отсутствии — `RuntimeError` с прямым указанием на этот путь), требует `input_global_scale` в конфиге квантизации и делает all-gather уже квантованных данных, а в `combine` собирает результат через `reduce_scatterv` по TP-группе. Дополнительно предикат участвует в решении, можно ли пропустить post-experts TP-all-reduce: FP4-all-gather его поглощает.

Флаг также взаимно исключает две оптимизации: пока FP4-all-gather активен, `should_use_dp_reduce_scatterv()` (альтернативный путь combine для обычных типов) выключен.

## Значения и формат

- Флаг без значения. Отсутствие — оптимизация включается, если сошлись все шесть условий.
- Наличие — стандартный путь: all-gather bf16, обычная редукция, отдельная квантизация внутри ядра.

## Когда использовать

- Расхождение численных результатов между FlashInfer Cutlass и другими раннерами на FP4-модели: выключите оптимизацию и сравните, локализовав потерю точности на этапе квантизации перед связью.
- Ошибка вида `FlashInfer fp4_quantize and nvfp4_block_scale_interleave are required ...` в конфигурации, которую нельзя быстро починить установкой нужной версии FlashInfer: флаг вернет рабочий путь ценой трафика.
- Не выставляйте флаг «на всякий случай» на боевой FP4-развертке с DP-attention: он ровно в четыре раза увеличивает объем данных на all-gather и убирает совмещенную редукцию.
- Не ждите эффекта на конфигурации с a2a-бэкендом или без DP-attention — там путь и так не активен.

## Влияние на производительность и память

- **Сетевой трафик.** С оптимизацией по all-gather едут FP4-значения плюс блочные масштабы; без нее — bf16. Разница — примерно четырехкратная по объему на самом горячем коллективе DP-attention.
- **Latency.** Дополнительно оптимизация экономит один коллектив на выходе (`reduce_scatterv` вместо all-reduce плюс scatter) и позволяет пропустить post-experts TP-all-reduce.
- **VRAM.** С оптимизацией промежуточный буфер all-gather меньше; выключение возвращает буфер полного размера. Аллокация идет из симметричного пула NCCL, когда он доступен.
- **Точность.** Оптимизация квантует активации до пересылки. На FP4-модели активации все равно уйдут в FP4 внутри ядра, но порядок операций отличается, и это единственная причина, по которой численный результат может разойтись.

## Взаимодействие с другими аргументами

- `--moe-runner-backend`: путь существует только для `flashinfer_cutlass`.
- `--moe-a2a-backend`: требуется `none`; любой a2a-бэкенд отменяет условие.
- `--enable-dp-attention`: обязателен.
- `--quantization`: требуется `modelopt_fp4`.
- `--ep-size` и `--dp-size`: EP-группа должна совпадать по размеру с attention-DP-группой.

## Типовые проблемы и диагностика

- `RuntimeError: FlashInfer fp4_quantize and nvfp4_block_scale_interleave are required for the flashinfer_cutlass FP4 all-gather path.` — версия FlashInfer без нужных символов; либо обновите ее, либо выставьте флаг.
- `AssertionError: input_global_scale is not set` — checkpoint не несет глобального масштаба FP4; путь неприменим.
- Флаг выставлен, а поведение не изменилось — проверьте по дампу `server_args=`, что раннер и квантизация действительно те, при которых путь активен.
- Просадка throughput после выставления флага на DP-развертке — ожидаемая цена; это и есть выключенная оптимизация связи.

## Примеры

```bash
python -m sglang.launch_server --model-path nvidia/DeepSeek-R1-FP4 --tp-size 8 --dp-size 8 --enable-dp-attention --moe-runner-backend flashinfer_cutlass --moe-a2a-backend none --quantization modelopt_fp4 --disable-flashinfer-cutlass-moe-fp4-allgather
```

```bash
python -m sglang.launch_server --model-path nvidia/DeepSeek-R1-FP4 --tp-size 8 --dp-size 8 --enable-dp-attention --moe-runner-backend flashinfer_cutlass --moe-a2a-backend none --quantization modelopt_fp4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/layers/moe/token_dispatcher/standard.py`
- `sglang/python/sglang/srt/layers/quantization/modelopt_quant.py`
