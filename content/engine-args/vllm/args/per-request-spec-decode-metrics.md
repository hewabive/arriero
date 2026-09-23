---
schema: 1
engine: vllm
primaryName: "--per-request-spec-decode-metrics"
title: "--per-request-spec-decode-metrics"
summary: Добавляет метрики принятия speculative decoding в ответ отдельного запроса.
group: ObservabilityConfig
related: 
  - --speculative-config
---

# --per-request-spec-decode-metrics

## Кратко

Добавляет метрики принятия speculative decoding в ответ отдельного запроса.

## Оригинальная справка

```text
Include per-request speculative-decoding acceptance metrics in the
response under `metrics.speculative_decoding`. `none` disables; `summary` adds mean
acceptance length, draft acceptance rate, and the step-by-draft-length
histogram; `detailed` additionally records the ordered per-step
accepted/proposed arrays (one entry per verify step). Only reported for
single-sequence requests (`n == 1`), mirroring the timing metrics. No effect
unless speculative decoding is enabled. Independent of `--disable-log-stats`.
This is the per-request response-body counterpart of the aggregate
`vllm:spec_decode_*` Prometheus metrics. The response field is experimental
and its shape may change in a future release.
```

## Паспорт аргумента

- Флаги: `--per-request-spec-decode-metrics`
- Группа argparse: `ObservabilityConfig`
- Тип значения: `enum`
- Значение по умолчанию в декларации: `'none'`
- Где объявлен: `vllm/config/observability.py:ObservabilityConfig.per_request_spec_decode_metrics`

## Что меняет в движке

summary возвращает среднюю длину принятия, долю принятых draft-токенов и гистограмму; detailed добавляет массивы по шагам.

## Значения и формат

Допустимые значения и ограничения проверяются при разборе CLI и построении конфига.

## Когда использовать

Используйте summary для диагностики; detailed включайте кратковременно. Работает только при speculative decoding и n=1.

## Влияние на производительность и память

Detailed накапливает данные по каждому verify-шагу и увеличивает размер ответа и память запроса.

## Взаимодействие с другими аргументами

Связанные флаги: `--speculative-config`.

## Типовые проблемы и диагностика

При отсутствии metrics.speculative_decoding проверьте speculative decoding, n=1 и выбранный режим.

## Примеры

```bash
vllm serve /models/model --per-request-spec-decode-metrics summary
```

## Источники

- `vllm/vllm/config/observability.py`
