---
schema: 1
engine: sglang
primaryName: "--enable-prefill-delayer"
title: "--enable-prefill-delayer"
summary: Придерживает prefill на несколько forward-проходов, чтобы decode-батч успел заполниться и DP-ранги не простаивали. Требует включенного overlap-планировщика; на decode-движке PD игнорируется.
group: schedule
related:
  - --prefill-delayer-max-delay-passes
  - --prefill-delayer-token-usage-low-watermark
  - --prefill-delayer-queue-min-ratio
  - --prefill-delayer-max-delay-ms
  - --enable-dp-attention
  - --disable-overlap-schedule
  - --max-running-requests
  - --min-free-slots-delay
  - --disaggregation-mode
---

# --enable-prefill-delayer

## Кратко

При DP attention все ранги вынуждены выполнять один и тот же тип forward'а. Если один ранг решил делать prefill, остальные простаивают на своем decode. `--enable-prefill-delayer` добавляет согласование: ранги обмениваются своим состоянием через all-gather и, если условия не сложились, откладывают prefill на несколько проходов. Механизм осмысленен прежде всего с `--enable-dp-attention`, но проверок на это нет — он включается и в одноранговой конфигурации, где работает только «слотовое» условие.

## Оригинальная справка

```text
Enable prefill delayer for DP attention to reduce idle time.
```

## Паспорт аргумента

