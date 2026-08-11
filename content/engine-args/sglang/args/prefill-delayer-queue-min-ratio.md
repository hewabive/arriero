---
schema: 1
engine: sglang
primaryName: "--prefill-delayer-queue-min-ratio"
title: "--prefill-delayer-queue-min-ratio"
summary: Включает второй, очередной триггер prefill-delayer и задает его порог: prefill откладывается, пока очередь ожидания короче `min(running_batch * ratio, max_prefill_bs)` запросов. Не задан — работает только слотовый триггер.
group: schedule
related:
  - --enable-prefill-delayer
  - --prefill-delayer-max-delay-ms
  - --prefill-delayer-max-delay-passes
  - --prefill-delayer-token-usage-low-watermark
  - --max-running-requests
  - --enable-dp-attention
---

# --prefill-delayer-queue-min-ratio

## Кратко

Аргумент делает две вещи сразу: сам факт того, что он задан, включает очередной (queue-based) триггер задержки, а его значение задает порог. Порог считается в запросах: `queue_min = min(int(running_batch * ratio), max_prefill_bs)`, и пока длина очереди ожидания меньше этого числа, prefill откладывается. Мишень — нагрузка, где decode-запросы заканчиваются по одному и дробят prefill на множество мелких батчей. Полное описание механизма prefill-delayer — в `--prefill-delayer-max-delay-passes`.

## Оригинальная справка

```text
Opt-in to the adaptive queue-based delay trigger (independent of the slot-based one). Delays prefill until the waiting queue reaches min(running_req * ratio, max_prefill_bs) so small fragments batch into a larger prefill. Unset (default) keeps the original slot-only behavior. Typical: 0.1 ~ 0.5.
```

## Паспорт аргумента

- Флаги: `--prefill-delayer-queue-min-ratio`
- Группа: `schedule`
- Тип значения: число с плавающей точкой (`Optional[float]`)
- Допустимые значения: не ограничены проверками; рекомендованный апстримом диапазон — `0.1 … 0.5`
- Значение по умолчанию: `null` — триггер выключен, работает только слотовое условие
- Эффективное значение: из CLI не переопределяется; переменной окружения для него нет
- Где объявлен: `ServerArgs.prefill_delayer_queue_min_ratio`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается только при `--enable-prefill-delayer`
- Этап применения: создание `PrefillDelayer` (там вычисляется `queue_trigger_enabled = queue_min_ratio is not None`) → каждый проход сборки prefill-батча

## Что меняет в движке

В ветке «всем рангам есть что prefill'ить» (`prefillable_status == "all"`) `PrefillDelayer._negotiate_should_allow_prefill_pure` считает:

```python
queue_min_effective = min(int(global_running_batch_max * self._queue_min_ratio),
                          global_max_prefill_bs_max)
queue_condition = queue_min_effective > 0 and global_waiting_queue_max < queue_min_effective
```

Все три величины берутся как максимум по рангам из all-gather'а: размер running-батча, высокая отметка `max_prefill_bs` и длина очереди ожидания. Условие проверяется только при `running_batch > 0` — на пустом сервере задержки не будет.

`max_prefill_bs` — не аргумент, а наблюдаемая величина: планировщик поднимает ее до размера последнего собранного prefill-батча (`max(self.max_prefill_bs, len(can_run_list))`) и затухает на 0.998 за проход, что дает период полураспада около 350 проходов. Она играет роль верхней границы порога: ждать очередь длиннее, чем движок реально успевает prefill'ить за раз, бессмысленно.

Условие складывается со слотовым по «или»: задержка происходит, если сработало любое из двух. Ограничивают ее два потолка — `--prefill-delayer-max-delay-passes` (в проходах) и `--prefill-delayer-max-delay-ms` (в миллисекундах, консультируется только этим триггером).

## Значения и формат

- Дробь от размера running-батча. `0.2` при 50 запущенных запросах дает порог 10 ожидающих запросов (если `max_prefill_bs` не меньше).
- `int(...)` округляет вниз, поэтому при малом running-батче порог быстро вырождается в 0, и `queue_min_effective > 0` перестает выполняться — задержки не будет.
- Значение `0` формально примется, но порог всегда будет нулевым, то есть триггер включится и никогда не сработает. Чтобы выключить его, просто не задавайте аргумент.
- Большие значения (`> 1`) означают «ждать очередь длиннее, чем running-батч»; практически порог упрется в `max_prefill_bs`.
- Отрицательные значения не проверяются, но дают отрицательный порог и, соответственно, неработающий триггер.

## Когда использовать

- Стабильная нагрузка, в которой decode-запросы завершаются поодиночке, а в логе видно много строк `Prefill batch` с `#new-seq: 1` — типичный признак дробления prefill. Начните с `0.2`.
- Не включайте на интерактивной нагрузке с редкими запросами: там задержка почти всегда упрется в `--prefill-delayer-max-delay-ms` и просто добавит TTFT.
- Не используйте как замену `--chunked-prefill-size`: тот ограничивает размер одного prefill-прохода, а этот аргумент — момент его запуска.

## Влияние на производительность и память

- На память не влияет: решение принимается после проверок бюджета KV.
- Throughput растет за счет укрупнения prefill-батчей: меньше проходов с фиксированными накладными расходами на батч.
- TTFT растет ровно на длительность ожидания; верхняя граница — минимум из `--prefill-delayer-max-delay-ms` и `(max_delay_passes - 1)` проходов.
- На время старта и на VRAM влияния нет.

## Взаимодействие с другими аргументами

- `--enable-prefill-delayer`: без него значение не читается.
- `--prefill-delayer-max-delay-ms`: консультируется **только** при заданном `queue_min_ratio`; при незаданном значении внутренний лимит равен 5000 мс.
- `--prefill-delayer-max-delay-passes`: общий потолок в проходах, действует и на этот триггер.
- `--prefill-delayer-token-usage-low-watermark`: приоритетнее — при низкой загрузке пула prefill выпускается сразу, очередное условие не проверяется.
- `--max-running-requests`: участвует в слотовом условии, а через фактический размер running-батча косвенно задает и порог этого триггера.
- `--enable-dp-attention`: величины для условия собираются all-gather'ом по рангам; вне DP attention триггер тоже работает, но выигрыш от него меньше.

## Типовые проблемы и диагностика

- Строка при старте: `PrefillDelayer initialized with … queue_min_ratio=0.2 max_delay_ms=5000.0 queue_trigger_enabled=True` — подтверждает, что триггер включен и с каким порогом.
- Триггер включен, но задержек нет: посмотрите на `#running-req` и `#queue-req` в строках `Prefill batch`. При малом running-батче `int(running * ratio)` даст 0, и условие не сработает.
- Резко вырос TTFT после включения: доля `output_reason="wait_timeout"` в `sglang:prefill_delayer_outcomes_total` покажет, как часто задержка доходит до потолка; гистограмма `sglang:prefill_delayer_wait_seconds` — фактическое время ожидания.
- Подробный лог решений — переменная окружения `SGLANG_PREFILL_DELAYER_DEBUG_LOG=1`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-prefill-delayer --prefill-delayer-queue-min-ratio 0.2
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-dp-attention --dp-size 2 --tp-size 2 --enable-prefill-delayer --prefill-delayer-queue-min-ratio 0.4 --prefill-delayer-max-delay-ms 2000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/prefill_delayer.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
