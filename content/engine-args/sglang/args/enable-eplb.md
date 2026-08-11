---
schema: 1
engine: sglang
primaryName: "--enable-eplb"
title: "--enable-eplb"
summary: Включает периодическую перебалансировку экспертов по рангам EP на основе статистики активаций; требует `--ep-size` больше единицы и автоматически поднимает рекордер распределения экспертов.
group: exec.moe
related:
  - --ep-num-redundant-experts
  - --eplb-algorithm
  - --eplb-rebalance-num-iterations
  - --eplb-rebalance-layers-per-chunk
  - --eplb-min-rebalancing-utilization-threshold
  - --expert-distribution-recorder-mode
  - --ep-dispatch-algorithm
  - --init-expert-location
  - --ep-size
---

# --enable-eplb

## Кратко

`--enable-eplb` поднимает `EPLBManager`, который считает активации экспертов и раз в `--eplb-rebalance-num-iterations` проходов пересчитывает раскладку физических экспертов по рангам, перемещая веса «на живую». Флаг тянет за собой рекордер распределения экспертов и подстановку `--ep-dispatch-algorithm`, а без реального экспертного параллелизма (`ep_size > 1`) отвергается ассертом. Полезен он ровно там, где маршрутизация неравномерна и один ранг тормозит всю группу.

## Оригинальная справка

```text
Enable EPLB algorithm
```

## Паспорт аргумента

- Флаги: `--enable-eplb`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-enable-eplb` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но включает цепочку подстановок в `__post_init__` (см. ниже)
- Где объявлен: `ServerArgs.enable_eplb`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_eplb_and_dispatch`, `_handle_expert_distribution_metrics`, `_handle_elastic_ep`) → инициализация model runner (`maybe_init_eplb_manager`) → конец каждого forward-прохода

## Что меняет в движке

**В `__post_init__`:**

- если `--expert-distribution-recorder-mode` не задан, он выставляется в `stat` с предупреждением в логе — без статистики балансировать нечего;
- если `--ep-dispatch-algorithm` не задан, он становится `dynamic` при `--moe-a2a-backend none` и `static` в остальных случаях;
- проверяется `ep_size > 1` (ассерт; исключение — режим `--elastic-ep-join-mode scale`);
- `--expert-distribution-recorder-buffer-size`, если не задан, приравнивается к `--eplb-rebalance-num-iterations`;
- при заданном `--elastic-ep-backend` значение `--eplb-algorithm auto` превращается в `elasticity_aware`;
- DWDP (`--dwdp-size`) с EPLB несовместим и падает ассертом «EPLB dynamic migration conflicts with static DWDP partitioning».

**В рантайме** (`sglang/python/sglang/srt/eplb/eplb_manager.py`): model runner создает `EPLBManager` (кроме draft-воркера). Конструктор проверяет `eplb_rebalance_num_iterations >= expert_distribution_recorder_buffer_size` и запускает запись статистики. Дальше на каждом `on_forward_pass_end` крутится генератор: `--eplb-rebalance-num-iterations` проходов ожидания, затем `rebalance()`:

1. дамп статистики (`logical_count`, средняя утилизация GPU за окно);
2. проверка порога `--eplb-min-rebalancing-utilization-threshold` — если утилизация выше порога, перебалансировка пропускается со строкой `[EPLBManager] Skipped ep rebalancing: …`;
3. `ExpertLocationMetadata.init_by_eplb` вызывает алгоритм из `--eplb-algorithm` (при `auto` — `deepseek_hierarchical`, если число групп экспертов делится на число узлов, иначе `deepseek`);
4. слои обновляются порциями по `--eplb-rebalance-layers-per-chunk` (между порциями генератор отдает управление, то есть перенос весов размазывается по нескольким проходам), веса перемещаются `ExpertLocationUpdater`.

**В моделях** флаг дополнительно управляет тем, создается ли `ExpertLocationDispatchInfo` (в DeepSeek-V2/V3 — только при `enable_eplb`) и отключает часть быстрых bypass-путей маршрутизации, несовместимых с remap.

## Значения и формат

- Флаг без значения. Отсутствие флага — раскладка экспертов фиксируется на старте и больше не меняется.
- `--enable-eplb` без `--ep-num-redundant-experts` тоже осмыслен: балансировщик переставляет существующие эксперты между рангами. Реплики нужны, когда одного экземпляра «горячего» эксперта мало.
- Флаг не имеет смысла при `--ep-size 1` и будет отвергнут ассертом.

