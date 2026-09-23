---
schema: 1
engine: vllm
primaryName: "--enable-trace-replay"
title: "--enable-trace-replay"
summary: Разрешает запросам задавать фиксированную последовательность decode-токенов для отладки и RL.
group: ModelConfig
related: []
---

# --enable-trace-replay

## Кратко

Разрешает запросам задавать фиксированную последовательность decode-токенов для отладки и RL.

## Оригинальная справка

```text
Whether to allow requests to set
`SamplingParams.trace_decode_token_ids`, which forces decoding to follow a
predetermined token sequence while still computing real logprobs. Reserved
for debugging and RL workflows: enabling it reserves a per-request trace
buffer, so it is off by default.
```

## Паспорт аргумента

- Флаги: `--enable-trace-replay`, `--no-enable-trace-replay`
- Группа argparse: `ModelConfig`
- Тип значения: `bool`
- Значение по умолчанию в декларации: `False`
- Где объявлен: `vllm/config/model.py:ModelConfig.enable_trace_replay`

## Что меняет в движке

SamplingParams.trace_decode_token_ids заставляет decode следовать заданным токенам, сохраняя вычисление настоящих logprobs.

## Значения и формат

Парная форма `--no-enable-trace-replay` выключает значение; отсутствие флага оставляет значение по умолчанию.

## Когда использовать

Включайте только для управляемых отладочных запросов; по умолчанию выключено.

## Влияние на производительность и память

Для каждого запроса резервируется trace buffer, поэтому память растёт с числом и длиной трасс.

## Взаимодействие с другими аргументами

Применяется вместе с настройками того же компонента; проверяйте итоговый конфиг при запуске.

## Типовые проблемы и диагностика

Если запрос с trace_decode_token_ids отвергнут, проверьте флаг и параметры запроса.

## Примеры

```bash
vllm serve /models/model --enable-trace-replay
```

## Источники

- `vllm/vllm/config/model.py`
