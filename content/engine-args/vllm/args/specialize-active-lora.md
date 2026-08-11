---
schema: 1
engine: vllm
primaryName: "--specialize-active-lora"
title: "--specialize-active-lora"
summary: Захватывает отдельные CUDA graph под разное число активных адаптеров (степени двойки до `--max-loras`) и сужает сетку LoRA-ядер до фактического числа. Экономит на шагах с одним-двумя адаптерами ценой времени старта и памяти под графы.
group: LoRAConfig
related:
  - --enable-lora
  - --max-loras
  - --compilation-config
  - --enforce-eager
  - --cudagraph-capture-sizes
  - --gpu-memory-utilization
---

# --specialize-active-lora

## Кратко

Без флага метаданные LoRA-ядер всегда рассчитываются на худший случай — `max_loras + 1` групп (все слоты плюс «без адаптера»), — даже если в шаге реально работает один адаптер. Флаг заставляет движок вести отдельные CUDA graph для нескольких значений «число активных адаптеров» и подставлять в ядро фактическое число, округлённое вверх до ближайшей захваченной точки.

Флаг зависимый: он действует, только если в `CompilationConfig` включён `cudagraph_specialize_lora` (по умолчанию он `True`), то есть при отключённых CUDA graph или при `-cc.cudagraph_specialize_lora=false` он ничего не меняет.

## Оригинальная справка

```text
Whether to construct lora kernel grid by the number of active LoRA adapters.
When set to True, separate cuda graphs will be captured for different counts
of active LoRAs (powers of 2 up to max_loras), which can improve performance
for variable LoRA usage patterns at the cost of increased startup time and
memory usage. Only takes effect when cudagraph_specialize_lora is True.
```

## Паспорт аргумента

