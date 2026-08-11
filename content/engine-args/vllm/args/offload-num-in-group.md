---
schema: 1
engine: vllm
primaryName: "--offload-num-in-group"
title: "--offload-num-in-group"
summary: Сколько последних слоев каждой группы `--offload-group-size` выгружается в хостовую RAM. Вместе с размером группы задает долю выгруженных весов; значения больше 1 требуют увеличенного `--offload-prefetch-step`, иначе подкачка перестает скрываться.
group: OffloadConfig
related:
  - --offload-group-size
  - --offload-prefetch-step
  - --offload-backend
  - --offload-params
---

# --offload-num-in-group

## Кратко

`--offload-num-in-group` — числитель доли выгруженных весов: из каждой группы в `--offload-group-size` слоев в хостовую RAM уезжают **последние** `num_in_group` слоев. При `group_size=8, num_in_group=2` это индексы 6, 7, 14, 15, 22, 23 и далее.

Аргумент бессмыслен в одиночку: пока `--offload-group-size` равен нулю, prefetch-режим выключен и значение не читается.

Важное следствие раскладки, которого нет в справке: выгруженные слои группы идут **подряд**. Между ними нет невыгруженных слоев, за вычислением которых можно спрятать подкачку, поэтому при `num_in_group > 1` нужен `--offload-prefetch-step` не меньше `num_in_group`.

## Оригинальная справка

```text
Number of layers to offload per group.
Must be <= offload_group_size. Default is 1.
```

## Паспорт аргумента

- Флаги: `--offload-num-in-group`
- Группа argparse: `OffloadConfig`
- Тип значения: int (число слоев)
- Допустимые значения: `>= 1` (валидация `ge=1`); дополнительно `<= offload_group_size`, когда prefetch активен
- Значение по умолчанию: `Field(default=1, ge=1)`, то есть `1`
- Эффективное значение: не переопределяется; не читается при `--offload-group-size 0` и при `--offload-backend uva`
- Где объявлен: `vllm/config/offload.py:PrefetchOffloadConfig.offload_num_in_group`
- Этап применения: построение слоев в `make_layers` (отбор модулей в `PrefetchOffloader.wrap_modules`)

## Что меняет в движке

Значение входит ровно в одно условие отбора:

```python
if module_index % self.group_size >= self.group_size - self.num_in_group:
```

То есть слой попадает под выгрузку, если его позиция внутри группы находится в последних `num_in_group` местах. `module_index` считается от нуля внутри диапазона слоев текущего pipeline-ранга.

Отсюда доля выгруженных весов слоев равна `num_in_group / group_size` — это самая полезная величина для планирования. `1/8` — 12.5 %, `2/8` — 25 %, `4/8` — 50 %.

Проверка `num_in_group <= group_size` живет в `OffloadConfig.validate_offload_config` и срабатывает, когда backend равен `prefetch` **или** когда `offload_group_size > 0`. Именно из-за первой половины условия `--offload-backend prefetch` без явной группы всегда падает: дефолтная единица оказывается больше нулевой группы.

Каждый отобранный слой получает свой `_ModuleOffloader` и место в списке `module_offloaders`; индекс в этом списке (а не номер слоя) используется и для циклической подкачки `next_index = (index + prefetch_step) % len(module_offloaders)`, и для выбора слота буферного пула `slot_idx = index % prefetch_step`.

## Значения и формат

- Целое число от 1 до `--offload-group-size`.
- `1` (дефолт) — наименее болезненная раскладка: между двумя выгруженными слоями всегда есть `group_size − 1` обычных слоев.
- Значение, равное `group_size`, означает выгрузку всех слоев. Валидация это пропускает, но перекрывать передачу становится нечем — по стоимости это близко к UVA-режиму, только с дополнительным расходом VRAM под буферы.
- `0` отвергается валидацией `ge=1`; «выключить» — это `--offload-group-size 0`.
- Специальных значений нет.

## Когда использовать

- Оставляйте `1`, пока экономии хватает. Это единственная раскладка, где подкачка каждого выгруженного слоя гарантированно имеет за собой вычисление невыгруженных.
- Повышайте до 2 и выше, только если нужно выгрузить больше 20-25 % весов и при этом увеличиваете `--offload-prefetch-step` минимум до того же числа.
- Не поднимайте `num_in_group` там, где можно уменьшить `--offload-group-size`: `2/8` и `1/4` дают одинаковую долю, но `1/4` раскладывает выгруженные слои поодиночке и подкачивается лучше.
- Не используйте, чтобы «выгрузить последние слои модели»: раскладка периодическая, а не хвостовая, и при PP индексы к тому же локальные.

## Влияние на производительность и память

- **VRAM.** Экономия пропорциональна `num_in_group / group_size` от объема параметров слоев. Буферный пул от этого аргумента напрямую не зависит — его размер определяет `--offload-prefetch-step`.
- **RAM хоста.** Растет на тот же выгруженный объем; память пиннится.
- **Скорость.** Нелинейно ухудшается при `num_in_group > prefetch_step`. Слоты буферного пула распределяются как `index % prefetch_step`, а `start_onload_to_static()` ждет вычислительный поток, прежде чем перезаписать буфер. Поэтому при `num_in_group=2, prefetch_step=1` подкачка второго слоя пары стартует только после того, как первый досчитался, и полностью попадает на критический путь.
- **Время старта.** Влияет только через объем копируемых в хост весов и через ключ кэша компиляции: `OffloadConfig.compute_hash()` учитывает все поля offload.

## Взаимодействие с другими аргументами

- `--offload-group-size`: знаменатель доли и одновременно выключатель режима; должно быть `>= num_in_group`.
- `--offload-prefetch-step`: практическое требование — не меньше `num_in_group`, иначе подряд идущие выгруженные слои делят один слот буфера и сериализуются с вычислением.
- `--offload-backend`: значение читается только в prefetch-режиме.
- `--offload-params`: слои без совпавших параметров выпадают из раскладки, поэтому фактическая доля может оказаться меньше расчетной.

## Типовые проблемы и диагностика

- **Симптом:** `offload_num_in_group (3) must be <= offload_group_size (2)` при старте. **Причина:** доля больше единицы. **Лечение:** увеличить группу.
- **Симптом:** `offload_num_in_group (1) must be <= offload_group_size (0)` при заданном `--offload-backend prefetch`. **Причина:** не задан `--offload-group-size`. **Лечение:** задать группу.
- **Симптом:** увеличили `num_in_group` вдвое, а просадка скорости выросла намного сильнее, чем вдвое. **Причина:** `--offload-prefetch-step` остался равным 1. **Лечение:** поднять шаг минимум до `num_in_group`, приняв рост буферного пула.
- **Симптом:** экономия VRAM меньше расчетной доли. **Причина:** либо фильтр `--offload-params`, либо буферный пул. **Проверка:** `Initialized N modules` и пара `Total GPU memory saved` / `Static buffer pool` в итоговой строке `[PrefetchOffloader]`.
- **Подтверждение принятого значения:** та же строка `[PrefetchOffloader] Initialized ... (group_size=N, num_in_group=M, prefetch_step=K, mode=cpu)`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --offload-group-size 8 --offload-num-in-group 1
```

```bash
vllm serve /models/Qwen3-4B --offload-group-size 4 --offload-num-in-group 2 --offload-prefetch-step 2
```

## Источники

- `vllm/vllm/config/offload.py`
- `vllm/vllm/model_executor/offloader/prefetch.py`
- `vllm/vllm/model_executor/offloader/base.py`
- `vllm/vllm/config/vllm.py`
