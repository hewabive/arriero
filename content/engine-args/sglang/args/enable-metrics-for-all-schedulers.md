---
schema: 1
engine: sglang
primaryName: "--enable-metrics-for-all-schedulers"
title: "--enable-metrics-for-all-schedulers"
summary: Разрешает писать метрики не только рангу `attn_tp_rank == 0`, а всем scheduler-процессам. Нужен там, где DP attention делает ранги неравнозначными; без `--enable-metrics` инертен.
group: observability
related:
  - --enable-metrics
  - --enable-dp-attention
  - --dp-size
  - --tp-size
  - --pp-size
  - --extra-metric-labels
  - --decode-log-interval
---

# --enable-metrics-for-all-schedulers

## Кратко

По умолчанию запросные метрики scheduler'а пишет ровно один ранг — тот, у которого `attn_tp_rank == 0`. Все остальные TP-ранги считают то же самое, но никуда не отправляют. Флаг снимает это ограничение: коллектор появляется в каждом scheduler-процессе, и в `/metrics` возникают отдельные серии, различающиеся меткой `tp_rank` (и `dp_rank`, если DP включен). Смысл он имеет ровно там, где ранги перестали быть копиями друг друга — при DP attention каждый DP-ранг ведет свою очередь и свой KV-пул, и картина «всё пришло с ранга 0» становится ложной.

## Оригинальная справка

```text
Enable --enable-metrics-for-all-schedulers when you want schedulers on all TP ranks (not just TP 0) to record request metrics separately. This is especially useful when dp_attention is enabled, as otherwise all metrics appear to come from TP 0.
```

## Паспорт аргумента

- Флаги: `--enable-metrics-for-all-schedulers`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — значения не принимает
- Допустимые значения: `choices` нет; парной формы `--no-*` не существует
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным; никакой `_handle_*` его не трогает. Но действует он только в связке — без `--enable-metrics` не меняет ничего
- Где объявлен: `ServerArgs.enable_metrics_for_all_schedulers`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `Scheduler` (создание IPC-каналов и `SchedulerMetricsCollectorContext`) в каждом scheduler-процессе

## Что меняет в движке

Значение читается в двух местах, и оба вычисляют одно и то же логическое выражение.

`SchedulerMetricsCollectorContext.init_new` (`sglang/python/sglang/srt/observability/metrics_collector.py`):

```python
is_stats_logging_rank = ps.attn_tp_rank == 0
current_scheduler_metrics_enabled = enable_metrics and (
    is_stats_logging_rank or server_args.enable_metrics_for_all_schedulers
)
```

`SchedulerIpcChannels.create` (`sglang/python/sglang/srt/managers/scheduler_components/ipc_channels.py`) по тому же условию решает, создавать ли в этом процессе PUSH-сокет `metrics_ipc_name`.

Дальше `current_scheduler_metrics_enabled` — единственный гейт вокруг всех вызовов `self.metrics_collector.*` в `SchedulerMetricsReporter`: `increment_realtime_tokens` на каждой итерации, обновление `SchedulerStats` (`token_usage`, `num_running_reqs`, `num_queue_reqs`, `cache_hit_rate`, `gen_throughput`, retract-счетчики) раз в `--decode-log-interval`.

Важно, что это **не** то же самое, что печать строк `Decode batch, …` и `Prefill batch, …` в лог: логированием управляет отдельный флаг `is_stats_logging_rank`, который равен `attn_tp_rank == 0` всегда и от этого аргумента не зависит. То есть флаг влияет только на Prometheus, а лог остается однораноговым.

Обратите внимание: сам объект `SchedulerMetricsCollector` создается на **каждом** ранге, как только задан `--enable-metrics` (условие создания — просто `if enable_metrics`). Флаг определяет, будут ли в него что-то писать.

## Значения и формат

