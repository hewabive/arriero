---
schema: 1
engine: sglang
primaryName: "--enable-expert-distribution-metrics"
title: "--enable-expert-distribution-metrics"
summary: Включает наблюдаемость balancedness экспертов MoE при expert parallelism — рекордер распределения экспертов автостартует, ранг 0 агрегирует счетчики диспатча каждый forward pass и пишет строки `[Expert Balancedness]` в лог (или Prometheus-метрику при выставленной переменной окружения).
group: exec.moe
related:
  - --expert-distribution-recorder-mode
  - --expert-distribution-recorder-buffer-size
  - --eplb-rebalance-num-iterations
  - --eplb-min-rebalancing-utilization-threshold
  - --enable-eplb
  - --enable-metrics
  - --ep-size
---

# --enable-expert-distribution-metrics

## Кратко

Флаг включает мониторинг равномерности загрузки экспертов MoE-модели по GPU при expert parallelism. С ним рекордер распределения экспертов стартует автоматически, а ранг 0 на каждом forward pass'е суммирует, сколько токенов ушло на каждый GPU, и считает утилизацию `mean/max` — «balancedness» (1.0 — идеально ровно, чем ниже, тем сильнее перекос). Результат по умолчанию уходит строками `[Expert Balancedness]` в лог; с переменной окружения `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1` и `--enable-metrics` вместо лога публикуется Prometheus-метрика `sglang:eplb_balancedness`.

## Оригинальная справка

```text
Enable logging metrics for expert balancedness
```

## Паспорт аргумента

- Флаги: `--enable-expert-distribution-metrics`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`, парного `--no-*` нет)
- Допустимые значения: наличие флага
- Значение по умолчанию: `False`
- Эффективное значение: сам флаг не переписывается, но тянет за собой соседние поля: `_handle_expert_distribution_metrics` в `__post_init__` подставляет `expert_distribution_recorder_mode = "stat"` (если режим не задан) и доопределяет `expert_distribution_recorder_buffer_size` из `--eplb-rebalance-num-iterations`
- Где объявлен: `ServerArgs.enable_expert_distribution_metrics`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → инициализация `ExpertDistributionRecorder` в воркерах → каждый forward pass

## Что меняет в движке

Три звена, все в `sglang/python/sglang/srt/eplb/expert_distribution.py`:

1. **Автостарт рекордера.** Реальный рекордер создается, когда `expert_distribution_recorder_mode` не `None`, — а флаг как раз подставляет режим `stat`, если тот не задан. В `_ExpertDistributionRecorderReal.__init__` при включенном флаге запись стартует сразу, с info-строкой `ExpertDistributionRecorder auto start record since enable_expert_distribution_metrics` — отдельный вызов `/start_expert_distribution_record` не нужен.
2. **Пер-pass агрегация.** `_UtilizationRateAccumulatorMixin` при включенном флаге заводит скользящие окна на 10/100/1000 проходов и на каждом forward pass'е делает `torch.distributed.reduce` счетчиков физического диспатча на ранг 0, где считается `mean(mean/max)` по слоям.
3. **Вывод.** По умолчанию ранг 0 печатает на каждый проход строку `[Expert Balancedness] forward_pass_id=… current_pass_balancedness=… last_10_average_balancedness=… last_100_… last_1000_… gpu_physical_count_sum=…`. С `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1` вместо лога значение уезжает в `GenerationBatchResult` и, если включен `--enable-metrics`, публикуется Prometheus-summary `sglang:eplb_balancedness` (лейбл `forward_mode`; регистрируется только на `moe_ep_rank == 0` — `sglang/python/sglang/srt/observability/metrics_collector.py`).

Та же история окон питает EPLB: `EPLBManager` перед ребалансировкой сравнивает среднюю утилизацию окна с `--eplb-min-rebalancing-utilization-threshold` и пропускает ребалансировку со строкой `[EPLBManager] Skipped ep rebalancing: current GPU utilization … > minimum rebalance threshold …` (`sglang/python/sglang/srt/eplb/eplb_manager.py`). В метрик-режиме история наполняется, только если порог отличен от `1.0`.

## Значения и формат

Флаг без значения; обратной половины `--no-...` нет. Все настройки формата вывода — через переменную окружения `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC` и `--enable-metrics`, не через сам флаг.

## Когда использовать

- Диагностика перекоса экспертов на EP-развертывании (DeepSeek-класс моделей с `--ep-size > 1`): понять, оправдан ли EPLB, до его включения.
- Вместе с `--enable-eplb` и `--eplb-min-rebalancing-utilization-threshold < 1.0` — чтобы менеджер пропускал ребалансировки, когда загрузка и так ровная.
- В постоянной эксплуатации — только в метрик-режиме (`SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1` + `--enable-metrics`): строка в лог на каждый forward pass при высоком трафике превращается в шум.
- На плотных (не-MoE) моделях бессмысленен; рекордеру нужна модель с поддержкой expert location metadata — иначе старт упадет с assert'ом о `ExpertLocationMetadata`.

## Влияние на производительность и память

- Каждый forward pass получает коллективную операцию `reduce` по счетчикам диспатча и, в лог-режиме, синхронизацию GPU→CPU (`.item()`) на ранге 0 — на быстрых декодах это измеримый, хотя и небольшой, накладной расход.
- Включенный рекордер (режим `stat`) накапливает счетчики в circular buffer размером `--expert-distribution-recorder-buffer-size` (по умолчанию — значение `--eplb-rebalance-num-iterations`, т.е. 1000 проходов) — расход памяти небольшой и фиксированный.
- В лог-режиме основная цена — объем лога: одна строка на forward pass с ранга 0.
- VRAM и размер KV-пула не затрагиваются.

## Взаимодействие с другими аргументами

- `--expert-distribution-recorder-mode`: флаг подставляет `stat`, только если режим не задан явно; явный режим сохраняется.
- `--expert-distribution-recorder-buffer-size`: не задан — берется из `--eplb-rebalance-num-iterations` (по умолчанию 1000).
- `--eplb-min-rebalancing-utilization-threshold`: потребитель истории balancedness; при значении `1.0` в метрик-режиме история не ведется.
- `--enable-eplb`: сам флаг ребалансировку не включает — он только дает данные и гейт для нее.
- `--enable-metrics`: обязателен для Prometheus-выхода; без него `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1` просто отключит лог-строки, не дав метрики.
- `--ep-size`: определяет число GPU, по которым считается равномерность.

## Типовые проблемы и диагностика

- Подтверждение работы: info-строка `ExpertDistributionRecorder auto start record since enable_expert_distribution_metrics` при старте, затем строки `[Expert Balancedness] …` с ранга 0.
- Флаг задан, а строк нет: проверьте, не выставлен ли `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1` — тогда вывод идет в метрику `sglang:eplb_balancedness`, и без `--enable-metrics` не идет никуда.
- `AssertionError` про `ExpertLocationMetadata` при старте — модель не поддерживает запись распределения экспертов (нет `get_model_config_for_expert_location`); флаг применим только к MoE-моделям с EP.
- Значение, как его принял движок, — `enable_expert_distribution_metrics=True` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --enable-expert-distribution-metrics
```

```bash
SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1 python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --enable-expert-distribution-metrics --enable-metrics
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/environ.py`
