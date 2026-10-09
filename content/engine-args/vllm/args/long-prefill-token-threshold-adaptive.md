---
schema: 1
engine: vllm
primaryName: "--long-prefill-token-threshold-adaptive"
title: "--long-prefill-token-threshold-adaptive"
summary: Не дает порогу `--long-prefill-token-threshold` резать prefill мельче справедливой доли бюджета шага (`max_num_batched_tokens / число запросов`). Полезен, когда порог подобран под пиковую нагрузку, а при малой конкуренции он зря растягивает TTFT длинных промптов.
group: SchedulerConfig
related:
  - --long-prefill-token-threshold
  - --max-num-batched-tokens
  - --enable-chunked-prefill
  - --max-num-scheduled-tokens
  - --max-num-seqs
  - --max-num-active-seqs
---

# --long-prefill-token-threshold-adaptive

## Кратко

`--long-prefill-token-threshold N` ограничивает вклад одного запроса в шаг числом `N` токенов. Подобранный под пиковую нагрузку порог мешает, когда в очереди всего два-три запроса: длинный промпт режется на мелкие куски, хотя бюджет шага почти пуст. Флаг поднимает эффективный порог до справедливой доли бюджета: `max(N, max_num_batched_tokens // (running + waiting))`.

Порог при этом только поднимается и никогда не опускается ниже `N`. При `--long-prefill-token-threshold 0` (по умолчанию) флаг ничего не делает.

## Оригинальная справка

```text
Floor the effective long prefill token threshold at a fair share of
the token budget: max_num_batched_tokens divided by the number of
queued and running requests. Only applies when
long_prefill_token_threshold is nonzero.
```

## Паспорт аргумента

- Флаги: `--long-prefill-token-threshold-adaptive`, `--no-long-prefill-token-threshold-adaptive`
- Группа argparse: `SchedulerConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-long-prefill-token-threshold-adaptive` ⇒ `False`
- Значение по умолчанию: `Field(default=False)` — «не задан» означает выключено, а не «решит движок»
- Эффективное значение: не переопределяется. Отдельной проверки связи с `--long-prefill-token-threshold` нет: при пороге `0` флаг принимается молча и не действует
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.long_prefill_token_threshold_adaptive`
- Этап применения: планировщик, пересчет эффективного порога в начале каждого `Scheduler.schedule()`

## Что меняет в движке

В начале `Scheduler.schedule()` эффективный порог считается так:

1. `num_eligible_reqs = len(running) + len(waiting) + len(kv_holding_waiting)` (`get_request_counts`).
2. Если запрос один (`num_eligible_reqs <= 1`), порог на этом шаге равен `0`, то есть не действует. Это поведение базового порога, флаг на него не влияет.
3. Если порог больше `0` и флаг включен: `threshold = max(long_prefill_token_threshold, max_num_batched_tokens // num_eligible_reqs)`.

Полученное значение применяется так же, как обычный порог, в обоих местах `schedule()`: к незавершенным prefill-кускам в running-очереди и к новым запросам из waiting-очереди.

Особенности расчета:

- В знаменатель входят **все** ожидающие запросы, включая те, кого на этом шаге не пустят из-за `--max-num-seqs`/`--max-num-active-seqs`. При длинной очереди справедливая доля мала, и решающим остается базовый порог.
- Делится полный `max_num_batched_tokens`, а не остаток бюджета после декода.
- Block-aligned разрез для Mamba/SSM-моделей (`_mamba_block_aligned_split`) читает базовый `long_prefill_token_threshold` напрямую, адаптивный пол на него не распространяется.

Пример из тестов апстрима: бюджет `1024`, порог `100`, в очереди длинный и короткий запрос. Справедливая доля `1024 // 2 = 512` больше порога, поэтому длинный запрос получает 512 токенов за шаг, а не 100.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- Своих числовых параметров нет: доля всегда равна `max_num_batched_tokens // (running + waiting)` с целочисленным делением.
- Имеет смысл только вместе с `--long-prefill-token-threshold N`, где `N > 0`.

## Когда использовать

- Нагрузка с переменной конкурентностью: днем десятки диалогов, и порог защищает их ITL; ночью единичные длинные задачи, и тот же порог зря дробит их prefill.
- Порог подобран мелким (например, 512 при бюджете 8192), а TTFT длинных документов при малой очереди неприемлем.
- Не включайте, если порог нужен как жесткая гарантия размера куска: при двух-трех запросах в очереди один запрос сможет занять половину или треть бюджета шага.
- Без chunked prefill флаг не наблюдаем, как и сам порог.

## Влияние на производительность и память

- **TTFT длинных запросов.** Снижается при малой очереди: кусок растет до доли бюджета, число шагов на prefill падает.
- **ITL остальных.** При малой очереди может вырасти: длинный prefill снова занимает заметную долю шага. При длинной очереди поведение совпадает с базовым порогом.
- **VRAM и время старта.** Не влияет: меняется только размер куска в планировщике.
- **CPU планировщика.** Одно целочисленное деление на шаг, пренебрежимо.

## Взаимодействие с другими аргументами

- `--long-prefill-token-threshold`: базовый порог и единственное условие работы флага. Ограничение `<= max_model_len` проверяется только для базового значения.
- `--max-num-batched-tokens`: делимое справедливой доли; при большом бюджете пол поднимается выше.
- `--max-num-scheduled-tokens`: реальный кусок дополнительно зажат остатком бюджета шага, поэтому поднятый порог не выводит запрос за пределы бюджета.
- `--enable-chunked-prefill`: без него порог и пол не наблюдаемы.
- `--max-num-seqs`, `--max-num-active-seqs`: определяют, сколько ожидающих реально попадет в шаг, но знаменатель доли их не учитывает.

## Типовые проблемы и диагностика

- **Симптом:** флаг включен, а размер кусков не изменился. **Причина:** `--long-prefill-token-threshold` равен `0`, или очередь настолько длинная, что `max_num_batched_tokens // N` меньше порога. **Проверка:** `Running: N reqs, Waiting: M reqs` в периодическом логе; при `--enable-logging-iteration-details` виден размер вклада запроса в шаг.
- **Симптом:** при малой нагрузке вырос ITL интерактивных запросов рядом с длинным промптом. **Причина:** пол поднял кусок длинного prefill до половины-трети бюджета. **Лечение:** выключить флаг или уменьшить `--max-num-batched-tokens`.
- **Подтверждение принятого значения:** строка `non-default args: {...}` при старте содержит `long_prefill_token_threshold_adaptive: True`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --max-num-batched-tokens 8192 --long-prefill-token-threshold 512 --long-prefill-token-threshold-adaptive
```

```bash
vllm serve /models/Qwen3-4B --max-model-len 32768 --max-num-batched-tokens 16384 --long-prefill-token-threshold 2048 --long-prefill-token-threshold-adaptive --max-num-seqs 16
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/tests/v1/core/test_scheduler.py`
