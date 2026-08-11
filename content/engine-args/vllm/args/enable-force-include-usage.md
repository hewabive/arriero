---
schema: 1
engine: vllm
primaryName: "--enable-force-include-usage"
title: "--enable-force-include-usage"
summary: Заставляет сервер отдавать `usage` в потоковых ответах независимо от `stream_options` клиента — включая непрерывную статистику в каждом чанке.
group: Frontend
related:
  - --enable-prompt-tokens-details
  - --enable-per-request-metrics
  - --enable-log-requests
---

# --enable-force-include-usage

## Кратко

В OpenAI-протоколе usage в стриме опционален: клиент запрашивает его через `stream_options.include_usage`. Флаг снимает этот выбор с клиента.

Важная деталь, которой нет в справке: он включает **обе** формы сразу — и финальный usage-чанк, и `continuous_usage_stats`, то есть счетчик токенов в каждом чанке потока.

## Оригинальная справка

```text
If set to True, including usage on every request.
```

## Паспорт аргумента

- Флаги: `--enable-force-include-usage`, `--no-enable-force-include-usage`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` или отсутствие обоих (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; запрос не может отключить usage обратно
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.enable_force_include_usage`
- Этап применения: HTTP-слой, формирование потокового ответа

## Что меняет в движке

Вся логика — в `should_include_usage` (`vllm/entrypoints/serve/utils/api_utils.py`):

```text
if enable_force_include_usage:
    return True, True
```

Возвращается пара `(include_usage, include_continuous_usage)`. Первое значение включает финальный usage-чанк, второе — поле `usage` в каждом промежуточном чанке. Без флага оба берутся из `stream_options` запроса, причем `continuous_usage_stats` требует явного `include_usage: true`.

Флаг раздается чат-, completions-, Responses-, Anthropic- и speech-to-text-серворам (`vllm/entrypoints/generate/api_router.py`, `vllm/entrypoints/speech_to_text/factories.py`).

На нестриминговый ответ он не влияет: там `usage` присутствует всегда.

Есть побочный эффект на другие поля. `system_fingerprint` в потоке ставится «на последнем чанке»: при выключенном usage — на чанке с `finish_reason`, при включенном — на финальном usage-чанке. И метрики `--enable-per-request-metrics` в стриминге едут именно в финальном usage-чанке, поэтому без usage они клиенту вообще не доходят.

## Значения и формат

- Включение: `--enable-force-include-usage`. Выключение: `--no-enable-force-include-usage`.
- «Не задан» = `false`.
- Специальных значений нет, гранулярности «только финальный чанк» тоже нет: `continuous_usage_stats` включается вместе с остальным.

## Когда использовать

- Централизованный учет токенов, когда клиентов много и заставить каждого прислать `stream_options.include_usage` невозможно.
- Нужны потоковые метрики `--enable-per-request-metrics`: без usage-чанка они не отдаются.
- Не включайте, если клиент строго парсит SSE и не ожидает `usage` в промежуточных чанках: непрерывная статистика меняет форму каждого чанка, а не только последнего.
- Не используйте как замену серверному логированию: для аудита есть `--enable-log-requests`, и он не меняет протокол ответа.

## Влияние на производительность и память

На VRAM, KV-cache и время старта не влияет. Влияет на объем потокового трафика: `continuous_usage_stats` добавляет объект `usage` к каждому чанку, и при генерации в тысячи токенов это заметная прибавка к размеру ответа и к нагрузке на сериализацию в процессе API-сервера. На throughput движка это не влияет — вся работа на стороне фронтенда.

## Взаимодействие с другими аргументами

- `--enable-per-request-metrics`: в стриминге метрики привязаны к финальному usage-чанку; без этого флага клиент обязан сам запросить usage.
- `--enable-prompt-tokens-details`: разбивка промпта едет в том же финальном usage-чанке.
- `--enable-log-requests`: альтернатива, когда учет нужен на сервере, а не в ответе.

## Типовые проблемы и диагностика

- **Симптом:** клиент падает на разборе чанков потока. **Причина:** в каждом чанке появилось поле `usage`. **Проверка:** сырой SSE через `curl -N`. **Лечение:** выключить флаг либо починить клиента.
- **Симптом:** метрики `metrics` не приходят в стриминге. **Причина:** нет usage-чанка. **Лечение:** включить этот флаг или `stream_options: {"include_usage": true}`.
- **Симптом:** `system_fingerprint` переехал с чанка `finish_reason` на последний чанк. **Причина:** документированное поведение — отпечаток ставится на действительно последнем сообщении. **Лечение:** действий не требуется.
- **Подтверждение принятого значения:** стриминговый запрос **без** `stream_options` возвращает финальный чанк с `usage`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-force-include-usage --enable-per-request-metrics
```

```bash
vllm serve /models/Qwen3-4B --enable-force-include-usage --enable-prompt-tokens-details
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/serve/utils/api_utils.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
- `vllm/docs/features/per_request_metrics.md`
