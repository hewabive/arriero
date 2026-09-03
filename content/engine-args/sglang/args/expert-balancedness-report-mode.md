---
schema: 1
engine: sglang
primaryName: "--expert-balancedness-report-mode"
title: "--expert-balancedness-report-mode"
summary: Управляет сбором и каналом выдачи balancedness экспертов MoE: отключено, server log, Prometheus или оба канала. Заменяет удаленный `--enable-expert-distribution-metrics` и старую переменную окружения.
group: exec.moe
related:
  - --expert-distribution-recorder-mode
  - --expert-distribution-recorder-buffer-size
  - --eplb-rebalance-num-iterations
  - --eplb-min-rebalancing-utilization-threshold
  - --enable-metrics
  - --ep-size
---

# --expert-balancedness-report-mode

## Кратко

Balancedness показывает, насколько равномерно MoE-токены распределились по GPU expert-parallel группы: `1.0` означает ровную загрузку, меньшее значение — перекос. Аргумент одновременно включает расчет и выбирает, куда отправлять результат: в лог сервера, Prometheus или оба канала.

## Оригинальная справка

```text
Where to report expert balancedness. Options: off, server_log, prometheus, both.
```

## Паспорт аргумента

- Флаги: `--expert-balancedness-report-mode`
- Группа: `exec.moe`
- Тип значения: enum
- Допустимые значения: `off`, `server_log`, `prometheus`, `both`
- Значение по умолчанию: `off`
- Где объявлен: `ServerArgs.expert_balancedness_report_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: `__post_init__` → инициализация expert distribution recorder → каждый forward pass → log/metrics reporter

## Что меняет в движке

Любое значение кроме `off` заставляет `_handle_expert_distribution_metrics` подставить `expert_distribution_recorder_mode="stat"`, если режим не задан, и задать buffer size (из `--eplb-rebalance-num-iterations` либо `1000`). Рекордер стартует автоматически.

На rank 0 аккумулятор суммирует физический dispatch по GPU и вычисляет среднюю utilization rate. `server_log` печатает `[Expert Balancedness]` с текущим значением и скользящими средними. `prometheus` передает значение в metrics reporter и при включенных метриках обновляет Summary `sglang:eplb_balancedness` с label `forward_mode`. `both` делает оба действия.

## Значения и формат

- `off` — сбор balancedness отключен.
- `server_log` — строки в серверном логе.
- `prometheus` — только Prometheus; нужен `--enable-metrics`, иначе экспортировать некуда.
- `both` — лог и Prometheus одновременно.

## Когда использовать

`server_log` удобен для короткой диагностики, `prometheus` — для постоянной эксплуатации и алертов, `both` — при расследовании. На dense-модели метрика не имеет смысла; используйте ее на MoE с корректно построенной expert location metadata.

## Влияние на производительность и память

Включение добавляет reduce счетчиков распределения на каждом forward pass и небольшую историю в памяти. `server_log` создает строку на каждый проход и при высокой нагрузке заметно увеличивает объем лога. На размер весов и KV cache не влияет.

## Взаимодействие с другими аргументами

- `--enable-metrics` обязателен для значений `prometheus` и `both`, если нужен фактический Prometheus-выход.
- `--expert-distribution-recorder-mode` сохраняет явное значение; иначе автоматически становится `stat`.
- `--expert-distribution-recorder-buffer-size` по умолчанию наследует `--eplb-rebalance-num-iterations`, затем fallback `1000`.
- `--eplb-min-rebalancing-utilization-threshold` использует историю balancedness для решения о rebalance.
- Старый `--enable-expert-distribution-metrics` теперь завершает argparse ошибкой и не является алиасом.

## Типовые проблемы и диагностика

- При `prometheus` нет `sglang:eplb_balancedness` — проверьте `--enable-metrics` и endpoint метрик.
- Ошибка о `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC` — переменная удалена; перенесите выбор канала в этот аргумент.
- Подтверждение лог-режима: строка `ExpertDistributionRecorder auto start record since expert_balancedness_report_mode=...`, затем `[Expert Balancedness] ...`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --expert-balancedness-report-mode server_log
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --enable-metrics --expert-balancedness-report-mode prometheus
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`

