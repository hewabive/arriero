---
schema: 1
engine: sglang
primaryName: "--prefill-delayer-max-delay-passes"
title: "--prefill-delayer-max-delay-passes"
summary: Потолок задержки prefill в forward-проходах: сколько итераций подряд prefill-delayer имеет право отказывать в prefill, прежде чем принудительно его выпустить. Единственная общая граница для всех триггеров задержки.
group: schedule
related:
  - --enable-prefill-delayer
  - --prefill-delayer-token-usage-low-watermark
  - --prefill-delayer-queue-min-ratio
  - --prefill-delayer-max-delay-ms
  - --prefill-delayer-forward-passes-buckets
  - --prefill-delayer-wait-seconds-buckets
  - --enable-dp-attention
  - --max-running-requests
  - --disable-overlap-schedule
---

# --prefill-delayer-max-delay-passes

## Кратко

Этот файл описывает механизм prefill-delayer целиком — остальные шесть аргументов семейства двигают отдельные пороги внутри него. Сам `--prefill-delayer-max-delay-passes` — предохранитель: он ограничивает, сколько forward-проходов подряд prefill может быть отложен. Как только счетчик достигает `max_delay_passes - 1`, задержка снимается независимо от того, выполняется ли еще условие, ради которого она была введена.

## Оригинальная справка

```text
Maximum forward passes to delay prefill.
```

## Паспорт аргумента

- Флаги: `--prefill-delayer-max-delay-passes`
- Группа: `schedule`
- Тип значения: целое
- Допустимые значения: не ограничены на уровне argparse; осмысленны значения от 2 (гистограмма строит корзину `max_delay_passes - 1`, при значении 1 корзина вырождается в 0)
- Значение по умолчанию: `30`
- Эффективное значение: переопределяется переменной окружения `SGLANG_PREFILL_DELAYER_MAX_DELAY_PASSES`, если она задана и непустая (`_handle_prefill_delayer_env_compat`); CLI в этом случае проигрывает
- Где объявлен: `ServerArgs.prefill_delayer_max_delay_passes`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается только при `--enable-prefill-delayer`
- Этап применения: создание `PrefillDelayer` в `Scheduler.init_schedule_policy` → каждый проход сборки prefill-батча

## Что меняет в движке

**Зачем нужен delayer.** При DP attention все ранги обязаны идти одним и тем же режимом forward. Если один ранг ушел в prefill, а остальным нечего prefill'ить, они простаивают. Delayer позволяет отложить prefill на несколько проходов, чтобы дождаться, пока запрос появится и у соседей, либо чтобы набрать более крупный prefill-батч вместо череды мелких.

**Где он вклинивается.** На каждом проходе `Scheduler.get_new_batch_prefill` создает `PrefillDelayerSinglePassExecutor` с текущей максимальной загрузкой пулов (`token_usage`) и параллельно затухает высокую отметку `max_prefill_bs` на 0.998 за проход. Решение принимается внутри `PrefillAdder.add_one_req` — **после** всех проверок бюджета KV и **до** подгрузки префикса с хоста; отказ возвращается как `AddReqResult.OTHER`, то есть prefill-батч на этом проходе просто не собирается.

**Как принимается решение** (`PrefillDelayer._negotiate_should_allow_prefill_pure`, `sglang/python/sglang/srt/managers/prefill_delayer.py`). Ранги обмениваются all-gather'ом пятью числами: есть ли что prefill'ить, сработал ли watermark, размер running-батча, `max_prefill_bs`, длина очереди ожидания. Дальше:

- **никому** нечего prefill'ить (`none`) — разрешить (решение ни на что не влияет);
- **части** рангов есть что prefill'ить (`mixed`) — задерживать, пока счетчик задержек меньше `max_delay_passes - 1`, потом выпустить с причиной `wait_timeout`;
- **всем** есть что prefill'ить (`all`) — проверяются два независимых, складывающихся условия:
  - `slot_condition`: `max_running_requests - running_batch < max_prefill_bs` — свободных слотов меньше, чем типичный размер prefill-батча (без DP attention `max_running_requests` делится на `dp_size` с округлением вверх);
  - `queue_condition`: включается только заданным `--prefill-delayer-queue-min-ratio`; ждет, пока очередь дорастет до `min(running_batch * ratio, max_prefill_bs)`, но не дольше `--prefill-delayer-max-delay-ms`;

  если сработало любое — prefill откладывается, опять же не дольше `max_delay_passes - 1` проходов.

Поверх всего стоит безусловный предохранитель `--prefill-delayer-token-usage-low-watermark`: если хоть у одного ранга загрузка KV ниже порога, prefill выпускается немедленно с причиной `token_watermark`.

