---
schema: 1
engine: sglang
primaryName: "--eplb-rebalance-num-iterations"
title: "--eplb-rebalance-num-iterations"
summary: Период перебалансировки EPLB, измеряемый в forward-проходах (батчах), а не в запросах. Он же по умолчанию задает глубину окна статистики и не может быть меньше этой глубины.
group: exec.moe
related:
  - --enable-eplb
  - --expert-distribution-recorder-buffer-size
  - --eplb-rebalance-layers-per-chunk
  - --eplb-min-rebalancing-utilization-threshold
  - --eplb-algorithm
---

# --eplb-rebalance-num-iterations

## Кратко

`EPLBManager` устроен как генератор: он отдает управление `--eplb-rebalance-num-iterations` раз, а на следующем вызове запускает `rebalance()`. Каждый вызов — это конец одного forward-прохода model runner, то есть одного батча. Ни число запросов, ни число токенов в счет не входят, поэтому реальный период в секундах зависит от того, насколько крупные батчи собирает планировщик.

## Оригинальная справка

```text
Number of iterations to automatically trigger a EPLB re-balance.
```

## Паспорт аргумента

- Флаги: `--eplb-rebalance-num-iterations`
- Группа: `exec.moe`
- Тип значения: int (число forward-проходов)
- Допустимые значения: `choices` нет; ограничение только относительное — не меньше `--expert-distribution-recorder-buffer-size`
- Значение по умолчанию: `1000`
- Эффективное значение: не переопределяется, но само становится дефолтом для `--expert-distribution-recorder-buffer-size` (`_handle_expert_distribution_metrics`)
- Где объявлен: `ServerArgs.eplb_rebalance_num_iterations`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (как дефолт буфера) → конструктор `EPLBManager` → конец каждого forward-прохода

## Что меняет в движке

В `sglang/python/sglang/srt/eplb/eplb_manager.py` значение читается один раз в конструкторе и определяет цикл:

```text
while True:
    for _ in range(rebalance_num_iterations):
        yield
    yield from self.rebalance()
```

`on_forward_pass_end()` вызывается из `ModelRunner.forward` после каждого прохода, и он двигает этот генератор на один шаг. Отсюда единица измерения.

Там же в конструкторе стоит единственная проверка на согласованность:

```text
assert eplb_rebalance_num_iterations >= expert_distribution_recorder_buffer_size
```

Смысл — не дать окну статистики перекрыть предыдущий период: буфер сбрасывается при каждом дампе, и если бы он был длиннее периода, часть строк осталась бы от предыдущей раскладки экспертов.

Генератор пересоздается (`reset_generator`) в нескольких местах: при восстановлении выпавших рангов elastic EP, при перезагрузке весов и при снятии/установке блокировки перебалансировки (`disable_rebalance`/`enable_rebalance`). После пересоздания отсчет начинается заново, то есть период — не жесткий таймер, а счетчик с возможным сбросом.

## Значения и формат

- Целое число проходов. `1000` при типичной длине decode-шага в единицы миллисекунд — это порядка минут, а не часов.
- Малые значения (десятки) означают, что окно статистики тоже придется сделать малым, иначе ассерт; а короткое окно дает шумную раскладку.
- `0` формально примет argparse: тогда `range(0)` не отдаст ни одного `yield`, и перебалансировка будет пытаться идти на каждом проходе. Практически это неработоспособный режим — перенос весов на каждом шаге.
- Отрицательные значения ведут себя как `0` (`range` пуст).
- Верхней границы нет; очень большое значение фактически отключает автоматическую перебалансировку, оставляя только стартовую раскладку.

## Когда использовать

- Нагрузка меняет профиль в течение дня (разные модели запросов, разная длина контекста): период стоит уменьшить, но одновременно уменьшить и `--expert-distribution-recorder-buffer-size`.
- Нагрузка ровная: увеличьте период — каждая перебалансировка стоит паузы на перенос весов, и на стабильном трафике она не окупается.
- Не подбирайте период «в запросах»: при батчинге один проход обслуживает десятки запросов сразу, и пересчет в запросы неустойчив.
- Не уменьшайте период, если у вас нет метрик balancedness: без `--enable-expert-distribution-metrics` (строки `[Expert Balancedness]` в логе) вы не увидите, стало лучше или нет.

## Влияние на производительность и память

- **Пауза.** Каждая перебалансировка останавливает продвижение forward-проходов на время переноса весов экспертов. Чем меньше период, тем чаще эта пауза; дробить ее можно `--eplb-rebalance-layers-per-chunk`.
- **VRAM.** Прямого влияния нет; косвенное — через дефолт `--expert-distribution-recorder-buffer-size`, который равен этому значению и определяет размер кольцевого буфера рекордера.
- **Throughput.** Слишком частая перебалансировка съедает выигрыш от выравнивания; слишком редкая — не догоняет дрейф нагрузки.
- Длительность перебалансировки печатается строкой `[EPLBManager] rebalance end time=<N>s`, но только когда `--eplb-rebalance-layers-per-chunk` не задан.

## Взаимодействие с другими аргументами

- `--expert-distribution-recorder-buffer-size`: получает это значение как дефолт и не может его превышать.
- `--enable-eplb`: без него аргумент не читается вовсе.
- `--eplb-rebalance-layers-per-chunk`: определяет, как размазана пауза внутри одного срабатывания.
- `--eplb-min-rebalancing-utilization-threshold`: срабатывание может быть пропущено по порогу — период при этом не сбрасывается, следующая попытка будет через тот же интервал.
- `--eplb-algorithm`: определяет, что именно считается в момент срабатывания.

## Типовые проблемы и диагностика

- `AssertionError: eplb_rebalance_num_iterations must be greater than expert_distribution_recorder_buffer_size` — период меньше окна; увеличьте период либо явно уменьшите буфер.
- Перебалансировка не происходит вообще — проверьте `[EPLBManager] system started, will rebalance per <N> iterations.` (менеджер запущен), затем `[EPLBManager] rebalance start`. Если старт есть, а `rebalance start` нет — либо период еще не набран, либо срабатывание пропускается по порогу (`Skipped ep rebalancing: ...`), либо перебалансировка выключена (`[EPLBManager] rebalance disabled: ...` на уровне debug).
- Периодические просадки latency с ровным интервалом — это и есть срабатывания; увеличьте период или включите дробление по слоям.
- Реальный период в секундах измеряйте по меткам времени строк `[EPLBManager] rebalance start`, а не пересчетом из запросов.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --enable-eplb --eplb-rebalance-num-iterations 3000
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --enable-eplb --eplb-rebalance-num-iterations 200 --expert-distribution-recorder-buffer-size 200 --eplb-rebalance-layers-per-chunk 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
