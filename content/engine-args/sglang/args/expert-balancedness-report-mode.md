---
schema: 1
engine: sglang
primaryName: "--expert-balancedness-report-mode"
title: "--expert-balancedness-report-mode"
summary: Куда отдавать метрику сбалансированности экспертов MoE при экспертном параллелизме — в серверный лог, в Prometheus, в оба места или никуда. Единственный переключатель EPLB-balancedness-отчетности; заменил удаленный флаг `--enable-expert-distribution-metrics` и переменную `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC`.
group: exec.moe
related:
  - --expert-distribution-recorder-mode
  - --expert-distribution-recorder-buffer-size
  - --enable-metrics
  - --enable-eplb
  - --eplb-rebalance-num-iterations
  - --eplb-min-rebalancing-utilization-threshold
  - --enable-expert-distribution-metrics
  - --ep-size
---

# --expert-balancedness-report-mode

## Кратко

Сбалансированность (balancedness) — доля средней загрузки GPU относительно максимальной по всем рангам экспертного параллелизма: 1.0 означает, что токены разошлись по экспертам равномерно, чем ниже — тем сильнее один ранг стал бутылочным горлышком MoE-слоев. Этот аргумент включает вычисление метрики на каждом forward-проходе и выбирает канал доставки: строка `[Expert Balancedness]` в серверном логе, Prometheus-метрика `sglang:eplb_balancedness`, оба канала или ничего. Любое значение, кроме `off`, автоматически поднимает рекордер распределения экспертов в режиме `stat` и сразу стартует запись — отдельно включать `--expert-distribution-recorder-mode` не нужно.

## Оригинальная справка

```text
Where to report expert balancedness. Options: off, server_log, prometheus, both.
```

## Паспорт аргумента

