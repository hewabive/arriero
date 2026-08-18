---
schema: 1
engine: sglang
primaryName: "--expert-distribution-recorder-buffer-size"
title: "--expert-distribution-recorder-buffer-size"
summary: Задает глубину кольцевого буфера рекордера распределения экспертов в forward-проходах — то есть окно, по которому EPLB видит статистику. По умолчанию приравнивается к `--eplb-rebalance-num-iterations`, и превышать этот период нельзя.
group: exec.moe
related:
  - --expert-distribution-recorder-mode
  - --eplb-rebalance-num-iterations
  - --enable-eplb
  - --expert-balancedness-report-mode
  - --ep-num-redundant-experts
---

# --expert-distribution-recorder-buffer-size

## Кратко

Аргумент управляет ровно одним объектом: кольцевым буфером счетчиков внутри `_StatAccumulator` (`sglang/python/sglang/srt/eplb/expert_distribution.py`). В буфере лежит по одной строке на forward-проход, дамп суммирует все строки. Единица измерения — forward-проход (батч), не запрос и не токен. На детальные режимы рекордера (`per_pass`, `per_token`) аргумент не влияет вообще: их аккумулятор буфер не использует.

## Оригинальная справка

```text
Circular buffer size of expert distribution recorder. Set to -1 to denote infinite buffer.
```

## Паспорт аргумента

- Флаги: `--expert-distribution-recorder-buffer-size`
- Группа: `exec.moe`
- Тип значения: int (число forward-проходов)
- Допустимые значения: положительное число либо `-1`; argparse ничего не проверяет
- Значение по умолчанию: `null`
- Эффективное значение: `_handle_expert_distribution_metrics` в `__post_init__` при `null` подставляет значение `--eplb-rebalance-num-iterations`. Поскольку то поле объявлено как обычный `int` со значением `1000` и никогда не бывает `null`, вторая ветка подстановки (константа `1000` при заданном режиме рекордера) фактически недостижима — эффективный дефолт всегда равен периоду перебалансировки
- Где объявлен: `ServerArgs.expert_distribution_recorder_buffer_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → создание рекордера в model runner → каждый forward-проход

## Что меняет в движке

`_StatAccumulator` выделяет буфер формы `(buffer_size, num_layers, num_physical_experts)` типа int32 на устройстве и на каждом проходе кладет туда счетчики физических экспертов. `dump_record` сворачивает все строки буфера в `logical_count` (по текущей карте `physical_to_logical_map`), делает `all_reduce` по рангам и сбрасывает буфер.

Значение `-1` заменяет кольцевой буфер на растущий (`_InfiniteBuffer`): стартовая емкость 128 строк, при переполнении емкость удваивается с копированием. Емкость после сброса не уменьшается.

Буфер участвует в единственной проверке согласованности — в конструкторе `EPLBManager`:

```text
eplb_rebalance_num_iterations must be greater than expert_distribution_recorder_buffer_size
```

Проверка фактически нестрогая (`>=`), но смысл ее именно такой: буфер не должен быть длиннее периода перебалансировки, иначе в окне остались бы строки, записанные до предыдущего дампа, то есть статистика от уже неактуальной раскладки экспертов.

Незаполненные строки кольцевого буфера — нули и на сумму не влияют, поэтому первый дамп после старта корректен даже если проходов было меньше, чем строк.

## Значения и формат

- Положительное `N` — усреднение по последним `N` forward-проходам.
- `-1` — «бесконечный» буфер: копится все с момента `start_record` до дампа. С включенным EPLB это не даст экономии, потому что дамп все равно случается каждые `--eplb-rebalance-num-iterations` проходов; смысл появляется при ручной записи через HTTP, когда вы хотите одну сводку за весь прогон.
- `0` — argparse примет, но буфер нулевой длины: `_CircularBuffer` создаст пустой тензор, и запись строки упадет по индексу. Значение бессмысленно.
- Значение больше `--eplb-rebalance-num-iterations` при включенном EPLB отвергается ассертом на старте.

## Когда использовать

- Нагрузка резко неоднородна во времени, а перебалансировка редкая: короткий буфер (например, `--eplb-rebalance-num-iterations 2000 --expert-distribution-recorder-buffer-size 200`) заставит EPLB опираться на последние проходы, а не на среднее за весь период.
- Трафик редкий и батчи мелкие: длинный буфер устойчивее, но и период перебалансировки надо поднимать вместе с ним.
- Трогать не надо, если вы не меняли `--eplb-rebalance-num-iterations`: дефолт уже равен периоду, и это ровно то поведение, которое ожидает `EPLBManager`.

## Влияние на производительность и память

- **VRAM.** Линейно по значению: `buffer_size × num_layers × num_physical_experts × 4` байта на ранг. Для 61 слоя, 288 физических экспертов и буфера 1000 это около 67 МиБ; буфер выделяется целиком при старте рекордера, до захвата CUDA graph.
- **Latency.** Запись строки — одно присваивание в тензор на проход; от значения не зависит.
- **Дамп.** Свертка и `all_reduce` идут по всему буферу, поэтому длинный буфер немного удлиняет паузу перебалансировки; на фоне переноса весов это малая величина.
- `-1` дополнительно дает разовые всплески при удвоении емкости (аллокация нового тензора и копирование старого).

## Взаимодействие с другими аргументами

- `--eplb-rebalance-num-iterations`: источник дефолта и верхняя граница; проверяется ассертом в `EPLBManager`.
- `--expert-distribution-recorder-mode`: буфер существует только в режимах `stat` и `stat_approx`.
- `--enable-eplb`, `--expert-balancedness-report-mode` (≠ `off`): включают рекордер, после чего аргумент начинает что-то значить.
- `--ep-num-redundant-experts`: увеличивает `num_physical_experts` и тем самым ширину строки буфера.

## Типовые проблемы и диагностика

- `AssertionError: eplb_rebalance_num_iterations must be greater than expert_distribution_recorder_buffer_size` на старте — уменьшите буфер или увеличьте период.
- Неожиданный расход VRAM на старте при включенном EPLB — посчитайте буфер по формуле выше; при большом `--ep-num-redundant-experts` он растет вместе с числом физических экспертов.
- EPLB переставляет экспертов «мимо» текущей нагрузки — окно слишком длинное; уменьшите буфер.
- Значение после подстановки видно в дампе `server_args=` при старте; факт запуска менеджера — по строке `[EPLBManager] system started, will rebalance per <N> iterations.`

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --enable-eplb --eplb-rebalance-num-iterations 2000 --expert-distribution-recorder-buffer-size 200
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --expert-distribution-recorder-mode stat --expert-distribution-recorder-buffer-size -1
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
