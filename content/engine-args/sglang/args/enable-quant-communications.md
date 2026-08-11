---
schema: 1
engine: sglang
primaryName: "--enable-quant-communications"
title: "--enable-quant-communications"
summary: Заменяет all-reduce на prefill-фазе связкой «квантование в INT8 → all-gather → редукция в исходной точности». Реализация существует только для Ascend NPU: на любом другом `--device` сервер падает на старте.
group: exec.comm
related:
  - --device
  - --tp-size
  - --enable-dp-attention
  - --disable-custom-all-reduce
  - --enable-symm-mem
  - --flashinfer-allreduce-fusion-backend
  - --chunked-prefill-size
---

# --enable-quant-communications

## Кратко

Флаг включает сжатие межкарточного обмена: тензор перед передачей квантуется в INT8 с пошкальным множителем, по группе выполняется `all_gather` уже в int8, а сумма считается на приемной стороне в полной точности. Трафик TP-редукции падает примерно вдвое-вчетверо относительно bf16/fp16, ценой потери точности при сложении. Обменять пропускную способность на точность можно только на NPU: `check_server_args` отвергает флаг на любом другом устройстве и на `--tp-size 1`. Переключение действует **только на prefill** — decode и idle идут обычным путем.

## Оригинальная справка

```text
Enable INT8 quantization of TP communications (limited support).
```

## Паспорт аргумента

- Флаги: `--enable-quant-communications`
- Группа: `exec.comm`
- Тип значения: bool (объявлен как `Optional[bool]`, argparse принимает флаг без значения)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: не переписывается, но проверяется. `check_server_args` (`sglang/python/sglang/srt/server_args.py`) поднимает `ValueError: Communications quantization is only used with tp_size != 1` при `--tp-size 1` и `ValueError: Communications quantization is only supported for NPU device`, если `--device` не `npu`
- Где объявлен: `ServerArgs.enable_quant_communications`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но с явной пометкой «limited support» в собственной справке
- Этап применения: разбор CLI → `check_server_args` (жесткие проверки) → forward: `RowParallelLinear.forward` и `layers/communicator.py` выбирают квантованный коллектив на каждой prefill-итерации

## Что меняет в движке

Значение читается ровно в двух местах, и оба — на горячем пути:

- `layers/linear.py`, выход `RowParallelLinear`: если `not forward_batch.forward_mode.is_decode_or_idle()` и флаг включен, вместо `tensor_model_parallel_all_reduce(output_parallel)` вызывается `tensor_model_parallel_quant_all_reduce(...)`;
- `layers/communicator.py`, ветка «all-reduce внимания + RMSNorm»: та же подмена на `attention_tensor_model_parallel_quant_all_reduce(...)`, но только если фьюжен all-reduce (`apply_flashinfer_allreduce_fusion` / `apply_aiter_all_reduce_fusion`) не забрал этот слой раньше.

`GroupCoordinator.quant_all_reduce` — тонкий диспетчер: если у группы есть `npu_communicator` и он не выключен, вызывается `NpuCommunicator.quant_all_reduce`, иначе выполняется **обычный** in-place all-reduce. То есть даже если бы проверка на устройство отсутствовала, на CUDA флаг ничего бы не сделал.

Сама реализация (`distributed/device_communicators/npu_communicator.py`) не является all-reduce в привычном смысле:

```python
x_q, scale = npu_dynamic_quant(x, dst_type=torch.int8)
dist.all_gather_into_tensor(output_tensor, x_q, group=self.group)
dist.all_gather_into_tensor(output_scale, scale, group=self.group)
output_tensor = output_tensor.to(x.dtype) * output_scale.unsqueeze(-1).to(x.dtype)
return output_tensor.reshape((world_size,) + input_size).sum(dim=0)
```

Передается int8-полезная нагрузка плюс вектор масштабов, деквантование и суммирование делаются локально в исходном dtype. Комментарий в коде фиксирует контракт: «All gather is performed in low precision, but reduce in full precision».

### Что это заменяет и чего требует от топологии