- Флаг без значения. `--enable-metrics-for-all-schedulers true` argparse не примет.
- Отключить обратно после старта нельзя.
- При `--tp-size 1` без DP флаг бессмыслен: ранг 0 — единственный.
- Условие «пишущего» ранга — `attn_tp_rank`, а не `tp_rank`. При включенном DP attention `attn_tp_rank` считается внутри attention-TP-группы, поэтому нулевых рангов оказывается несколько, по одному на DP-группу, и без флага в метрики попадает первая группа каждого DP-ранга.

## Когда использовать

- При `--enable-dp-attention`: без флага метрики очередей и KV-пула отражают состояние одной группы, а балансировка между DP-рангами остается невидимой. Именно этот сценарий назван в справке аргумента.
- Когда нужно поймать перекос между рангами: неравномерный `token_usage` или `num_queue_reqs` по `tp_rank` — прямой признак того, что запросы распределяются неравномерно.
- Не включать на обычном симметричном TP: ранги делают идентичную работу, метрики продублируются `tp_size` раз, а дашборды придется переписывать под агрегацию `sum by (…)`. Кроме шума и роста стоимости скрейпа это ничего не даст.
- Не включать на однокарточном профиле KTransformers: там `--tp-size` обычно 1.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: число серий в `/metrics` умножается примерно на число scheduler-процессов, и во столько же раз растет размер mmap-файлов в `PROMETHEUS_MULTIPROC_DIR`. Для 8 рангов это по-прежнему единицы-десятки мегабайт.
- Latency и throughput: на каждом дополнительном ранге появляются те же вызовы коллектора, что были на ранге 0 — арифметика над несколькими десятками gauge'ев раз в `--decode-log-interval` итераций. На фоне forward это неизмеримо.
- Заметная часть цены — на стороне скрейпа: `MultiProcessCollector` при каждом обращении к `/metrics` читает все mmap-файлы каталога, и их стало в `tp_size` раз больше.

## Взаимодействие с другими аргументами

- `--enable-metrics`: обязательное условие. Без него выражение `enable_metrics and (...)` ложно на всех рангах, и флаг не делает ничего.
- `--enable-dp-attention` / `--dp-size`: основной сценарий применения; метка `dp_rank` добавляется в метки коллектора только когда DP-ранг определен.
- `--tp-size` / `--pp-size`: определяют, сколько появится дополнительных наборов серий. Метки `tp_rank` и `pp_rank` присутствуют всегда, но без флага заполнены только для пишущего ранга.
- `--extra-metric-labels`: добавляемые метки применяются ко всем рангам одинаково и перемножаются с `tp_rank`/`pp_rank` по кардинальности.
- `--decode-log-interval`: период обновления «тяжелых» метрик — теперь на каждом ранге.

## Типовые проблемы и диагностика

- В `/metrics` серии scheduler'а есть только с `tp_rank="0"` при `--tp-size 4` — это поведение по умолчанию, флаг не задан. Проверьте `enable_metrics_for_all_schedulers=True` в итоговом дампе `server_args=` при старте.
- Значения в Grafana внезапно «удвоились» после включения флага — панель суммирует серии по всем `tp_rank`. Для gauge'ев вроде `sglang:token_usage` нужен `avg`/`max by (dp_rank)`, а не `sum`.
- Флаг включен, но новых серий не появилось — почти всегда забыт `--enable-metrics`; проверяется тем же дампом `server_args=`.
- Метрики появились на всех рангах, а строки `Decode batch, …` в логе по-прежнему только от одного — так и задумано, лог управляется `is_stats_logging_rank`.
- **В arriero:** менеджер `/metrics` не читает вообще (probe инстанса `ktransformers` ограничен `/health` и `/v1/models`), поэтому флаг на состояние инстанса в UI не влияет. Он полезен только при внешнем Prometheus.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 4 --enable-dp-attention --dp-size 4 --enable-metrics --enable-metrics-for-all-schedulers
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 2 --enable-metrics --enable-metrics-for-all-schedulers --decode-log-interval 20
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/scheduler_components/ipc_channels.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/docs/docs/references/production_metrics.mdx`
