---
schema: 1
engine: vllm
primaryName: "--cudagraph-metrics"
title: "--cudagraph-metrics"
summary: Раз в интервал печатает в лог таблицу «сколько токенов было, до скольких дополнено, каким режимом CUDA graph выполнено и как часто». Единственный штатный способ увидеть, сколько работы уходит в паддинг.
group: ObservabilityConfig
related:
  - --disable-log-stats
  - --cudagraph-capture-sizes
  - --max-cudagraph-capture-size
  - --enforce-eager
  - --compilation-config
  - --enable-logging-iteration-details
  - --max-num-seqs
---

# --cudagraph-metrics

## Кратко

CUDA graph работают на фиксированных размерах батча, поэтому реальный батч дополняется до ближайшего захваченного размера, и разница — это впустую посчитанные токены. Флаг делает эту разницу видимой: на каждом шаге фиксируется тройка «сырых токенов / дополненных токенов / режим выполнения», а раз в интервал логирования выводится таблица частот.

Данные идут только в лог, в `/metrics` они не попадают.

## Оригинальная справка

```text
Enable CUDA graph metrics (number of padded/unpadded tokens, runtime cudagraph
dispatch modes, and their observed frequencies at every logging interval).
```

## Паспорт аргумента

- Флаги: `--cudagraph-metrics`, `--no-cudagraph-metrics`
- Группа argparse: `ObservabilityConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: сбор в model runner идёт по самому флагу, но вывод существует только при живом `LoggingStatLogger`, а он создаётся лишь когда включена статистика (`--disable-log-stats` не задан), уровень логирования допускает `INFO` и `--api-server-count` равен 1 (иначе движок печатает `AsyncLLM created with api_server_count more than 1; disabling stats logging to avoid incomplete stats.`)
- Где объявлен: `vllm/config/observability.py:ObservabilityConfig.cudagraph_metrics`
- Этап применения: диспетчеризация CUDA graph на каждом шаге → планировщик (`SchedulerStats.cudagraph_stats`) → периодический вывод стат-логгера

## Что меняет в движке

**Сбор.** В `GPUModelRunner` после выбора режима и дескриптора батча создаётся `CUDAGraphStat(num_unpadded_tokens, num_padded_tokens, num_paddings, runtime_mode)`, где `num_paddings = num_padded_tokens − num_unpadded_tokens`, а `runtime_mode` — строковое представление `CUDAGraphMode` (`NONE`, `PIECEWISE`, `FULL`, …). Объект едет в `ModelRunnerOutput` и складывается в `SchedulerStats.cudagraph_stats`.

**Накопление.** `LoggingStatLogger.record()` вызывается на каждую пачку выходов и добавляет запись в список `CUDAGraphLogging.stats`. Список сбрасывается при каждом выводе.

**Вывод.** `CUDAGraphLogging.log()` строит `Counter` по уникальным тройкам и печатает Markdown-таблицу, предварённую заголовком с конфигурацией:

```text
**CUDAGraph Config Settings:**

- Mode: <cudagraph_mode>
- Capture sizes: <cudagraph_capture_sizes>

**CUDAGraph Stats:**

| Unpadded Tokens | Padded Tokens | Num Paddings | Runtime Mode | Count |
```

Строки отсортированы по убыванию частоты. Если за интервал не было ни одной записи, ничего не печатается.

Интервал вывода — общий периодический интервал стат-логгера, `VLLM_LOG_STATS_INTERVAL` (по умолчанию 10 секунд).

## Значения и формат

- Значение по умолчанию `false`; «не задан» и `--no-cudagraph-metrics` эквивалентны.
- Никаких градаций и прореживания нет.
- При `--enforce-eager` режим всегда `NONE` и паддинга нет — таблица будет состоять из строк с нулевым `Num Paddings` и не даст новой информации.
- С `--disable-log-stats` объект `CUDAGraphStat` всё равно создаётся на каждом шаге в model runner, но потребителя у него нет: `Scheduler.make_stats()` при выключенной статистике возвращает `None`. Это бессмысленная, хотя и дешёвая работа.

## Когда использовать

- Подбор `--cudagraph-capture-sizes`: таблица прямо показывает, какие реальные размеры батча встречаются и до чего они дополняются. Если самый частый размер дополняется вдвое, набор точек захвата подобран плохо.
- Проверка, что модель действительно исполняется графами, а не откатилась в eager: смотрите колонку `Runtime Mode`.
- Оценка накладных расходов паддинга под конкретной нагрузкой перед тем, как менять `--max-num-seqs` или режим компиляции.
- Не оставляйте включённым постоянно: таблица может занимать десятки строк на каждый интервал, если распределение размеров батча широкое.

## Влияние на производительность и память

- **CPU движка.** Создание маленького frozen-dataclass на шаг и `append` в список; при выводе — `Counter` по накопленному списку. На фоне forward пренебрежимо.
- **RAM хоста.** Список ограничен числом шагов за интервал: при 50 шагах/с и интервале 10 с это порядка 500 небольших объектов, которые затем освобождаются.
- **VRAM.** Не влияет: на захват графов и на их число флаг не влияет, он только наблюдает.
- **Диск.** Таблица за интервал; объём зависит от разнообразия троек, а не от числа запросов.

## Взаимодействие с другими аргументами

- `--disable-log-stats`: убирает вывод.
- `--cudagraph-capture-sizes`, `--max-cudagraph-capture-size`: то, что настраивают по этой таблице; их значения печатаются в заголовке таблицы.
- `--compilation-config`: содержит `cudagraph_mode`, который тоже печатается в заголовке.
- `--enforce-eager`: обнуляет смысл метрики.
- `--max-num-seqs`, `--max-num-batched-tokens`: определяют распределение реальных размеров батча.
- `--enable-logging-iteration-details`: даёт пошаговый состав батча; вместе видно, какие составы приводят к какому паддингу.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, таблицы в логе нет. **Причина:** `--disable-log-stats`, уровень логирования выше `INFO`, `--api-server-count > 1` либо простой движка. **Проверка:** наличие обычных периодических строк `Avg prompt throughput: ...`. **Лечение:** устранить соответствующую причину.
- **Симптом:** в колонке `Runtime Mode` всюду `NONE` при отсутствии `--enforce-eager`. **Причина:** CUDA graph отключены другими средствами (`cudagraph_mode` в `--compilation-config`, `TORCH_COMPILE_DISABLE=1`) либо батчи не попадают в захваченные размеры. **Проверка:** заголовок таблицы с фактическими `Mode` и `Capture sizes`. **Лечение:** привести конфигурацию компиляции в порядок.
- **Симптом:** `Num Paddings` сопоставим с `Unpadded Tokens` у самых частых строк. **Причина:** типичный размер батча далёк от ближайшей точки захвата. **Лечение:** добавить подходящие значения в `--cudagraph-capture-sizes`.
- **Симптом:** таблица занимает много места в логе. **Причина:** широкий разброс размеров батча. **Лечение:** выключить флаг после снятия наблюдения.
- **Подтверждение принятого значения:** появление блока `**CUDAGraph Config Settings:**` в логе.

## Примеры

```bash
vllm serve /models/Qwen3-4B --cudagraph-metrics --max-num-seqs 16
```

```bash
vllm serve /models/Qwen3-4B --cudagraph-metrics --cudagraph-capture-sizes 1 2 4 8 16 --max-num-seqs 16
```

## Источники

- `vllm/vllm/config/observability.py`
- `vllm/vllm/compilation/cuda_graph.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/envs.py`
