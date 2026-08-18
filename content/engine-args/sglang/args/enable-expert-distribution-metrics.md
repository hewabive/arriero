---
schema: 1
engine: sglang
primaryName: "--enable-expert-distribution-metrics"
title: "--enable-expert-distribution-metrics"
summary: Удаленный флаг метрик balancedness экспертов. С PR #34998 регистрируется только ради понятной ошибки — передача флага валит запуск с указанием замены `--expert-balancedness-report-mode`.
group: null
related:
  - --expert-balancedness-report-mode
  - --expert-distribution-recorder-mode
  - --eplb-min-rebalancing-utilization-threshold
  - --enable-eplb
  - --enable-metrics
---

# --enable-expert-distribution-metrics

## Кратко

Флаг удален в PR #34998 и заменен режимным аргументом `--expert-balancedness-report-mode` (`off`/`server_log`/`prometheus`/`both`). В парсере он оставлен только как заглушка `DeprecatedAction` с `error_message`: передача флага вызывает `parser.error(...)`, то есть процесс завершается на разборе аргументов с сообщением о замене, до загрузки модели. Поля `ServerArgs.enable_expert_distribution_metrics` больше не существует.

## Оригинальная справка

```text
Removed. Use --expert-balancedness-report-mode with one of: off, server_log, prometheus, both.
```

## Паспорт аргумента

- Флаги: `--enable-expert-distribution-metrics`
- Группа: нет (регистрируется литеральным `parser.add_argument` в блоке deprecated-аргументов `ServerArgs.add_cli_args`, вне групповых неймспейсов)
- Тип значения: не принимает значения; любое использование — ошибка разбора
- Действие: `DeprecatedAction` (`sglang/python/sglang/srt/arg_groups/argparse_actions.py`) с заданным `error_message`, что означает жесткий отказ, а не предупреждение
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: удален; заглушка существует ради диагностируемого сообщения об ошибке

## Что меняет в движке

Ничего: до логики движка значение не доходит. `DeprecatedAction.__call__` при непустом `error_message` вызывает `parser.error(error_message)` — argparse печатает usage и сообщение `--enable-expert-distribution-metrics is no longer supported. Use --expert-balancedness-report-mode with one of: off, server_log, prometheus, both.` и завершает процесс с кодом 2.

## Чем заменен

Вся механика наблюдаемости balancedness жива и переехала под `--expert-balancedness-report-mode`:

- старое поведение «флаг включен, переменная окружения не задана» (строки `[Expert Balancedness]` в логе ранга 0) — это `--expert-balancedness-report-mode server_log`;
- старое поведение «флаг включен плюс `SGLANG_ENABLE_EPLB_BALANCEDNESS_METRIC=1`» (Prometheus-summary `sglang:eplb_balancedness` вместо лога) — это `--expert-balancedness-report-mode prometheus`; сама переменная окружения тем же PR удалена из `environ.py`, и выставленная в окружении она тоже валит запуск — `_handle_expert_distribution_metrics` бросает `ValueError` с тем же указанием на замену;
- `both` пишет и туда, и туда — комбинации, которой у старой пары флаг+переменная не было.

Побочные эффекты старого флага сохранились у нового аргумента в любом режиме, кроме `off`: рекордер распределения экспертов автостартует при инициализации (`should_report_expert_balancedness()` в `_ExpertDistributionRecorderReal.__init__`), а окно истории для `--eplb-min-rebalancing-utilization-threshold` наполняется. Детали — в документе `--expert-balancedness-report-mode`.

## Значения и формат

Не применим: флаг не принимает значения и не проходит разбор.

## Когда использовать

Никогда. Уберите флаг из строк запуска и INI/скриптов и задайте `--expert-balancedness-report-mode` с нужным режимом. Заглушка может исчезнуть в будущих версиях вместе с сообщением-подсказкой.

## Влияние на производительность и память

Не применимо: с этим флагом сервер не стартует.

## Взаимодействие с другими аргументами

Единственное взаимодействие — замена: `--expert-balancedness-report-mode`. Прежние связки (`--expert-distribution-recorder-mode`, `--eplb-min-rebalancing-utilization-threshold`, `--enable-eplb`, `--enable-metrics`) теперь описаны в документе нового аргумента.

## Типовые проблемы и диагностика

- Сервер падает на старте с `error: --enable-expert-distribution-metrics is no longer supported...` — это и есть штатное поведение заглушки; замените флаг на `--expert-balancedness-report-mode server_log` (или другой режим).
- В установленном пакете старой версии флаг еще может работать по-старому: каталог аргументов arriero строится из `--help` установленного движка, а этот документ описывает checkout после PR #34998. Проверить свою сборку: `python -m sglang.launch_server --help | grep expert`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --expert-balancedness-report-mode server_log
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/eplb/expert_distribution.py`
- https://github.com/sgl-project/sglang/pull/34998
