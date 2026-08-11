---
schema: 1
engine: sglang
primaryName: "--disable-attn-tp-gather"
title: "--disable-attn-tp-gather"
summary: Отключает scheduler-side attn_tp_gather — общий SP-путь с padding'ом числа токенов до `attn_tp_size` и предвыделенным gathered-буфером. Нужен моделям, которые делают scatter/gather внутри самого внимания.
group: parallel
related:
  - --moe-dense-tp-size
  - --moe-a2a-backend
  - --enable-dp-attention
  - --dp-size
  - --tp-size
  - --enable-attn-tp-input-scattered
  - --cuda-graph-max-bs-decode
---

# --disable-attn-tp-gather

## Кратко

Флаг отменяет один конкретный механизм: подготовку `gathered_buffer` и выравнивание числа токенов до кратности `attn_tp_size` на стороне планировщика. Механизм включается сам, как только задан `--moe-dense-tp-size` или выбран любой `--moe-a2a-backend`, кроме `none`, — и он лишний для моделей, которые сами делают all_gather/reduce_scatter внутри attention и общий буфер не читают. Побочный эффект механизма, названный в оригинальной справке: на малых батчах padding заставляет автотюнеры ядер выбирать варианты не того размера. Значение по умолчанию `false`; движок его не переопределяет.

## Оригинальная справка

```text
Disable scheduler-side attn_tp_gather (the upstream SP path that pads num_tokens to attn_tp_size and pre-allocates a gathered buffer). Use for models that manage SP scatter/gather at the model level (e.g., perform their own all_gather/reduce_scatter inside attention) and do not consume the upstream gathered_buffer. Without this, the cuda graph runner pads num_tokens to attn_tp_size, which can cause kernel autotuners to select wrong-sized variants at small batches.
```

## Паспорт аргумента

- Флаги: `--disable-attn-tp-gather`
- Группа: `parallel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: присутствует / отсутствует; парного `--no-…` нет
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным — ни один `_handle_*` и ни одно правило из `arg_groups/overrides.py` его не переписывает
- Где объявлен: `ServerArgs.disable_attn_tp_gather`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но узкоспециальный: это опт-аут для конкретных модельных реализаций, а не ручка производительности общего назначения
- Этап применения: публикация в `ParallelState` → `require_attn_tp_gather()` при построении forward-путей → подготовка батча в планировщике → захват и воспроизведение CUDA graph

## Что меняет в движке

Единственная точка чтения — `utils/common.py:require_attn_tp_gather`:

```python
if get_parallel().disable_attn_tp_gather:
    return False

if (not get_moe_a2a_backend().is_none()
        or get_parallel().moe_dense_tp_size is not None):
    if get_parallel().enable_dp_attention:
        return get_parallel().dp_size < server_args.tp_size
    else:
        return True
else:
    return False
```

Флаг — ранний выход, он отменяет обе ветки. Результат функции складывается с `require_mlp_tp_gather` в `require_gathered_buffer`; именно этот предикат решает, будет ли планировщик резервировать общий буфер и приводить `num_tokens` к кратности `attn_tp_size`. Без gathered-буфера графовый раннер работает с фактическим числом токенов.

Обратите внимание на условие включения по умолчанию: при DP-attention gather нужен только когда `dp_size < tp_size`, то есть при `attn_tp_size > 1`. В канонической конфигурации `dp_size == tp_size` этот путь и так не активируется, и флаг ничего не меняет.

## Значения и формат

- Флаг без аргумента. «Не задан» = attn_tp_gather включается по правилам выше.
- Не имеет параметров и не валидируется: любой запуск его примет.
- Флаг не отменяет `require_mlp_tp_gather` — MLP-сторона gathered-буфера живет отдельно и управляется `--moe-dense-tp-size`, `--enable-dp-lm-head` и `--moe-a2a-backend`.

## Когда использовать

- Модель управляет sequence-parallel раскладкой самостоятельно внутри attention (собственные `all_gather`/`reduce_scatter`) и не читает верхнеуровневый `gathered_buffer` — это прямое назначение из справки.
- Диагностика подозрительно плохих ядер на малых батчах при `attn_tp_size > 1`: padding до `attn_tp_size` мог сдвинуть выбор автотюнера. Флаг — дешевый способ проверить гипотезу.
- Не включайте «на всякий случай» на стандартной модели: если верхний путь реально используется, его отключение сломает раскладку токенов.
- Не включайте при `dp_size == tp_size` в расчете на эффект: там `require_attn_tp_gather` и так возвращает `False`.

## Влияние на производительность и память

- **VRAM.** Небольшая экономия: `gathered_buffer` не предвыделяется.
- **Ядра.** Основной заявленный эффект — снятие padding'а числа токенов, из-за которого на малых батчах автотюнер мог выбрать вариант ядра не того размера.
- **CUDA graph.** Захват идет по фактическим, а не выровненным размерам; набор захваченных форм меняется.
- **KV-кеш и конкурентность.** Не затрагиваются.
- **Время старта.** Практически не меняется.

## Взаимодействие с другими аргументами

- `--moe-dense-tp-size`: само присутствие значения (даже `tp_size`) включает `attn_tp_gather`; этот флаг — единственный способ его выключить.
- `--moe-a2a-backend`: любое значение, кроме `none`, включает `attn_tp_gather`.
- `--enable-dp-attention` и `--dp-size`/`--tp-size`: при DP-attention gather включается только при `dp_size < tp_size`.
- `--enable-attn-tp-input-scattered`: другая, независимая оптимизация того же стыка — она работает только **без** DP-attention и без a2a-backend, то есть в конфигурациях, где `attn_tp_gather` обычно и не включается.
- `--cuda-graph-max-bs-decode` и остальной `--cuda-graph-config`: набор захватываемых форм меняется вместе с padding'ом.

## Типовые проблемы и диагностика

- Собственных сообщений об ошибках у флага нет: он ничего не проверяет и ничего не запрещает. Неверное включение проявляется как некорректный выход модели или падение внутри attention, а не как понятная ошибка на старте.
- Флаг задан, изменений не видно — вероятнее всего `require_attn_tp_gather` и так возвращал `False`: не задан `--moe-dense-tp-size`, a2a-backend равен `none`, либо `dp_size == tp_size`.
- Просадка на малых батчах при `attn_tp_size > 1` — исходный симптом из справки; сравните пропускную способность с флагом и без него на одинаковой нагрузке.
- Принятое значение — в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`); отдельной строки лога у этого пути нет.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/moe-model --tensor-parallel-size 8 --dp-size 4 --enable-dp-attention --moe-dense-tp-size 1 --disable-attn-tp-gather
```

```bash
python -m sglang.launch_server --model-path /models/moe-model --tensor-parallel-size 8 --moe-a2a-backend deepep --ep-size 8 --disable-attn-tp-gather
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/runtime_context.py`
- `sglang/python/sglang/srt/managers/scheduler_components/dp_attn.py`