Отдельная деталь: самая первая задержка после старта пропускается (`skip_first_delayer`), чтобы первый merge-батч не оказался урезанным.

## Значения и формат

- Целое число forward-проходов. Реальный потолок — `max_delay_passes - 1` задержек подряд: сравнение в коде строгое (`prev_delayed_count < self._max_delay_passes - 1`).
- Значение по умолчанию `30` при типичной длительности decode-шага в единицы-десятки миллисекунд означает потолок задержки порядка сотен миллисекунд.
- Счетчик задержек ведется по «эпизодам»: он обнуляется, как только prefill выпущен, и стартует заново при следующей задержке.
- Значение `1` фактически отключает задержку по проходам (условие `0 < 0` ложно на первом же шаге), но корзина гистограммы `max_delay_passes - 1` при этом становится нулевой — практического смысла нет, для отключения используйте `--enable-prefill-delayer` (не задавайте его).
- Значение переопределяется переменной окружения, см. «Паспорт».

## Когда использовать

- Увеличивайте, если по метрикам видно, что задержки регулярно упираются в потолок (`output_reason="wait_timeout"`), а простой рангов при этом сохраняется — значит окно ожидания слишком короткое.
- Уменьшайте, если TTFT вырос сверх приемлемого: потолок — единственная жесткая граница задержки, выраженная в проходах.
- Не трогайте, если delayer не включен: аргумент не читается вообще.
- Не используйте как ручку throughput: объем работы он не меняет, только момент ее запуска.

## Влияние на производительность и память

- На память не влияет: задержка не резервирует и не освобождает KV, решение принимается после всех бюджетных проверок.
- TTFT растет строго на длительность задержки — в худшем случае на `(max_delay_passes - 1)` forward-проходов.
- Throughput при DP attention растет за счет того, что ранги реже расходятся по режимам forward и prefill-батчи получаются крупнее.
- На время старта не влияет.

## Взаимодействие с другими аргументами

- `--enable-prefill-delayer`: без него аргумент не читается.
- `--disable-overlap-schedule`: несовместим — `PrefillDelayer.__init__` содержит `assert not server_args.disable_overlap_schedule`.
- `--prefill-delayer-token-usage-low-watermark`: обходит потолок сверху — при низкой загрузке пула задержки не будет вовсе.
- `--prefill-delayer-queue-min-ratio` и `--prefill-delayer-max-delay-ms`: второй триггер и его собственный лимит по времени; потолок в проходах действует и на него.
- `--prefill-delayer-forward-passes-buckets`: корзины гистограммы ожидания строятся из этого значения — в набор всегда добавляются `0` и `max_delay_passes - 1`, а корзины `>= max_delay_passes` отбрасываются.
- `--max-running-requests`: входит в `slot_condition` напрямую.
- `--enable-dp-attention`: основной сценарий, ради которого delayer существует; при выключенном DP attention `max_running_requests` в условии делится на `dp_size`.

## Типовые проблемы и диагностика

- Строка при старте планировщика: `PrefillDelayer initialized with max_delay_passes=30 token_usage_low_watermark=None queue_min_ratio=None max_delay_ms=5000.0 queue_trigger_enabled=False` — подтверждает все принятые значения семейства сразу.
- `AssertionError: To use PrefillDelayer, disable_overlap_schedule must be False.` — уберите `--disable-overlap-schedule`.
- `Ignoring --enable-prefill-delayer on decode engine (no prefill scheduling path; delayer would be a no-op).` — на decode-узле PD-дизагрегации delayer не создается.
- Метрика `sglang:prefill_delayer_outcomes_total` с меткой `output_reason` показывает распределение исходов: `no_wait`, `delay`, `wait_success`, `wait_timeout`, `token_watermark`. Высокая доля `wait_timeout` означает, что потолок достигается регулярно.
- Гистограмма `sglang:prefill_delayer_wait_forward_passes` показывает фактическую длину задержек; наблюдения пишутся только для проходов, где prefill был и разрешен, и реально выполнен.
- Подробный лог решений включается переменной окружения `SGLANG_PREFILL_DELAYER_DEBUG_LOG=1` (пишет только ранг `attn_tp_rank == 0`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-dp-attention --dp-size 2 --tp-size 2 --enable-prefill-delayer --prefill-delayer-max-delay-passes 10
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-dp-attention --dp-size 2 --tp-size 2 --enable-prefill-delayer --prefill-delayer-max-delay-passes 50 --prefill-delayer-token-usage-low-watermark 0.3
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/prefill_delayer.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/environ.py`
