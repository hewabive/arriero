---
schema: 1
engine: sglang
primaryName: "--sampling-mask-max-tokens"
title: "--sampling-mask-max-tokens"
summary: Ограничивает число token ID в возвращаемой sampling mask. Запрос прерывается, если фактическая поддержка распределения превышает предел.
group: exec.features
related:
  - --disaggregation-mode
---

# --sampling-mask-max-tokens

## Кратко

Ограничивает число token ID в возвращаемой sampling mask. Запрос прерывается, если фактическая поддержка распределения превышает предел.

## Оригинальная справка

```text
The maximum number of token IDs in a returned sampling mask. Requests are aborted if their realized sampling support exceeds this limit. Use the same value on disaggregated prefill and decode nodes; clients should set top_k below the limit to leave headroom for cutoff ties.
```

## Паспорт аргумента

- Флаги: `--sampling-mask-max-tokens`
- Группа: `exec.features`
- Тип: `int`
- Значение в декларации по умолчанию: `4096`
- Объявление: `ServerArgs.sampling_mask_max_tokens` в `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

Sampler считает ненулевые веса, сравнивает их с лимитом и помечает переполнение; scheduler согласует решение между репликами. Передаваемая маска упаковывается максимум до заданного числа ID.

## Значения и формат

Положительное целое число; по умолчанию `4096`. Ноль и отрицательные значения отклоняются при запуске.

## Когда использовать

Увеличивайте предел только если запросы с нужными настройками sampling упираются в переполнение; снижайте `top_k`, оставляя запас на равные веса у порога.

## Влияние на производительность и память

Больший предел расширяет передаваемую маску и может повысить расход памяти/канала между стадиями; на размер весов модели не влияет.

## Взаимодействие с другими аргументами

В PD-развёртывании ставьте одинаковое значение на prefill и decode. Для передачи sampling mask в PD также требуется `SGLANG_ENABLE_DISAGG_SAMPLING_MASK=1`.

## Типовые проблемы и диагностика

Переполнение приводит к abort запроса; смотрите сообщения sampler/scheduler. Устаревшая `SGLANG_DISAGGREGATION_SAMPLING_MASK_MAX_TOKENS` вызывает ошибку старта.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --sampling-mask-max-tokens 8192
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/validation_hook.py`
- `sglang/python/sglang/srt/layers/sampler.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
