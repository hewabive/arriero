---
schema: 1
engine: sglang
primaryName: "--enable-expert-distribution-metrics"
title: "--enable-expert-distribution-metrics"
summary: Удаленный legacy-флаг: текущий argparse намеренно завершает запуск ошибкой. Для log/Prometheus balancedness используйте `--expert-balancedness-report-mode` с явным каналом вывода.
group: null
related:
  - --expert-balancedness-report-mode
  - --enable-metrics
  - --expert-distribution-recorder-mode
---

# --enable-expert-distribution-metrics

## Кратко

Флаг больше не включает сбор метрик и не является deprecated-алиасом. Он зарегистрирован с `DeprecatedAction(error_message=...)`, поэтому его присутствие немедленно вызывает ошибку argparse. Замена — `--expert-balancedness-report-mode server_log`, `prometheus` или `both`.

## Оригинальная справка

```text
Removed. Use --expert-balancedness-report-mode with one of: off, server_log, prometheus, both.
```

## Паспорт аргумента

- Флаги: `--enable-expert-distribution-metrics`
- Группа: `null` — ручная deprecated-регистрация вне namespace
- Тип значения: удаленный флаг без значения (`DeprecatedAction`)
- Значение по умолчанию: отсутствует
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: removed; любая передача флага завершает разбор CLI ошибкой
- Этап применения: argparse; до `ServerArgs.__post_init__` и загрузки модели выполнение не доходит

## Что меняет в движке

Ничего: `DeprecatedAction.__call__` получает `error_message` и вызывает `parser.error`. Старого поля `ServerArgs.enable_expert_distribution_metrics` больше нет, а сбор, автостарт recorder'а и выбор канала перенесены в `expert_balancedness_report_mode`.

## Значения и формат

Допустимого рабочего значения нет. Само наличие `--enable-expert-distribution-metrics` — ошибка. Это принципиально отличается от deprecated-флагов, которые печатают warning и переводятся в новое поле.

## Когда использовать

Никогда в новой или старой команде запуска. Мигрируйте по цели:

- прежние строки `[Expert Balancedness]` → `--expert-balancedness-report-mode server_log`;
- Prometheus → `--expert-balancedness-report-mode prometheus --enable-metrics`;
- оба канала → `--expert-balancedness-report-mode both --enable-metrics`.

## Влияние на производительность и память

Флаг завершает процесс до инициализации модели, поэтому runtime-расхода нет. Накладные расходы актуального механизма зависят от выбранного report mode.

## Взаимодействие с другими аргументами

- `--expert-balancedness-report-mode` полностью заменяет legacy-флаг и выбирает канал.
- `--enable-metrics` нужен для Prometheus-режима, но не делает удаленный флаг рабочим.
- `--expert-distribution-recorder-mode` актуальный report mode при необходимости автоматически ставит в `stat`.
- Переменная `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC` также удалена и вызывает отдельный `ValueError`.

## Типовые проблемы и диагностика

Симптом однозначен: argparse печатает `--enable-expert-distribution-metrics is no longer supported. Use --expert-balancedness-report-mode ...` и завершает запуск ненулевым кодом. Удалите флаг и выберите один из новых режимов.

## Примеры

Рекомендуемая замена для серверного лога:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --expert-balancedness-report-mode server_log
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
