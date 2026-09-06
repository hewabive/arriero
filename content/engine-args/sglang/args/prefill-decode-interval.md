---
schema: 1
engine: sglang
primaryName: "--prefill-decode-interval"
title: "--prefill-decode-interval"
summary: "После prefill откладывает следующий prefill на заданное число decode-раундов. При DP attention ритм синхронизируется между rank."
group: schedule
related:
  - --chunked-prefill-size
  - --enable-dp-attention
  - --enable-prefill-delayer
---

# --prefill-decode-interval

## Кратко

После prefill откладывает следующий prefill на заданное число decode-раундов. При DP attention ритм синхронизируется между rank.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
The number of decode rounds to run after a prefill batch before scheduling the next prefill. In data-parallel attention mode, the interval is synchronized across all DP ranks. Set to 0 to disable.
```

## Паспорт аргумента

- Флаг: `--prefill-decode-interval`
- Группа: `schedule`
- Тип: `int`
- Декларативный default: `0`
- Объявление: `ServerArgs.prefill_decode_interval` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI, инициализация и исполнение подсистемы, описанной ниже.

## Что меняет в движке

После батча с extend scheduler выставляет `_prefill_decode_interval_remaining`. `_should_defer_prefill` уменьшает счётчик и откладывает допуск следующего prefill. При DP attention используется синхронизированный `is_extend_in_batch`, чтобы rank не расходились по фазам.

## Значения и формат

Неотрицательное целое число; default `0` отключает. Отрицательное значение отвергается в validation pipeline.

## Когда использовать

Когда действующим decode-запросам требуется несколько проходов между prefill-батчами.

## Влияние на производительность и память

Может улучшить интервалы между выходными токенами ценой TTFT новых запросов и пропускной способности prefill. Выделенный KV-пул не уменьшает.

## Взаимодействие с другими аргументами

`--chunked-prefill-size` задаёт размер чанка, этот флаг — расстояние между prefill. `--enable-dp-attention` включает синхронизацию. Prefill delayer остаётся отдельным механизмом.

## Типовые проблемы и диагностика

При росте TTFT сравните с interval 0. Проверяйте `server_args=` и чередование prefill/decode в логах.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --chunked-prefill-size 4096 --prefill-decode-interval 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/validation_hook.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
