---
schema: 1
engine: vllm
primaryName: "--enable-per-request-metrics"
title: "--enable-per-request-metrics"
summary: Добавляет в ответ объект `metrics` с TTFT, временем в очереди, средним ITL и throughput конкретного запроса. Требует включенной статистики движка и не работает при `n > 1`.
group: Frontend
related:
  - --disable-log-stats
  - --enable-force-include-usage
  - --enable-prompt-tokens-details
  - --enable-log-requests
---

# --enable-per-request-metrics

## Кратко

Флаг отдает клиенту пять величин по каждому запросу: `time_to_first_token_ms`, `generation_time_ms`, `queue_time_ms`, `mean_itl_ms`, `tokens_per_second`. Это дополнение к агрегатам `/metrics`, а не их замена: агрегаты показывают сервер, эти поля — один запрос.

Есть жесткая связка: с `--disable-log-stats` флаг несовместим, сервер откажется стартовать.

## Оригинальная справка

```text
If set to True, include per-request timing metrics in API responses.
```

## Паспорт аргумента

- Флаги: `--enable-per-request-metrics`, `--no-enable-per-request-metrics`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` или отсутствие обоих (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но подавляется в рантайме при `n > 1` — `metrics` в таком ответе будет `null`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.enable_per_request_metrics`
- Этап применения: разбор CLI (проверка конфликта) → HTTP-слой, сборка ответа

## Что меняет в движке

`validate_parsed_serve_args` отвергает комбинацию с `--disable-log-stats`:

```text
Error: --enable-per-request-metrics requires engine statistics logging; remove --disable-log-stats to enable per-request metrics.
```

Дальше флаг доходит до `OpenAIServingChat` и `OpenAIServingCompletion`. На завершении запроса вызывается `build_per_request_timing_metrics` (`vllm/entrypoints/generate/base/serving.py`), которая переводит метки времени `RequestStateStats` в поля модели `PerRequestTimingMetrics`:

- `queue_time_ms` = `scheduled_ts − queued_ts`;
- `time_to_first_token_ms` = `first_token_ts − scheduled_ts` (от планирования, не от приема HTTP-запроса);
- `generation_time_ms` = `last_token_ts − first_token_ts` — только декодирование, без очереди и prefill;
- `mean_itl_ms` = `generation_time / (число токенов − 1)`, `null` при одном токене;
- `tokens_per_second` = все выходные токены, деленные на интервал `scheduled_ts … last_token_ts`, то есть **включая** prefill — это не обратная величина к `mean_itl_ms`.

Каждое поле остается `null`, если нужной метки времени нет. Целиком объект подавляется при `n > 1`: тайминги описывают одну последовательность и не атрибутируются запросу.

Результат кладется в поле `metrics` ответа `/v1/chat/completions` и `/v1/completions`. В стриминге он едет в финальном usage-чанке — то есть требует включенного usage.

## Значения и формат

- Включение: `--enable-per-request-metrics`. Выключение: `--no-enable-per-request-metrics`.
- «Не задан» = `false`.
- Форма в ответе — объект `metrics` рядом с `usage`; поля в миллисекундах, кроме `tokens_per_second`.
- Для `/v1/completions` действует то же ограничение, что и при `n > 1`: при нескольких промптах в одном запросе метрики опускаются.

## Когда использовать

- Разбор жалоб «долго отвечает»: разделение `queue_time_ms` и `time_to_first_token_ms` сразу показывает, это конкуренция за слоты или тяжелый prefill.
- SLA и биллинг по латентности на уровне отдельного вызова.
- Не включайте на высоконагруженном инстансе без замера: апстрим прямо предупреждает о заметной нагрузке на CPU при высокой конкуренции (`vllm/docs/features/per_request_metrics.md`).
- Не используйте для сравнения моделей между инстансами: `tokens_per_second` считается от планирования и включает prefill, поэтому зависит от длины промпта.

## Влияние на производительность и память

VRAM, KV-cache и время старта не затрагиваются. Стоимость — CPU в процессе API-сервера на каждое завершение запроса и на каждый финальный чанк стрима, плюс необходимость держать включенной статистику движка (`--disable-log-stats` запрещен). Апстрим-документация рекомендует замерять влияние на своей нагрузке до включения в проде.

## Взаимодействие с другими аргументами

- `--disable-log-stats`: взаимоисключающие — сервер не стартует.
- `--enable-force-include-usage`: без usage-чанка метрики не доходят до потокового клиента.
- `--enable-prompt-tokens-details`: соседняя диагностика, но в `usage`, а не в `metrics`.
- `--enable-log-requests`: серверная альтернатива, если раскрывать тайминги клиенту нежелательно.

## Типовые проблемы и диагностика

- **Симптом:** старт падает с `Error: --enable-per-request-metrics requires engine statistics logging; remove --disable-log-stats to enable per-request metrics.` **Причина:** заданы оба флага. **Лечение:** убрать `--disable-log-stats`.
- **Симптом:** `metrics` равен `null`. **Причина:** запрос с `n > 1` (или несколькими промптами в completions) — тайминги подавляются намеренно. **Лечение:** мерить на `n = 1`.
- **Симптом:** в стриминге поля нет. **Причина:** нет финального usage-чанка. **Лечение:** `stream_options: {"include_usage": true}` или `--enable-force-include-usage`.
- **Симптом:** `mean_itl_ms` равен `null`. **Причина:** сгенерирован один токен, межтокенный интервал не определен. **Лечение:** действий не требуется.
- **Симптом:** `tokens_per_second` не совпадает с `1000 / mean_itl_ms`. **Причина:** знаменатели разные: первый интервал включает prefill. **Лечение:** действий не требуется.
- **Подтверждение принятого значения:** непотоковый запрос — объект `metrics` присутствует рядом с `usage`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-per-request-metrics --max-num-seqs 8
```

```bash
vllm serve /models/Qwen3-4B --enable-per-request-metrics --enable-force-include-usage
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/generate/base/serving.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/entrypoints/openai/completion/serving.py`
- `vllm/vllm/entrypoints/openai/engine/protocol.py`
- `vllm/docs/features/per_request_metrics.md`
- `vllm/tests/entrypoints/openai/test_cli_args.py`
