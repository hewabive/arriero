---
schema: 1
engine: sglang
primaryName: "--prefill-delayer-wait-seconds-buckets"
title: "--prefill-delayer-wait-seconds-buckets"
summary: Границы корзин гистограммы `sglang:prefill_delayer_wait_seconds` — сколько секунд ждал выпущенный prefill. Только наблюдаемость: на планирование не влияет.
group: schedule
related:
  - --enable-prefill-delayer
  - --prefill-delayer-max-delay-ms
  - --prefill-delayer-forward-passes-buckets
  - --prefill-delayer-max-delay-passes
  - --enable-metrics
---

# --prefill-delayer-wait-seconds-buckets

## Кратко

Наблюдательный аргумент: задает границы корзин гистограммы, в которую prefill-delayer пишет длительность задержки в секундах. Решений планировщика не меняет. Механизм задержки целиком описан в `--prefill-delayer-max-delay-passes`.

## Оригинальная справка

```text
Custom buckets for prefill delayer wait seconds histogram. 0 will be auto-added.
```

## Паспорт аргумента

- Флаги: `--prefill-delayer-wait-seconds-buckets`
- Группа: `schedule`
- Тип значения: список чисел с плавающей точкой (`Optional[List[float]]`), в CLI — `nargs="+"`, значения через пробел
- Допустимые значения: не ограничены; порядок не важен, набор сортируется и дедуплицируется
- Значение по умолчанию: `null` — используется встроенный набор `[1, 2, 5, 10, 20, 50, 100, 200, 500]`
- Эффективное значение: к заданному (или встроенному) набору всегда добавляется корзина `0`, после чего он сортируется. В отличие от `--prefill-delayer-forward-passes-buckets`, верхней отсечки здесь нет
- Где объявлен: `ServerArgs.prefill_delayer_wait_seconds_buckets`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается только при включенных метриках и при `--enable-prefill-delayer`
- Этап применения: конструктор `SchedulerMetricsCollector` — один раз при инициализации планировщика

## Что меняет в движке

`SchedulerMetricsCollector.__init__` (`sglang/python/sglang/srt/observability/metrics_collector.py`) строит набор как `sorted(set(значения или умолчание) | {0})`. Корзина `0` добавлена, чтобы отделить выпуски без ожидания.

Наблюдаемая величина считается в `_negotiate_should_allow_prefill_pure` как `time.perf_counter() - prev_state.start_time`, то есть это длительность **текущего эпизода ожидания**, а не суммарное время жизни запроса в очереди. Записывается только на путях выпуска (`wait_success`, `wait_timeout`, `token_watermark` и пустая причина) и только если prefill на этом проходе действительно был выполнен.

Обратите внимание на единицы: аргумент задается в секундах, а родственный лимит `--prefill-delayer-max-delay-ms` — в миллисекундах. Встроенный набор корзин (до 500 с) рассчитан на очень широкий диапазон и для типичных задержек в сотни миллисекунд бесполезен: все наблюдения попадут в первую ненулевую корзину.

## Значения и формат

- Список секунд через пробел: `--prefill-delayer-wait-seconds-buckets 0.05 0.1 0.25 0.5 1`.
- Дробные значения — норма и, как правило, единственное осмысленное решение.
- Дубли и произвольный порядок безопасны.
- Пустой список задать нельзя (`nargs="+"`); чтобы вернуться к умолчанию, уберите аргумент.
- Значения не ограничены сверху и не отсекаются по лимитам задержки — движок не знает, какой потолок вы задали в миллисекундах.

## Когда использовать

- Практически всегда, если вы включили `--enable-prefill-delayer` и собираете метрики: встроенные корзины начинаются с 1 секунды, а реальные задержки обычно на порядок короче.
- При подборе `--prefill-delayer-max-delay-ms`: корзины вокруг вашего лимита показывают, как часто он достигается.
- Не трогайте, если метрики не собираются.

## Влияние на производительность и память

- На планирование, TTFT, VRAM и RAM не влияет: значение читается один раз при создании коллектора метрик.
- Единственная цена — число временных серий в экспорте Prometheus.

## Взаимодействие с другими аргументами

- `--prefill-delayer-max-delay-ms`: задает верхнюю границу ожидания для очередного триггера; корзины стоит подбирать вокруг нее, переведя миллисекунды в секунды.
- `--prefill-delayer-max-delay-passes`: второй потолок; при коротких forward-проходах именно он ограничивает время.
- `--prefill-delayer-forward-passes-buckets`: парная гистограмма в проходах.
- `--enable-prefill-delayer`, `--enable-metrics`: без них гистограмма не наполняется.

## Типовые проблемы и диагностика

- Все наблюдения в корзине `1` (первая ненулевая из встроенного набора) — задайте корзины меньшего масштаба, иначе распределение неинформативно.
- Гистограмма пуста при непустом `sglang:prefill_delayer_outcomes_total` — задержек не было либо выпущенный prefill не выполнялся; наблюдения пишутся только при `output_allow and actual_execution`.
- Принятый список видно в дампе `server_args=` при старте.
- Подробный лог решений — переменная окружения `SGLANG_PREFILL_DELAYER_DEBUG_LOG=1`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-prefill-delayer --enable-metrics --prefill-delayer-wait-seconds-buckets 0.05 0.1 0.25 0.5 1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-prefill-delayer --enable-metrics --prefill-delayer-queue-min-ratio 0.2 --prefill-delayer-max-delay-ms 1000 --prefill-delayer-wait-seconds-buckets 0.1 0.5 0.9 1.5
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/managers/prefill_delayer.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