- Флаги: `--specialize-active-lora`, `--no-specialize-active-lora`
- Группа argparse: `LoRAConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: применяется только при `CompilationConfig.cudagraph_specialize_lora = True` (дефолт) и при включённых CUDA graph. При `--enforce-eager` графы не захватываются вовсе, и флаг бездействует
- Где объявлен: `vllm/config/lora.py:LoRAConfig.specialize_active_lora`
- Этап применения: захват CUDA graph при старте → диспетчеризация графа и подготовка метаданных LoRA-ядра на каждом шаге

## Что меняет в движке

**Набор точек захвата.** `get_captured_lora_counts(max_loras, specialize)` — единственный источник истины и для `CudagraphDispatcher`, и для punica-обёртки:

- `specialize = False` ⇒ `[max_loras + 1]`;
- `specialize = True` ⇒ все `n` из `1..max_loras + 1`, где `n` — степень двойки либо `n == max_loras + 1`.

Для `--max-loras 4` это `[1, 2, 4, 5]` вместо `[5]`; дальше диспетчер добавляет случай `0` (батч вовсе без LoRA). То есть на каждый размер батча захватывается пять вариантов графа вместо двух.

**Метаданные ядра.** `LoRAKernelMeta.meta_args(..., specialize_active_lora)` выбирает, что передать в ядро: при `True` — `num_active_loras_cpu`, реальное число уникальных адаптеров в батче, округлённое вверх до ближайшего значения из `captured_lora_counts` (чтобы совпасть с ключом графа); при `False` — заранее подготовленный тензор со значением `max_loras + 1`. Число хранится именно как CPU-тензор, а не Python-int, чтобы `torch.compile` не запёк его в константу при трассировке.

**Диспетчеризация.** `BatchDescriptor` включает поля `has_lora` и `num_active_loras`, поэтому граф выбирается с учётом числа активных адаптеров.

## Значения и формат

- Значение по умолчанию `false`; «не задан» и `--no-specialize-active-lora` эквивалентны.
- Флаг осмыслен только при `--max-loras >= 2`: при `max_loras = 1` набор точек и без него получается вырожденным.
- Значение **не** входит в `LoRAConfig.compute_hash()` — в отличие от `max_loras`, `max_lora_rank`, `fully_sharded_loras`, `lora_dtype`, `target_modules` и MoE-флагов. Смена только этого флага не инвалидирует кэш компиляции, но набор захваченных графов всё равно строится заново при каждом старте.
- Смежная ручка `cudagraph_specialize_lora` собственного CLI-флага не имеет; она задаётся через `--compilation-config` (например, `-cc.cudagraph_specialize_lora=false`).

## Когда использовать

- Нагрузка неоднородна по адаптерам: часть шагов идёт с одним активным адаптером, часть — со всеми слотами. Тогда специализация убирает работу ядер по пустым группам на «лёгких» шагах.
- `--max-loras` заметно больше фактической средней конкурентности по адаптерам.
- Не включайте, если время старта критично: захват графов и так занимает основную часть прогрева, а этот флаг умножает число вариантов.
- Не включайте при `--enforce-eager`: графов нет, эффекта нет.
- Не включайте, если в батче почти всегда заняты все слоты: округление вверх выведет на ту же точку `max_loras + 1`.

## Влияние на производительность и память

- **VRAM.** Каждый дополнительный захваченный граф занимает память. Оценка CUDA graph входит в бюджет профилирования (`profile_cudagraph_memory`), то есть расширенный набор графов уменьшает остаток под KV-cache при том же `--gpu-memory-utilization`.
- **Время старта.** Растёт пропорционально числу вариантов графа: вместо двух вариантов (`0` и `max_loras + 1`) захватываются `0`, все степени двойки до `max_loras` и `max_loras + 1` — то есть число вариантов растёт логарифмически по `--max-loras`, и каждый умножается на размеры из `--cudagraph-capture-sizes`.
- **Throughput и latency.** Выигрыш там, где активных адаптеров меньше `max_loras`: сетка ядра строится по фактическому числу групп. На шагах с полной загрузкой слотов разницы нет.
- **RAM хоста.** Не влияет.

## Взаимодействие с другими аргументами

- `--max-loras`: определяет и точки захвата, и верхнюю границу округления.
- `--compilation-config`: содержит `cudagraph_specialize_lora`, без которого этот флаг не действует, и `cudagraph_capture_sizes`, на которые умножается число вариантов.
- `--enforce-eager`: отключает CUDA graph целиком — флаг становится бездействующим.
- `--cudagraph-capture-sizes`, `--max-cudagraph-capture-size`: второй множитель в числе захватываемых графов.
- `--gpu-memory-utilization`: из его бюджета вычитается оценка памяти графов.

## Типовые проблемы и диагностика

- **Симптом:** старт стал заметно дольше после включения флага. **Причина:** захватывается больше вариантов графа. **Проверка:** сравнить время между началом захвата графов и открытием порта. **Лечение:** вернуть `--no-specialize-active-lora` или сократить `--cudagraph-capture-sizes`.
- **Симптом:** после включения упал `Available KV cache memory`. **Причина:** оценка памяти CUDA graph выросла. **Лечение:** снизить `--max-loras`, сократить набор размеров захвата или поднять `--gpu-memory-utilization`.
- **Симптом:** флаг включён, разницы в поведении нет. **Причина:** `--enforce-eager`, либо `cudagraph_specialize_lora=false` в `--compilation-config`, либо `--max-loras 1`. **Проверка:** строка `Enforce eager set, disabling torch.compile and CUDAGraphs.` в логе; фактическая `CompilationConfig` печатается в стартовой сводке. **Лечение:** привести конфигурацию компиляции в соответствие.
- **Подтверждение принятого значения:** отдельной строки нет; косвенно — увеличенное число сообщений о захвате CUDA graph при прогреве и большее значение `CUDAGraph memory` в подробной строке профилирования памяти.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-lora --max-loras 4 --specialize-active-lora --max-lora-rank 16
```

```bash
vllm serve /models/Qwen3-4B --enable-lora --max-loras 4 --no-specialize-active-lora --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/lora.py`
- `vllm/vllm/config/compilation.py`
- `vllm/vllm/lora/utils.py`
- `vllm/vllm/lora/ops/triton_ops/lora_kernel_metadata.py`
- `vllm/vllm/v1/cudagraph_dispatcher.py`
- `vllm/vllm/v1/worker/gpu/lora_utils.py`
- `vllm/vllm/config/vllm.py`