## Когда использовать

- Длинная стабильная нагрузка на большой EP-группе, где заметен перекос активаций: рекомендация апстрима — крупные батчи (чтобы статистика была устойчивой) и периодическая перебалансировка.
- Вместе с `--ep-num-redundant-experts`, если перестановки без размножения недостаточно.
- Не включайте на короткоживущих инстансах и при малом трафике: окно статистики просто не наберется, а накладные расходы на рекордер останутся.
- Не включайте, если инстанс обслуживает резко разнородные нагрузки: раскладка будет догонять «среднее», которого не существует.

## Влияние на производительность и память

- **VRAM.** Сам флаг новых весов не добавляет — их добавляет `--ep-num-redundant-experts`. Перенос экспертов требует временных буферов на время обновления слоя.
- **Пауза на перебалансировку.** Обновление раскладки останавливает продвижение forward-проходов на время переноса весов; `--eplb-rebalance-layers-per-chunk` дробит его на порции. Длительность печатается: `[EPLBManager] rebalance end time=<N>s` (тайминг измеряется только когда chunking выключен).
- **Постоянные накладные расходы.** Рекордер распределения экспертов работает всегда, пока включен EPLB; режим `stat` — самый дешевый из доступных, `per_token` заметно дороже.
- **Выигрыш.** Через выравнивание нагрузки: меньше простоя самого загруженного ранга на каждом MoE-слое.
- **Гибрид с KTransformers.** CPU-веса kt-kernel загружаются один раз, в `process_weights_after_loading`, по карте `physical_to_logical_map_cpu`. В апстрим-коде нет повторной загрузки CPU-весов после перебалансировки — то есть с включенным KT изменение раскладки на GPU не сопровождается переносом CPU-части.

## Взаимодействие с другими аргументами

- `--ep-num-redundant-experts`: бюджет реплик, которым распоряжается EPLB.
- `--eplb-algorithm`: выбор алгоритма; `auto` разрешается по числу групп экспертов и узлов.
- `--eplb-rebalance-num-iterations`: период. Должен быть не меньше `--expert-distribution-recorder-buffer-size`, иначе конструктор менеджера падает ассертом.
- `--eplb-rebalance-layers-per-chunk`: дробление переноса; при `null` переносятся все слои разом (и включается тайминг).
- `--eplb-min-rebalancing-utilization-threshold`: перебалансировка пропускается, когда GPU и так загружен выше порога; значение по умолчанию `1.0` фактически означает «не пропускать».
- `--expert-distribution-recorder-mode` и `--expert-distribution-recorder-buffer-size`: источник статистики; оба получают значения по умолчанию при включенном EPLB.
- `--ep-dispatch-algorithm`: подставляется автоматически; при `--moe-a2a-backend none` допустимы только ранг-инвариантные варианты (`dynamic`, `fake`).
- `--init-expert-location`: задает стартовую раскладку, дальше ее меняет EPLB.
- `--elastic-ep-backend`: сужает набор допустимых алгоритмов до `elasticity_aware(_hierarchical)`.

## Типовые проблемы и диагностика

- `AssertionError` на `ep_size > 1` — EPLB включен без экспертного параллелизма.
- `eplb_rebalance_num_iterations must be greater than expert_distribution_recorder_buffer_size` — период меньше окна статистики; увеличьте период или уменьшите буфер.
- `Elastic EP requires eplb_algorithm to be set to 'auto' or 'elasticity_aware(_hierarchical)'` — несовместимая пара с elastic EP.
- `EPLB is enabled. The expert_distribution_recorder_mode is automatically set.` — информационное предупреждение о подстановке `stat`.
- Перебалансировка не происходит — смотрите строку `Skipped ep rebalancing: current GPU utilization … > minimum rebalance threshold …` и значение `--eplb-min-rebalancing-utilization-threshold`.
- Периодические просадки latency — это и есть окна переноса весов; дробите их `--eplb-rebalance-layers-per-chunk`.
- Старт менеджера подтверждается строкой `[EPLBManager] system started, will rebalance per <N> iterations.`; подробную раскладку до и после обновления включает переменная `SGLANG_LOG_EXPERT_LOCATION_METADATA`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --enable-eplb --ep-num-redundant-experts 32
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --enable-eplb --eplb-rebalance-num-iterations 2000 --eplb-rebalance-layers-per-chunk 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/eplb/expert_location.py`
- `sglang/python/sglang/srt/eplb/eplb_algorithms/__init__.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
