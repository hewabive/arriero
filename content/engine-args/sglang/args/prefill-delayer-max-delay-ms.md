---
schema: 1
engine: sglang
primaryName: "--prefill-delayer-max-delay-ms"
title: "--prefill-delayer-max-delay-ms"
summary: Потолок одной задержки очередного триггера prefill-delayer в миллисекундах астрономического времени. Читается только вместе с `--prefill-delayer-queue-min-ratio`; при незаданном значении внутри используется 5000 мс.
group: schedule
related:
  - --enable-prefill-delayer
  - --prefill-delayer-queue-min-ratio
  - --prefill-delayer-max-delay-passes
  - --prefill-delayer-wait-seconds-buckets
  - --prefill-delayer-token-usage-low-watermark
---

# --prefill-delayer-max-delay-ms

## Кратко

Единственная граница задержки prefill, выраженная в реальном времени, а не в forward-проходах. Как только с начала текущего эпизода ожидания прошло больше `max_delay_ms`, очередное условие принудительно считается невыполненным и prefill выпускается. Механизм prefill-delayer целиком описан в `--prefill-delayer-max-delay-passes`.

## Оригинальная справка

```text
Wall-clock cap (ms) on a single queue-trigger delay; once exceeded, prefill is force-released to bound worst-case TTFT. Only consulted when --prefill-delayer-queue-min-ratio is set. Typical: 1000 ~ 5000; defaults to 5000 if unset.
```

## Паспорт аргумента

- Флаги: `--prefill-delayer-max-delay-ms`
- Группа: `schedule`
- Тип значения: число с плавающей точкой (`Optional[float]`), миллисекунды
- Допустимые значения: не ограничены проверками; рекомендованный апстримом диапазон — `1000 … 5000`
- Значение по умолчанию: `null`
- Эффективное значение: `null` превращается в `5000.0` внутри `PrefillDelayer.__init__` — это локальный предохранитель, а не семантический дефолт, поэтому в `ServerArgs` он не поднимается и в дампе `server_args=` вы увидите `None`
- Где объявлен: `ServerArgs.prefill_delayer_max_delay_ms`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается только при `--enable-prefill-delayer` **и** заданном `--prefill-delayer-queue-min-ratio`
- Этап применения: создание `PrefillDelayer` → каждый проход сборки prefill-батча, где активно очередное условие

## Что меняет в движке

В `PrefillDelayer._negotiate_should_allow_prefill_pure` (`sglang/python/sglang/srt/managers/prefill_delayer.py`) проверка выглядит так:

```python
if queue_condition and prev_state is not None:
    elapsed_ms = (time.perf_counter() - prev_state.start_time) * 1000.0
    if elapsed_ms >= self._max_delay_ms:
        queue_condition = False
```

Отсчет ведется от `start_time` состояния `_State`, которое создается в момент первой задержки эпизода и живет, пока prefill не выпущен. То есть лимит ограничивает **одну непрерывную серию** задержек, а не суммарное время ожидания запроса.

Важная деталь: снятие `queue_condition` не гарантирует немедленный prefill. Если параллельно выполняется слотовое условие (`slot_condition`), задержка продолжится — ее остановит только потолок `--prefill-delayer-max-delay-passes`. Таким образом этот аргумент ограничивает вклад именно очередного триггера.

## Значения и формат

- Миллисекунды, дробные допустимы (`float`).
- Сравнение нестрогое (`>=`), проверка выполняется на очередном проходе планировщика — реальная задержка округляется вверх до длительности одного forward-прохода.
- `0` означает «очередной триггер не может задержать дольше одного прохода»: на втором проходе `elapsed_ms >= 0` истинно всегда.
- Отрицательное значение ведет себя так же, как `0`.
- Значение не участвует ни в каких проверках при старте и молча игнорируется, если `--prefill-delayer-queue-min-ratio` не задан.

## Когда использовать

- Задавайте вместе с `--prefill-delayer-queue-min-ratio`, если у сервиса есть бюджет по TTFT: 5000 мс по умолчанию для интерактивной нагрузки почти всегда слишком много, разумная отправная точка — `1000`.
- Не задавайте отдельно от `--prefill-delayer-queue-min-ratio`: значение будет прочитано в конструкторе и напечатано в логе, но ни разу не использовано.
- Не пытайтесь ограничить им общую задержку prefill — слотовый триггер этого лимита не видит.

## Влияние на производительность и память

- На память не влияет.
- Ограничивает худший TTFT со стороны очередного триггера; чем меньше значение, тем ближе поведение к «без задержки» и тем мельче prefill-батчи.
- На throughput влияет обратно пропорционально: слишком маленькое значение обесценивает `--prefill-delayer-queue-min-ratio`.
- На время старта и VRAM влияния нет.

## Взаимодействие с другими аргументами

- `--prefill-delayer-queue-min-ratio`: единственный потребитель. Без него значение мертвое.
- `--prefill-delayer-max-delay-passes`: второй, независимый потолок; фактическая задержка ограничена минимумом из двух.
- `--prefill-delayer-token-usage-low-watermark`: снимает задержку раньше любого из потолков, если загрузка KV низка.
- `--prefill-delayer-wait-seconds-buckets`: корзины гистограммы, по которой удобно проверять, упирается ли ожидание в этот лимит.
- `--enable-prefill-delayer`: без него значение не читается.

## Типовые проблемы и диагностика

- Строка при старте: `PrefillDelayer initialized with … max_delay_ms=1000.0 queue_trigger_enabled=True`. Если там `queue_trigger_enabled=False`, значение не работает — не задан `--prefill-delayer-queue-min-ratio`.
- Гистограмма `sglang:prefill_delayer_wait_seconds` показывает фактические времена ожидания; накопление наблюдений у верхней границы означает, что лимит достигается регулярно.
- Метрика `sglang:prefill_delayer_outcomes_total` с `output_reason="wait_timeout"` считает выходы по потолку в проходах, а не по этому лимиту: снятие `queue_condition` по времени обычно приводит к `wait_success`.
- Значение аргумента как его принял SGLang — в дампе `server_args=` при старте (`None`, если вы его не задавали).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-prefill-delayer --prefill-delayer-queue-min-ratio 0.2 --prefill-delayer-max-delay-ms 1000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-dp-attention --dp-size 2 --tp-size 2 --enable-prefill-delayer --prefill-delayer-queue-min-ratio 0.3 --prefill-delayer-max-delay-ms 3000 --prefill-delayer-max-delay-passes 40
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/prefill_delayer.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
