---
schema: 1
engine: vllm
primaryName: "--enable-prompt-tokens-details"
title: "--enable-prompt-tokens-details"
summary: Добавляет в `usage` разбивку промпта: сколько токенов пришло из prefix cache и сколько занимают мультимодальные плейсхолдеры. Единственный способ увидеть попадания кэша по каждому запросу.
group: Frontend
related:
  - --enable-prefix-caching
  - --enable-force-include-usage
  - --enable-per-request-metrics
  - --enable-log-requests
---

# --enable-prompt-tokens-details

## Кратко

Флаг включает поле `usage.prompt_tokens_details` в ответах чата, completions, Responses и Anthropic-совместимого эндпоинта. Внутри три величины: `cached_tokens`, `created_cache_tokens` и `multimodal_tokens` по модальностям.

Это единственный per-request сигнал о работе prefix caching: агрегаты `/metrics` показывают общую долю попаданий, но не отвечают на вопрос «этот конкретный запрос попал в кэш или пересчитал prefill заново».

## Оригинальная справка

```text
If set to True, enable prompt_tokens_details in usage.
```

## Паспорт аргумента

- Флаги: `--enable-prompt-tokens-details`, `--no-enable-prompt-tokens-details`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` или отсутствие обоих (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; поле остается `null`, если движок не вернул ни одной из трех величин
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.enable_prompt_tokens_details`
- Этап применения: HTTP-слой, сборка `usage` в ответе

## Что меняет в движке

`_make_prompt_tokens_details` (`vllm/entrypoints/openai/chat_completion/serving.py`) при выключенном флаге сразу возвращает `None`. При включенном собирает `PromptTokenUsageInfo`:

- `cached_tokens` — `RequestOutput.num_cached_tokens`, то есть сколько токенов промпта обслужены из уже существующих KV-блоков;
- `created_cache_tokens` — `num_cache_creation_tokens`, токены, записанные в кэш этим запросом;
- `multimodal_tokens` — словарь «модальность → число токенов», посчитанный `_get_mm_token_counts` по `mm_placeholders`; это разбивка уже учтенных в `prompt_tokens` плейсхолдеров, а не добавка к ним.

Если все три величины пусты, поле остается `null` даже при включенном флаге.

В потоковом режиме разбивка едет в финальном usage-чанке, а он появляется только при `stream_options.include_usage: true` либо при `--enable-force-include-usage`.

Тот же флаг передается в `ServingTokens` (token-in-token-out) и в speech-to-text-серворы, так что разбивка доступна и там.

## Значения и формат

- Включение: `--enable-prompt-tokens-details`. Выключение: `--no-enable-prompt-tokens-details`.
- «Не задан» = `false`.
- Форма в ответе:

  ```json
  "usage": {"prompt_tokens": 1024, "prompt_tokens_details": {"cached_tokens": 896, "created_cache_tokens": 128, "multimodal_tokens": {"image": 256}}}
  ```

- `cached_tokens` без включенного `--enable-prefix-caching` будет нулевым или отсутствующим: кэшировать нечего.

## Когда использовать

- Настройка prefix caching: сравнение `cached_tokens` с `prompt_tokens` показывает, действительно ли клиент переиспользует префикс или ломает его на каждом запросе (например, меняющимся системным промптом или атрибуцией в заголовках).
- Биллинг и учет: тарификация по «холодным» токенам промпта требует именно этой разбивки.
- Мультимодальные модели: `multimodal_tokens` объясняет, почему короткий текстовый запрос израсходовал тысячи токенов контекста.
- Не включайте на инстансе, где клиент строго валидирует схему ответа OpenAI: лишние поля в `usage` некоторые SDK отвергают.

## Влияние на производительность и память

Стоимость околонулевая: все три величины уже вычислены движком, флаг только разрешает их сериализацию. Ответ растет на десятки байт. На VRAM, KV-cache, время старта и throughput не влияет.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: без него `cached_tokens` бессмысленны — именно этот механизм их и порождает.
- `--enable-force-include-usage`: в стриминге разбивка приходит только с финальным usage-чанком, а этот флаг гарантирует его отправку без участия клиента.
- `--enable-per-request-metrics`: соседний диагностический флаг, но кладет данные в отдельное поле `metrics`, а не в `usage`.
- `--enable-log-requests`: серверная альтернатива, если разбивку не хочется отдавать клиенту.

## Типовые проблемы и диагностика

- **Симптом:** поле `prompt_tokens_details` отсутствует. **Причина:** флаг выключен, либо все три величины пусты. **Проверка:** повторить запрос с длинным повторяющимся префиксом при включенном prefix caching. **Лечение:** включить флаг и `--enable-prefix-caching`.
- **Симптом:** в стриминге разбивки нет. **Причина:** клиент не запросил usage. **Лечение:** `stream_options: {"include_usage": true}` или `--enable-force-include-usage`.
- **Симптом:** `cached_tokens` всегда 0 при включенном prefix caching. **Причина:** префиксы запросов не совпадают побайтово — обычно из-за меняющегося системного промпта, времени в промпте или клиентской атрибуции. **Проверка:** `gpu_prefix_cache_hit_rate` в `/metrics`. **Лечение:** стабилизировать префикс на стороне клиента.
- **Симптом:** сумма `multimodal_tokens` больше ожидаемой. **Причина:** это плейсхолдеры, уже входящие в `prompt_tokens`, и их количество определяется процессором модели, а не размером файла. **Лечение:** действий не требуется.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-prompt-tokens-details --enable-prefix-caching
```

```bash
vllm serve /models/Qwen3-4B --enable-prompt-tokens-details --enable-force-include-usage --enable-per-request-metrics
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/entrypoints/openai/engine/protocol.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
- `vllm/vllm/entrypoints/scale_out/factories.py`
