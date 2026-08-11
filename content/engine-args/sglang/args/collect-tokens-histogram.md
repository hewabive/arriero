---
schema: 1
engine: sglang
primaryName: "--collect-tokens-histogram"
title: "--collect-tokens-histogram"
summary: Устаревший флаг без всякого эффекта: гистограммы длин промпта и генерации теперь собираются автоматически вместе с `--enable-metrics`. Единственное действие — предупреждение в логе.
group: null
related:
  - --enable-metrics
  - --prompt-tokens-buckets
  - --generation-tokens-buckets
  - --enable-metrics-for-all-schedulers
  - --bucket-time-to-first-token
---

# --collect-tokens-histogram

## Кратко

Раньше сбор гистограмм по длинам промпта и ответа был отдельной опцией, потому что стоил заметных накладных расходов. Сейчас гистограммы включены в общий набор метрик и появляются вместе с `--enable-metrics`, а флаг остался чистой заглушкой: он печатает предупреждение и не пишет ничего ни в `ServerArgs`, ни куда-либо еще.

## Оригинальная справка

```text
Deprecated. Token histograms are now automatically collected when --enable-metrics is set.
```

## Паспорт аргумента

- Флаги: `--collect-tokens-histogram`
- Группа: `null` — объявлен литеральным `parser.add_argument` в `add_cli_args`; поля `collect_tokens_histogram` в `ServerArgs` больше не существует
- Тип значения: флаг без значения (`nargs=0`)
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `None` — argparse кладет `None` в namespace, но `from_cli_args` собирает только те атрибуты, которым соответствуют поля датакласса, поэтому значение отбрасывается целиком
- Эффективное значение: отсутствует. Флаг не влияет ни на одно поле конфигурации
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: устаревший (`DeprecatedAction` — вариант, который **не** сохраняет значение), замена — `--enable-metrics`
- Этап применения: только разбор CLI

## Что меняет в движке

Ничего. `DeprecatedAction.__call__` печатает единственное сообщение и возвращает управление:

```text
The command line argument '--collect-tokens-histogram' is deprecated and will be removed in future versions.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса. Обратите внимание: у этого класса действия нет поля `new_flag`, поэтому подсказки про замену в предупреждении нет — она есть только в тексте `--help`.

Сами гистограммы объявлены в `MetricsCollector` (`sglang/python/sglang/srt/observability/metrics_collector.py`) и создаются при `--enable-metrics`:

- `sglang:prompt_tokens_histogram` — длины промптов;
- `sglang:uncached_prompt_tokens_histogram` — та же величина за вычетом попаданий в префиксный кеш;
- `sglang:generation_tokens_histogram` — длины сгенерированных ответов.

Границы корзин настраиваются через `--prompt-tokens-buckets` и `--generation-tokens-buckets`; оба принимают не голый список чисел, а правило — `default`, `tse <middle> <base> <count>` либо `custom <value1> <value2> …` (проверяется `validate_buckets_rule`). При незаданных значениях используются встроенные наборы.

## Значения и формат

- Булев флаг без значения. Принимается argparse'ом, но не имеет эффекта.
- Не имеет смысла ни в какой комбинации: убрать его из команды запуска можно без каких-либо изменений в поведении.
- В YAML через `--config` ключ `collect-tokens-histogram` задать нельзя — `ConfigArgumentMerger` отвергает аргументы с нестандартным argparse-действием.

## Когда использовать

- Не использовать. Уберите флаг; чтобы получить гистограммы, включите `--enable-metrics`.
- Если гистограммы, наоборот, не нужны, отключить их отдельно уже нельзя — они идут в общем наборе метрик.

## Влияние на производительность и память

Никакого: флаг не читается после разбора командной строки. Стоимость самих гистограмм относится к `--enable-metrics` — это три дополнительных prometheus-объекта и по одному наблюдению на завершенный запрос.

## Взаимодействие с другими аргументами

- `--enable-metrics`: единственная актуальная ручка; включает в том числе гистограммы.
- `--prompt-tokens-buckets` / `--generation-tokens-buckets`: границы корзин для гистограмм длин.
- `--bucket-time-to-first-token`: границы отдельной гистограммы TTFT, тоже часть общего набора метрик.
- `--enable-metrics-for-all-schedulers`: расширяет сбор на все scheduler-процессы, а не только на нулевой ранг.

## Типовые проблемы и диагностика

- `The command line argument '--collect-tokens-histogram' is deprecated and will be removed in future versions.` — уберите флаг.
- Гистограмм нет в `/metrics` — не включен `--enable-metrics`; этот флаг их не включает.
- Флаг не принимается (`unrecognized arguments`) — установленная версия уже удалила заглушку; сверьтесь с `--help` своей сборки.
- Что смотреть: наличие `sglang:prompt_tokens_histogram` и `sglang:generation_tokens_histogram` в выводе `/metrics`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-metrics
```

С настроенными границами корзин (правило `custom` плюс список значений):

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-metrics --prompt-tokens-buckets custom 128 512 2048 8192 --generation-tokens-buckets custom 64 256 1024
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/server_args_config_parser.py`
