---
schema: 1
engine: vllm
primaryName: "--trust-request-mm-kwargs"
title: "--trust-request-mm-kwargs"
summary: Разрешает клиенту присылать в теле запроса `mm_processor_kwargs` и `media_io_kwargs`. По умолчанию такие запросы отвергаются с 400, потому что эти kwargs меняют стоимость мультимодальной предобработки; включать только для доверенных клиентов.
group: Frontend
related:
  - --mm-processor-kwargs
  - --media-io-kwargs
  - --trust-request-chat-template
  - --limit-mm-per-prompt
  - --api-key
---

# --trust-request-mm-kwargs

## Кратко

Поля запроса `mm_processor_kwargs` и `media_io_kwargs` управляют тем, как сервер загружает и предобрабатывает изображения, видео и аудио: размеры, число патчей, число кадров, извлечение аудио из видео. Клиент с такими полями может заставить сервер потратить непропорционально много CPU, GPU и памяти. Поэтому по умолчанию сервер отвергает любой запрос, где хотя бы одно из этих полей непусто, а флаг снимает запрет.

Это изменение поведения: раньше per-request kwargs принимались без условий. Клиенты, которые их присылают (например, `use_audio_in_video` для Qwen2.5-Omni), после обновления vLLM начнут получать 400, пока флаг не включен или значение не перенесено на уровень сервера.

## Оригинальная справка

```text
Whether to trust per-request multimodal kwargs (`mm_processor_kwargs`
and `media_io_kwargs`). If False, the server rejects non-empty values
because they can change multimodal preprocessing resource usage. Only
enable this when API clients are trusted.
```

## Паспорт аргумента

- Флаги: `--trust-request-mm-kwargs`, `--no-trust-request-mm-kwargs`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-trust-request-mm-kwargs` ⇒ `False`
- Значение по умолчанию: `False` — «не задан» означает запрет, а не «решит движок»
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/launchers/cli_args.py:BaseFrontendArgs.trust_request_mm_kwargs`
- Этап применения: HTTP-слой, проверка до рендеринга и предобработки каждого запроса

## Что меняет в движке

Флаг попадает в `OnlineRenderer` (через `ChatTemplateConfig`) и в базовый сервинг pooling-эндпоинтов. Проверка одна — `validate_request_mm_kwargs` (`vllm/entrypoints/generate/base/protocol.py`):

- если флаг включен — ничего не проверяется;
- иначе непустой `mm_processor_kwargs` дает `VLLMValidationError` с текстом `Per-request mm_processor_kwargs are disabled by default because they can change multimodal preprocessing resource usage. Start the server with --trust-request-mm-kwargs only when clients are trusted.`;
- непустой `media_io_kwargs` — аналогичное сообщение про `media_io_kwargs`.

Ошибка превращается в HTTP 400 `BadRequestError` с `param`, равным имени поля. Проверка вызывается в `OnlineRenderer.preprocess_chat` и `preprocess_cmpl` (chat completions, completions, responses, tokenize) и в `_init_ctx` pooling-сервинга (embeddings, classify, score, rerank). Пустой словарь `{}` и `null` проходят.

Серверные значения `--mm-processor-kwargs` и `--media-io-kwargs` флаг не затрагивает: они применяются всегда.

## Значения и формат

- Флаг без значения: `--trust-request-mm-kwargs` — per-request kwargs принимаются.
- `--no-trust-request-mm-kwargs` или флаг не задан — непустые per-request kwargs отвергаются.
- Разрешение действует на оба поля сразу; разрешить одно и запретить другое нельзя.
- Других kwargs запроса (`chat_template_kwargs`, `chat_template`) флаг не касается: шаблоном управляет `--trust-request-chat-template`.

## Когда использовать

- Доверенный внутренний клиент, которому действительно нужны разные параметры предобработки на разных запросах (разное число кадров видео, разное разрешение).
- Клиенты, которые присылают `use_audio_in_video` и подобные флаги на запрос, если перенести значение на сервер нельзя.
- Не включайте на сервере, доступном недоверенным клиентам: значения вроде огромного числа кадров или патчей превращаются в отказ в обслуживании на предобработке.
- Если значение одно для всех запросов, задайте его серверным `--mm-processor-kwargs` или `--media-io-kwargs` и оставьте флаг выключенным.

## Влияние на производительность и память

- **Флаг выключен.** Нулевая стоимость: проверка двух полей на пустоту.
- **Флаг включен.** Нагрузку предобработки определяет клиент: CPU на декодирование и ресайз, RAM под кадры, токены изображения в контексте и, как следствие, KV-cache. Ограничители сервера (`--limit-mm-per-prompt`, `--max-model-len`) продолжают действовать, но размер одного элемента клиент меняет сам.
- **VRAM и время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--mm-processor-kwargs`: серверные kwargs процессора; при включенном флаге per-request значения сливаются с ними и побеждают.
- `--media-io-kwargs`: серверные kwargs загрузчиков медиа; при включенном флаге сливаются с per-request значениями по модальностям.
- `--trust-request-chat-template`: такой же опт-ин для другого поля запроса, шаблона чата. Решение о доверии принимается по тем же критериям.
- `--limit-mm-per-prompt`: ограничивает число элементов, а не стоимость каждого; не заменяет этот флаг.
- `--api-key`: ограничивает круг клиентов, но не понижает права того, кто ключ получил.

## Типовые проблемы и диагностика

- **Симптом:** после обновления vLLM мультимодальные запросы клиента получают 400 `Per-request mm_processor_kwargs are disabled by default ...` или `Per-request media_io_kwargs are disabled by default ...`. **Причина:** клиент присылает эти поля, а флаг не включен. **Лечение:** перенести значение в `--mm-processor-kwargs`/`--media-io-kwargs` или, если клиент доверенный, включить флаг.
- **Симптом:** при включенном флаге отдельные запросы надолго занимают CPU API-сервера или вызывают OOM на хосте. **Причина:** клиент прислал тяжелые параметры предобработки. **Проверка:** тело запроса. **Лечение:** выключить флаг и задать параметры на сервере.
- **Подтверждение принятого значения:** строка `non-default args: {...}` при старте содержит `trust_request_mm_kwargs: True`; запрос с непустым `mm_processor_kwargs` перестает получать 400.

## Примеры

```bash
vllm serve /models/Qwen2.5-Omni-7B --trust-request-mm-kwargs --limit-mm-per-prompt '{"video": 1}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --no-trust-request-mm-kwargs --mm-processor-kwargs '{"max_pixels": 1003520}'
```

## Источники

- `vllm/vllm/entrypoints/launchers/cli_args.py`
- `vllm/vllm/entrypoints/generate/base/protocol.py`
- `vllm/vllm/renderers/online_renderer.py`
- `vllm/vllm/entrypoints/pooling/base/serving.py`
- `vllm/vllm/entrypoints/chat_utils.py`
- `vllm/vllm/entrypoints/serve/exception_handling/error_response.py`
- `vllm/docs/usage/security.md`
- `vllm/tests/entrypoints/openai/chat_completion/test_chat_error.py`