Заменяется коллектив all-reduce на выходе внимания и MLP/MoE в prefill. Никакого специального NVLink/NVSwitch/RDMA не требуется — наоборот, смысл флага в том, чтобы помочь там, где межкарточный канал узкий. Требование одно и жесткое: HCCL-коммуникатор Ascend, то есть `--device npu`.

Заметьте, что `all_gather` переносит `world_size` копий данных, тогда как ring-all-reduce — примерно `2 * (world_size - 1) / world_size` объема. Экономия получается за счет int8, а не за счет алгоритма, и на больших группах преимущество быстро тает.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- `--tp-size 1` — жесткий отказ на старте, не тихий no-op.
- `--device` кроме `npu` — жесткий отказ на старте.
- Гранулярность квантования — per-token (динамический `npu_dynamic_quant`), настроек у флага нет.

## Когда использовать

- Ascend-хост с несколькими NPU, длинный prefill, и вы видите, что коллективы съедают заметную долю prefill-времени. Это единственный поддерживаемый сценарий.
- Не включайте, если вам нужна побитовая воспроизводимость или вы сравниваете качество модели с эталоном: суммирование деквантованных значений меняет числа.
- Не включайте ради decode: путь на decode не активируется вообще.
- Не пробуйте на CUDA/ROCm «посмотреть, что будет» — сервер не стартует.

## Влияние на производительность и память

- **Трафик и latency prefill.** Основной эффект: полезная нагрузка коллектива уменьшается пропорционально отношению разрядностей (bf16 → int8 это вдвое), плюс небольшой довесок на вектор масштабов.
- **VRAM/HBM.** Растет пиковое потребление на самом коллективе: `all_gather` материализует буфер размером `world_size * input_size` в int8 плюс промежуточный тензор того же размера в исходном dtype после деквантования. На большом `--chunked-prefill-size` это заметный пик — учитывайте его в `--mem-fraction-static`.
- **Compute.** Добавляются квантование, деквантование и суммирование по оси рангов — не бесплатно, на маленьких тензорах может съесть весь выигрыш.
- **Точность.** Ухудшается. Насколько — зависит от модели; отсюда и пометка «limited support».
- **Время старта.** Не меняется.

## Взаимодействие с другими аргументами

- `--device`: обязателен `npu`.
- `--tp-size`: обязателен больше 1; чем больше группа, тем больше промежуточный буфер `all_gather`.
- `--enable-dp-attention`: редукция внимания идет по attention-TP-группе; квантованный путь применяется там же, где обычный.
- `--flashinfer-allreduce-fusion-backend` и `--enable-aiter-allreduce-fusion`: эти фьюжен-пути перехватывают слой раньше и отменяют квантованный коллектив для него. На Ascend они и так неприменимы, но в смешанных конфигурациях помните о приоритете.
- `--disable-custom-all-reduce`, `--enable-symm-mem`, `--enable-mscclpp`: относятся к CUDA/ROCm-путям и с этим флагом не пересекаются.
- `--chunked-prefill-size`: определяет размер тензора коллектива и, соответственно, и выигрыш, и пик памяти.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Communications quantization is only supported for NPU device` на старте. **Причина:** флаг на CUDA/ROCm/CPU. **Решение:** убрать.
- **Симптом:** `ValueError: Communications quantization is only used with tp_size != 1`. **Причина:** одна карта. **Решение:** убрать флаг или поднять `--tp-size`.
- **Симптом:** качество ответов просело после включения. **Причина:** int8-обмен на каждом слое. **Решение:** выключить; иного регулятора точности у флага нет.
- **Симптом:** OOM на длинном prefill, которого не было без флага. **Причина:** буфер `all_gather` размером `world_size × батч`. **Решение:** уменьшить `--chunked-prefill-size` или `--mem-fraction-static`.
- **Что смотреть:** итоговый дамп `server_args=` при старте — единственное подтверждение, что флаг принят; отдельной строки о включении квантованных коллективов движок не печатает.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --device npu --tensor-parallel-size 4 --enable-quant-communications
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --device npu --tensor-parallel-size 4 --enable-quant-communications --chunked-prefill-size 4096
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/device_communicators/npu_communicator.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/layers/linear.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/docs/docs/hardware-platforms/ascend-npus/reference/support_features.mdx`