- Флаги: `--expert-balancedness-report-mode`
- Группа: `exec.moe`
- Тип значения: перечисление
- Допустимые значения: `off`, `server_log`, `prometheus`, `both`
- Значение по умолчанию: `off` — метрика не считается вовсе
- Где объявлен: `ServerArgs.expert_balancedness_report_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но новый — добавлен в upstream 2026-08-16 (PR #34998) вместо удаленного `--enable-expert-distribution-metrics`; в закрепленной сборке `sglang-kt` может отсутствовать, проверяется по `python -m sglang.launch_server --help`
- Этап применения: `__post_init__` (`_handle_expert_distribution_metrics` подставляет режим рекордера) → инициализация рекордера в model runner (автостарт записи) → каждый forward-проход (аккумулятор считает метрику) → серверный лог scheduler и/или Prometheus-эндпоинт

## Что меняет в движке

Значение читается тремя предикатами `ServerArgs`: `should_report_expert_balancedness()` (`!= "off"`), `should_log_expert_balancedness_to_server_log()` (`server_log`/`both`), `should_export_expert_balancedness_to_prometheus()` (`prometheus`/`both`).

При любом значении, кроме `off`:

- `_handle_expert_distribution_metrics` в `__post_init__` подставляет `--expert-distribution-recorder-mode stat`, если режим рекордера не задан, а `--expert-distribution-recorder-buffer-size` при отсутствии берет равным `--eplb-rebalance-num-iterations` (по умолчанию 1000).
- `_ExpertDistributionRecorderReal` при инициализации сам вызывает `start_record()` и пишет в лог `ExpertDistributionRecorder auto start record since expert_balancedness_report_mode=...` — HTTP-вызов `/start_expert_distribution_record` не нужен.
- `_UtilizationRateAccumulatorMixin` на каждом forward-проходе собирает `gpu_physical_count` по слоям, делает `torch.distributed.reduce` на ранг 0 и считает среднюю утилизацию; результат уезжает в `GenerationBatchResult.expert_distribution_metrics`.

Дальше каналы расходятся в `SchedulerMetricsReporter.log_batch_result_stats`:

- `server_log`/`both` — строка вида `[Expert Balancedness] forward_pass_id=... current_pass_balancedness=0.812 last_10_average_balancedness=... last_100_average_balancedness=... last_1000_average_balancedness=... gpu_physical_count_sum=...` на каждый проход; окна 10/100/1000 зашиты в `EPLB_BALANCEDNESS_WINDOW_SIZES`.
- `prometheus`/`both` — Prometheus-`Summary` `sglang:eplb_balancedness` с лейблом `forward_mode`; она регистрируется только на ранге с `moe_ep_rank == 0` и **только при включенном `--enable-metrics`** — без него prometheus-ветка молча не делает ничего.

Побочный эффект, важный для EPLB: `--eplb-min-rebalancing-utilization-threshold` ниже 1.0 работает только когда этот аргумент не `off` — при `off` `_get_global_average_utilization_rate` возвращает `None`, и `EPLBManager._check_rebalance_needed` считает перебалансировку всегда нужной, порог тихо игнорируется.

## Значения и формат

- `off` — метрика не вычисляется, рекордер этим аргументом не поднимается; поведение как до появления флага без старых включателей.
- `server_log` — лог-строка на каждый forward-проход, Prometheus не трогается.
- `prometheus` — только `sglang:eplb_balancedness`, требует `--enable-metrics`; серверный лог чистый.
- `both` — оба канала одновременно.

Переменная окружения `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC` удалена: если она есть в окружении, `__post_init__` падает с `ValueError: SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC is no longer supported...` — уберите ее из окружения инстанса.

## Когда использовать

- Диагностика деградации MoE-модели под экспертным параллелизмом: разово включите `server_log` и посмотрите, не проседает ли balancedness на вашей нагрузке.
- Постоянный мониторинг прод-инстанса: `prometheus` вместе с `--enable-metrics` — метрика уходит в существующий скрейп `/metrics`, лог не засоряется.
- Обязателен (не `off`), если вы полагаетесь на `--eplb-min-rebalancing-utilization-threshold` — иначе порог не действует.
- На плотных (не-MoE) моделях не включайте: рабочему рекордеру нужна `ExpertLocationMetadata`, модель без `get_model_config_for_expert_location` уронит старт ассертом.

## Влияние на производительность и память

- **VRAM.** Автоподстановка `stat`-рекордера означает кольцевой буфер `(buffer_size, num_layers, num_physical_experts)` int32 на каждом ранге; при дефолтном буфере 1000 на большой MoE-модели это десятки МиБ. Буфер выделяется при старте — учитывайте его в memory-draw инстанса arriero (`docs/RESOURCE_MANAGEMENT.md`).
- **Latency.** На каждый forward-проход добавляются подсчет `gpu_physical_count`, один `torch.distributed.reduce` на ранг 0 и, в реализации логирования, `.item()`-синхронизации GPU→CPU в scheduler; история для лога намеренно ведется после уже существующей асинхронной копии результата, чтобы не синхронизировать поток модели на каждый токен. Накладные расходы малы, но не нулевые — это не бесплатный флаг.
- **Объем лога.** `server_log`/`both` пишут строку на каждый forward-проход; при высоком decode-throughput сырой лог инстанса (`runtime/logs/` в arriero) растет быстро.

## Взаимодействие с другими аргументами

- `--expert-distribution-recorder-mode`: не задан — подставится `stat`; заданный вручную `per_pass`/`per_token` вместе с балансировкой EPLB ломает перебалансировку (дамп только в файл).
- `--expert-distribution-recorder-buffer-size`: не задан — берется из `--eplb-rebalance-num-iterations` (дефолт 1000).
- `--enable-metrics`: без него режимы `prometheus`/`both` не экспортируют ничего — ошибки нет, метрика просто не регистрируется.
- `--enable-eplb`: независимый флаг; EPLB сам поднимает рекордер, а этот аргумент лишь добавляет отчетность. Но порог `--eplb-min-rebalancing-utilization-threshold` действует только при отчетности не `off`.
- `--ep-size`: метрика имеет смысл при экспертном параллелизме — balancedness усредняется по `ep_size` рангов.
- `--enable-expert-distribution-metrics`: удаленный предшественник (см. ниже), одновременно указать нельзя — старый флаг сразу роняет разбор CLI.

## Типовые проблемы и диагностика

- Старт с `--enable-expert-distribution-metrics` завершается ошибкой argparse `--enable-expert-distribution-metrics is no longer supported. Use --expert-balancedness-report-mode with one of: off, server_log, prometheus, both.` — флаг зарегистрирован как `DeprecatedAction` с `error_message`, который вызывает `parser.error(...)` (жесткий отказ, а не предупреждение; `_handle_deprecated_args` тут не участвует). Раньше он включал примерно то, что сейчас дает `server_log`, а Prometheus-часть включалась переменной `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC` — теперь оба пути слиты в это перечисление.
- `ValueError: SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC is no longer supported...` при старте — переменная осталась в окружении; удалите ее.
- Включили `prometheus`, но `sglang:eplb_balancedness` нет в `/metrics` — проверьте `--enable-metrics` и что скрейпите ранг с `moe_ep_rank == 0`.
- `ExpertLocationMetadata is required for expert distribution recording` на старте — модель не поддерживает рекордер распределения экспертов; для нее аргумент неприменим.
- Что аргумент принят, видно по строке автостарта `ExpertDistributionRecorder auto start record since expert_balancedness_report_mode=...` и по дампу `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

Разовая диагностика балансировки в серверном логе:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --expert-balancedness-report-mode server_log
```

Постоянный мониторинг через Prometheus вместе с EPLB и порогом перебалансировки:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --enable-eplb --eplb-min-rebalancing-utilization-threshold 0.8 --enable-metrics --expert-balancedness-report-mode prometheus
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- Upstream PR: <https://github.com/sgl-project/sglang/pull/34998> (commit `f61f584347`, "Add explicit EPLB balancedness reporting modes")
- arriero: `docs/RESOURCE_MANAGEMENT.md` (учет memory-draw инстанса)
