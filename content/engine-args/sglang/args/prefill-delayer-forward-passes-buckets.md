---
schema: 1
engine: sglang
primaryName: "--prefill-delayer-forward-passes-buckets"
title: "--prefill-delayer-forward-passes-buckets"
summary: Границы корзин гистограммы `sglang:prefill_delayer_wait_forward_passes` — сколько forward-проходов ждал выпущенный prefill. Только наблюдаемость: на планирование не влияет.
group: schedule
related:
  - --enable-prefill-delayer
  - --prefill-delayer-max-delay-passes
  - --prefill-delayer-wait-seconds-buckets
  - --enable-metrics
---

# --prefill-delayer-forward-passes-buckets

## Кратко

Чисто наблюдательный аргумент: задает границы корзин Prometheus-гистограммы, в которую prefill-delayer пишет длину задержки в forward-проходах. Никакого влияния на решения планировщика не оказывает. Сам механизм задержки описан в `--prefill-delayer-max-delay-passes`.

## Оригинальная справка

```text
Custom buckets for prefill delayer forward passes histogram. 0 and max_delay_passes-1 will be auto-added.
```

## Паспорт аргумента

- Флаги: `--prefill-delayer-forward-passes-buckets`
- Группа: `schedule`
- Тип значения: список чисел с плавающей точкой (`Optional[List[float]]`), в CLI — `nargs="+"`, значения через пробел
- Допустимые значения: не ограничены; порядок не важен, набор сортируется и дедуплицируется движком
- Значение по умолчанию: `null` — используется встроенный набор `[5, 20, 50, 100, 200]`
- Эффективное значение: итоговый набор всегда пересчитывается: из заданных (или встроенных) границ отбрасываются все `>= prefill_delayer_max_delay_passes`, затем добавляются `0` и `max_delay_passes - 1`, результат сортируется
- Где объявлен: `ServerArgs.prefill_delayer_forward_passes_buckets`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается только при включенных метриках и при `--enable-prefill-delayer`
- Этап применения: конструктор `SchedulerMetricsCollector` — один раз при инициализации планировщика

## Что меняет в движке

`SchedulerMetricsCollector.__init__` (`sglang/python/sglang/srt/observability/metrics_collector.py`) строит гистограмму так:

```python
buckets=sorted(
    set(x for x in (server_args.prefill_delayer_forward_passes_buckets
                    or [5, 20, 50, 100, 200])
        if x < max_delay)
    | {0, max_delay - 1}
)
```

Две служебные корзины добавляются намеренно: `0` отделяет случаи «выпущено без ожидания», а `max_delay_passes - 1` позволяет отличить выход по потолку (`wait_timeout`) от обычного успешного ожидания.

Наблюдение попадает в гистограмму только тогда, когда prefill был одновременно разрешен и реально выполнен на этом проходе (`observe_prefill_delayer_outcome` пишет гистограммы при `output_allow and actual_execution`). Само значение — счетчик задержек текущего эпизода из `_State.delayed_count`.

## Значения и формат

- Список чисел через пробел: `--prefill-delayer-forward-passes-buckets 2 5 10 20`.
- Значения интерпретируются как верхние границы корзин Prometheus (`le`), в тех же единицах, что и `--prefill-delayer-max-delay-passes`, — в forward-проходах.
- Границы `>= max_delay_passes` молча отбрасываются: наблюдений в них быть не может.
- Дубли и неупорядоченный ввод безопасны — набор проходит через `set` и `sorted`.
- Пустой список задать нельзя (`nargs="+"` требует хотя бы одного значения); чтобы вернуться к умолчанию, просто уберите аргумент.
- Дробные значения принимаются, но смысла не имеют: наблюдаемая величина целочисленная.

## Когда использовать

- Когда штатные корзины не разрешают ваш диапазон: при `--prefill-delayer-max-delay-passes 10` из встроенного набора выживает только `5`, и гистограмма получается из трех корзин `0, 5, 9`.
- При подборе потолка задержки: детальные корзины в нижней части диапазона показывают, где реально заканчиваются ожидания.
- Не трогайте, если метрики не собираются: без `--enable-metrics` гистограмма никуда не публикуется.

## Влияние на производительность и память

- На планирование, на память GPU и на TTFT не влияет вообще: значение читается один раз при создании коллектора метрик.
- Единственная цена — размер экспорта Prometheus: каждая корзина добавляет одну временную серию на набор меток.

## Взаимодействие с другими аргументами

- `--prefill-delayer-max-delay-passes`: задает и верхнюю отсечку корзин, и автоматически добавляемую корзину `max_delay_passes - 1`.
- `--prefill-delayer-wait-seconds-buckets`: парный аргумент для гистограммы времени ожидания.
- `--enable-prefill-delayer`: без него ожиданий не бывает и гистограмма остается пустой.
- `--enable-metrics`: без него коллектор метрик планировщику не передается (`metrics_collector=None`) и наблюдения не пишутся.

## Типовые проблемы и диагностика

- Гистограмма `sglang:prefill_delayer_wait_forward_passes` пуста: либо delayer не включен, либо все проходы завершались без задержки, либо метрики выключены. Счетчик `sglang:prefill_delayer_outcomes_total` при этом все равно наполняется — по нему видно, были ли решения вообще.
- Все наблюдения в корзине `max_delay_passes - 1` — задержки регулярно доходят до потолка; смотрите долю `output_reason="wait_timeout"`.
- Заданные корзины не появились в экспорте — они были выше `--prefill-delayer-max-delay-passes` и отброшены.
- Принятый список видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-prefill-delayer --enable-metrics --prefill-delayer-forward-passes-buckets 1 2 3 5 8
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-prefill-delayer --enable-metrics --prefill-delayer-max-delay-passes 60 --prefill-delayer-forward-passes-buckets 5 10 20 40
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/managers/prefill_delayer.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