- Флаги: `--enable-prefill-delayer`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false`
- Эффективное значение: принудительно `true`, если задана устаревшая переменная окружения `SGLANG_SCHEDULER_DECREASE_PREFILL_IDLE` (`_handle_prefill_delayer_env_compat`); на `--disaggregation-mode decode` объект delayer'а не создается вовсе
- Где объявлен: `ServerArgs.enable_prefill_delayer`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `Scheduler.init_schedule_policy` (создание `PrefillDelayer`) → на каждом проходе admission внутри `PrefillAdder`

## Что меняет в движке

`PrefillDelayer` создается один раз и на каждом проходе выполняет all-gather пяти чисел с каждого ранга: «есть что префиллить», «сработал порог низкой утилизации», размер running batch, накопленный максимум prefill-batch'а (`max_prefill_bs`) и длина очереди ожидания. Обмен идет по CPU-группе (gloo), либо по NCCL, если overlap выключен или задана `SGLANG_NCCL_ALL_GATHER_IN_OVERLAP_SCHEDULER_SYNC_BATCH`.

Дальше решение принимается по глобальному состоянию:

- **все ранги готовы префиллить** — проверяются два условия задержки. «Слотовое»: `max_running_requests − running_batch < max_prefill_bs`, то есть после prefill'а decode-батч все равно не выйдет на максимум. «Очередное» (опционально, включается только заданием `--prefill-delayer-queue-min-ratio`): очередь короче `min(running_batch * ratio, max_prefill_bs)`, с ограничением по стенным часам `--prefill-delayer-max-delay-ms` (по умолчанию 5000 мс). Если сработало любое — prefill откладывается, но не больше `--prefill-delayer-max-delay-passes` проходов (по умолчанию 30);
- **никто не готов** — решение не важно, prefill разрешается;
- **часть рангов готова** — prefill откладывается до общего согласия, тоже с ограничением по числу проходов.

Поверх всего работает предохранитель: если задан `--prefill-delayer-token-usage-low-watermark` и текущая утилизация KV-пула ниже него, prefill разрешается немедленно (`output_reason="token_watermark"`) — GPU недогружен, придерживать нечего.

Первая сработавшая задержка пропускается (`skip_first_delayer`), а `max_prefill_bs` затухает на 0.998 за проход, чтобы один аномально большой prefill не поднял планку навсегда.

## Значения и формат

- Флаг без значения; «не задан» — prefill выполняется, как только для него есть работа.
- Обратного флага нет.
- Все числовые параметры вынесены в отдельные аргументы `--prefill-delayer-*`; сам флаг только включает механизм.
- Устаревшая переменная окружения `SGLANG_SCHEDULER_DECREASE_PREFILL_IDLE` включает его без CLI-флага; `SGLANG_PREFILL_DELAYER_MAX_DELAY_PASSES` и `SGLANG_PREFILL_DELAYER_TOKEN_USAGE_LOW_WATERMARK` перекрывают соответствующие аргументы.

## Когда использовать

- `--enable-dp-attention` с несколькими DP-рангами и заметной долей простоя: механизм ровно для этого и написан.
- Нагрузка, где decode-запросы завершаются по одному, и prefill из-за этого дробится на множество крошечных батчей — тогда полезен и «очередной» триггер (`--prefill-delayer-queue-min-ratio` 0.1…0.5).
- Не включайте вместе с `--disable-overlap-schedule`: конструктор `PrefillDelayer` содержит ассерт.
- Не включайте на decode-движке PD: движок сам напишет `Ignoring --enable-prefill-delayer on decode engine (no prefill scheduling path; delayer would be a no-op).`
- Не включайте, если важнее всего TTFT: механизм сознательно жертвует TTFT ради утилизации, и худший случай ограничен только `--prefill-delayer-max-delay-passes` (или `--prefill-delayer-max-delay-ms` для очередного триггера).

## Влияние на производительность и память

- Память: единственная аллокация — буфер all-gather на `dp_size × attn_tp_size × 5` int64; заметного расхода нет.
- Каждый проход добавляет одну коллективную операцию по CPU- или NCCL-группе — на большом числе рангов это не бесплатно.
- Throughput: растет за счет более полных decode-батчей и более крупных prefill-батчей.
- TTFT: ухудшается на величину задержки; при `--prefill-delayer-max-delay-passes 30` худший случай — 30 forward-проходов ожидания.
- ITL уже работающих запросов: улучшается, потому что их decode реже прерывается мелкими prefill'ами.

## Взаимодействие с другими аргументами

- `--enable-dp-attention`: целевой сценарий; без DP attention `max_running_requests` в расчете делится на `dp_size` вручную.
- `--disable-overlap-schedule`: несовместим (ассерт).
- `--max-running-requests`: левая часть «слотового» условия; при слишком большом значении условие почти всегда истинно и задержка срабатывает постоянно.
- `--prefill-delayer-max-delay-passes`: жесткая верхняя граница задержки в проходах.
- `--prefill-delayer-token-usage-low-watermark`: предохранитель по утилизации KV-пула.
- `--prefill-delayer-queue-min-ratio` и `--prefill-delayer-max-delay-ms`: включают и ограничивают второй триггер.
- `--min-free-slots-delay`: близкий по духу, но независимый механизм (строится отдельно от delayer'а) — задержка prefill до накопления свободных слотов.
- `--disaggregation-mode decode`: delayer не создается.

## Типовые проблемы и диагностика

- `AssertionError: To use PrefillDelayer, disable_overlap_schedule must be False.` — уберите один из двух флагов.
- `Ignoring --enable-prefill-delayer on decode engine` — ожидаемое поведение в PD-decode.
- Выросло TTFT после включения — механизм работает; уменьшайте `--prefill-delayer-max-delay-passes` или задайте `--prefill-delayer-token-usage-low-watermark`.
- Эффекта нет — проверьте строку `PrefillDelayer initialized with max_delay_passes=… token_usage_low_watermark=… queue_min_ratio=… max_delay_ms=… queue_trigger_enabled=…` в логе старта: она печатается только при реально созданном delayer'е.
- Детальную трассировку решений включает переменная окружения `SGLANG_PREFILL_DELAYER_DEBUG_LOG`; при `--enable-metrics` доступны гистограммы числа проходов и секунд ожидания.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --enable-dp-attention --dp-size 8 --tp-size 8 --enable-prefill-delayer
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --enable-dp-attention --dp-size 8 --tp-size 8 --enable-prefill-delayer --prefill-delayer-max-delay-passes 10 --prefill-delayer-token-usage-low-watermark 0.5
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/prefill_delayer.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/environ.py`
