---
schema: 1
engine: sglang
primaryName: "--enable-fused-moe-sum-all-reduce"
title: "--enable-fused-moe-sum-all-reduce"
summary: Встраивает суммирование по topk-экспертам прямо в down-projection ядро Triton-раннера MoE через атомарное накопление, убирая отдельный проход редукции и промежуточный буфер. Включается только при topk больше двух, не работает с INT8/INT4-весами и реализован для CUDA/MUSA.
group: exec.moe
related:
  - --moe-runner-backend
  - --moe-a2a-backend
  - --quantization
  - --ep-size
---

# --enable-fused-moe-sum-all-reduce

## Кратко

Название сбивает с толку: речь не про распределенный all-reduce, а про локальное суммирование вкладов выбранных экспертов одного токена. Обычно Triton-раннер пишет результат каждого эксперта в отдельный буфер `intermediate_cache3` формы `(токены, topk, hidden)` и потом сводит его отдельным ядром `moe_sum_reduce`. Флаг убирает этот проход: второе ядро сразу накапливает результат в выходной тензор через `tl.atomic_add`.

## Оригинальная справка

```text
Enable fused moe triton and sum all reduce.
```

## Паспорт аргумента

- Флаги: `--enable-fused-moe-sum-all-reduce`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-*` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется в `__post_init__`, но на каждом вызове раннера пересчитывается набор условий (см. ниже) — флаг является необходимым, а не достаточным
- Где объявлен: `ServerArgs.enable_fused_moe_sum_all_reduce`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: forward, внутри Triton-раннера MoE

## Что меняет в движке

В `sglang/python/sglang/srt/layers/moe/moe_runner/triton_utils/fused_moe.py` признак вычисляется как:

```text
use_fused_moe_sum_all_reduce = флаг and (not no_combine) and (topk > 2)
                               and (not use_int8_w8a16) and (not use_int4_w4a16)
```

Когда он истинен, выход MoE обнуляется, и второе ядро (`down`) получает `fuse_sum_all_reduce=True` и `router_topk`. Внутри ядра (`sglang/python/sglang/kernels/ops/moe/fused_moe_triton_kernels.py`) строка расширенного индекса приводится обратно к индексу токена делением на `ROUTER_TOPK`, и накопитель добавляется в выход через `tl.atomic_add`. Промежуточный буфер `intermediate_cache3` в этом пути не участвует. `routed_scaling_factor`, если он не единичный, применяется потом одним `mul_` по выходу.

В ядре стоят взаимные исключения: `fuse_sum_all_reduce` несовместим с `fuse_add_to_output`, с `mask_output`, с `c_sorted` и с GPTQ/AWQ-ядрами — каждое из них проверяется ассертом.

Существенное ограничение платформы: пропуск отдельной редукции после ядра написан в ветке `_is_cuda or _is_musa`. На ROCm и XPU соответствующие ветки безусловно сводят `intermediate_cache3`, который в этом пути никто не заполнял, — то есть на этих платформах флаг включать нельзя.

Тот же механизм используется внутри экспериментальных LoRA-путей (`lora/trtllm_lora_temp`, `lora/marlin_lora_temp`), но там он включается кодом, а не этим аргументом.

## Значения и формат

- Флаг без значения. Отсутствие — классический путь с отдельным ядром редукции.
- Наличие имеет эффект только при `topk > 2`. Для `topk` 1 и 2 в коде уже есть более дешевые частные случаи (прямая запись в выход и `torch.add`), и флаг игнорируется.
- Флаг игнорируется при весах INT8-W8A16 и INT4-W4A16.
- Флаг относится только к Triton-раннеру MoE; на FlashInfer, Cutlass, DeepGEMM и прочих раннерах он не читается.

## Когда использовать

- Модель с большим topk (DeepSeek-подобные, topk 8) на Triton-раннере, где профиль показывает заметную долю времени в `moe_sum_reduce`.
- Ограничены по VRAM: путь убирает буфер `(токены, topk, hidden)`, который на длинном prefill бывает крупным.
- Не включайте на ROCm и XPU — ветка пропуска редукции там не реализована.
- Не включайте на квантизациях с INT8/INT4-весами: условие все равно не выполнится, а конфигурация станет менее очевидной.
- Не ждите эффекта на моделях с topk 1–2.

## Влияние на производительность и память

- **VRAM.** Исчезает промежуточный буфер `intermediate_cache3` размером `токены × topk × hidden` в dtype активаций. При topk 8, 8192 токенах и hidden 7168 в bf16 это порядка 900 МиБ — самая заметная выгода флага.
- **Latency.** Экономится один полный проход по данным (запуск ядра редукции плюс чтение буфера). Взамен добавляются атомарные операции, конкурирующие за одни и те же строки выхода; выигрыш зависит от формы батча и должен подтверждаться замером.
- **Численный результат.** `tl.atomic_add` не гарантирует порядок суммирования, поэтому результат перестает быть побитово воспроизводимым между запусками. Для конфигураций, где важна детерминированность, это дисквалифицирующее свойство.
- На межузловой трафик и KV-кеш влияния нет.

## Взаимодействие с другими аргументами

- `--moe-runner-backend`: путь существует только в Triton-раннере.
- `--quantization`: INT8-W8A16 и INT4-W4A16 отключают путь.
- `--moe-a2a-backend`: не мешает — редукция по topk локальна и выполняется после combine.
- `--ep-size`: не влияет на применимость.

## Типовые проблемы и диагностика

- Флаг выставлен, а профиль не изменился — проверьте topk модели (должен быть больше 2), раннер (должен быть Triton) и квантизацию.
- Мусор на выходе или нули на ROCm/XPU — на этих платформах после fused-пути все равно выполняется сведение незаполненного буфера; уберите флаг.
- `AssertionError: fuse_add_to_output and fuse_sum_all_reduce are mutually exclusive` / `mask_output and fuse_sum_all_reduce are mutually exclusive` / `fuse_sum_all_reduce is not supported for GPTQ/AWQ kernels` — путь столкнулся с несовместимой опцией ядра.
- Небольшие расхождения между запусками на одинаковом входе — следствие атомарного накопления, а не ошибки.
- Значение аргумента видно в дампе `server_args=` при старте; факт применения пути отдельной строкой в лог не пишется.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --moe-runner-backend triton --enable-fused-moe-sum-all-reduce
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --moe-runner-backend triton --enable-fused-moe-sum-all-reduce
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/moe_runner/triton_utils/fused_moe.py`
- `sglang/python/sglang/kernels/ops/moe/fused_moe_triton_kernels.py`
