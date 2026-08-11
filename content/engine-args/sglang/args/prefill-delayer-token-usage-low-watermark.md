---
schema: 1
engine: sglang
primaryName: "--prefill-delayer-token-usage-low-watermark"
title: "--prefill-delayer-token-usage-low-watermark"
summary: Нижний порог загрузки KV-пула (доля от 0 до 1), при котором prefill-delayer перестает задерживать prefill и выпускает его немедленно. Предохранитель против простоя GPU на пустом пуле.
group: schedule
related:
  - --enable-prefill-delayer
  - --prefill-delayer-max-delay-passes
  - --prefill-delayer-queue-min-ratio
  - --prefill-delayer-max-delay-ms
  - --mem-fraction-static
  - --enable-metrics
---

# --prefill-delayer-token-usage-low-watermark

## Кратко

Аргумент задает единственное безусловное исключение из логики prefill-delayer: если загрузка KV-пула ниже порога, задерживать prefill бессмысленно — GPU и так недогружен. Проверка стоит раньше обоих триггеров задержки и раньше обоих потолков. Механизм delayer'а целиком описан в `--prefill-delayer-max-delay-passes`.

## Оригинальная справка

```text
Token usage low watermark for prefill delayer.
```

## Паспорт аргумента

- Флаги: `--prefill-delayer-token-usage-low-watermark`
- Группа: `schedule`
- Тип значения: число с плавающей точкой (`Optional[float]`), доля занятого KV-пула
- Допустимые значения: не ограничены проверками; осмысленный диапазон — `0 … 1`
- Значение по умолчанию: `null` — предохранитель выключен, задержка ограничена только потолками
- Эффективное значение: переопределяется переменной окружения `SGLANG_PREFILL_DELAYER_TOKEN_USAGE_LOW_WATERMARK`, если она задана и непустая (`_handle_prefill_delayer_env_compat`)
- Где объявлен: `ServerArgs.prefill_delayer_token_usage_low_watermark`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается только при `--enable-prefill-delayer`
- Этап применения: создание `PrefillDelayer` → каждый проход сборки prefill-батча

## Что меняет в движке

На каждом проходе `Scheduler.get_new_batch_prefill` берет максимальную загрузку по всем пулам (`pool_stats_observer.get_pool_stats().get_max_pool_usage()`) и передает ее в `PrefillDelayerSinglePassExecutor` как `token_usage`. Внутри `_negotiate_should_allow_prefill_pure` (`sglang/python/sglang/srt/managers/prefill_delayer.py`) считается локальный флаг:

```python
local_token_watermark_force_allow = (
    local_prefillable
    and (self._token_usage_low_watermark is not None)
    and (token_usage < self._token_usage_low_watermark)
)
```

Флаг попадает в all-gather наряду с остальными полями, и если он выставлен **хотя бы у одного** ранга, все ранги немедленно получают разрешение с причиной `token_watermark`. Проверка стоит первой и в ветке `all`, и в ветке `mixed`, то есть перекрывает и слотовое условие, и очередное, и оба потолка.

Если аргумент не задан, флаг всегда ложен и предохранитель отсутствует: единственными ограничителями задержки остаются `--prefill-delayer-max-delay-passes` и (для очередного триггера) `--prefill-delayer-max-delay-ms`.

## Значения и формат

- Доля от 0 до 1: `0.3` означает «пока занято меньше 30% KV-пула, не задерживать prefill».
- Сравнение строгое (`token_usage < x`), берется максимум загрузки по пулам — на гибридных моделях (full + SWA) это максимум из обоих.
- `0` фактически отключает предохранитель: загрузка никогда не бывает меньше нуля.
- Значение `1` (и больше) означает «никогда не задерживать»: prefill будет выпускаться на каждом проходе, delayer превращается в no-op.
- Верхняя граница не проверяется, так что значение вне `[0, 1]` примется молча.

## Когда использовать

- Задавайте всегда, когда включаете `--enable-prefill-delayer` на нагрузке с провалами трафика: без предохранителя delayer будет отрабатывать полный потолок задержки даже на почти пустом сервере, где ждать нечего.
- Разумная отправная точка — `0.3`: сервер, занятый меньше чем на треть, точно не выигрывает от укрупнения prefill-батча.
- Не поднимайте порог близко к рабочей загрузке: при `0.9` на нагруженном сервере delayer перестанет работать вообще.
- Не трогайте, если delayer не включен — значение не читается.

## Влияние на производительность и память

- На память не влияет: это условие выпуска, а не бюджет.
- TTFT на слабой нагрузке улучшается — задержка снимается сразу.
- Throughput на высокой нагрузке не меняется: там загрузка выше порога и предохранитель не срабатывает.
- На время старта и VRAM влияния нет.

## Взаимодействие с другими аргументами

- `--enable-prefill-delayer`: без него значение не читается.
- `--prefill-delayer-max-delay-passes` и `--prefill-delayer-max-delay-ms`: потолки задержки; watermark срабатывает раньше обоих.
- `--prefill-delayer-queue-min-ratio`: очередное условие полностью перекрывается watermark'ом.
- `--mem-fraction-static`: определяет абсолютный размер пула, а значит и то, какой доле соответствует ваш порог в токенах.
- `--enable-metrics`: без него исходы delayer'а не публикуются и проверить срабатывания можно только по debug-логу.

## Типовые проблемы и диагностика

- Строка при старте: `PrefillDelayer initialized with max_delay_passes=30 token_usage_low_watermark=0.3 …` — подтверждает принятое значение.
- При `SGLANG_PREFILL_DELAYER_DEBUG_LOG=1` каждое срабатывание пишет `PrefillDelayer force allow prefill due to low watermark. (num_prefillable=…, num_token_watermark_force_allow=…, actual_execution=…)`.
- Метрика `sglang:prefill_delayer_outcomes_total` с `output_reason="token_watermark"` считает срабатывания предохранителя. Если его доля близка к 100%, порог задан слишком высоко и delayer выключен де-факто.
- Текущую загрузку пула видно в строках `Decode batch, …, token usage: …` — по ней и подбирается порог.
- Значение, принятое движком, видно в дампе `server_args=` при старте; если оно расходится с CLI, проверьте переменную окружения `SGLANG_PREFILL_DELAYER_TOKEN_USAGE_LOW_WATERMARK`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-prefill-delayer --prefill-delayer-token-usage-low-watermark 0.3
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-dp-attention --dp-size 2 --tp-size 2 --enable-prefill-delayer --prefill-delayer-token-usage-low-watermark 0.5 --prefill-delayer-max-delay-passes 20 --enable-metrics
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/prefill_delayer.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/environ.py`
