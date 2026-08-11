---
schema: 1
engine: vllm
primaryName: "--model-impl"
title: "--model-impl"
summary: Откуда брать реализацию модели — из vLLM, из Transformers или из TerraTorch. `auto` пробует нативную реализацию и молча откатывается на Transformers-бэкенд с предупреждением о возможной потере скорости и функций.
group: ModelConfig
related:
  - --model
  - --trust-remote-code
  - --model-class-overrides
  - --runner
  - --convert
  - --tokenizer-mode
---

# --model-impl

## Кратко

`--model-impl` управляет резолвом класса модели. Нативная реализация vLLM быстрее и поддерживает больше фич; Transformers-бэкенд — универсальный запасной путь для архитектур, которых в vLLM еще нет.

Значение по умолчанию `auto` означает «vLLM, если есть; иначе Transformers». Явное значение нужно, чтобы **запретить** тихий откат или, наоборот, форсировать Transformers для сравнения.

## Оригинальная справка

```text
Which implementation of the model to use:

- "auto" will try to use the vLLM implementation, if it exists, and fall back to the
  Transformers implementation if no vLLM implementation is available.
- "vllm" will use the vLLM model implementation.
- "transformers" will use the Transformers model implementation.
- "terratorch" will use the TerraTorch model implementation.
```

## Паспорт аргумента

- Флаги: `--model-impl`
- Группа argparse: `ModelConfig`
- Тип значения: str
- Допустимые значения: осмысленные — `auto`, `vllm`, `transformers`, `terratorch`. Но парсер их **не проверяет**: поле объявлено как `str | ModelImpl`, поэтому `literal_to_kwargs` выдает `metavar`, а не `choices`
- Значение по умолчанию: `auto`
- Эффективное значение: не переопределяется, но резолв класса зависит и от `--convert`: Transformers-fallback до определения `convert_type` срабатывает только при `convert_type == "none"`
- Где объявлен: `vllm/config/model.py:ModelConfig.model_impl`
- Этап применения: сборка `ModelConfig` (инспекция класса модели) → загрузка модели в воркерах (`resolve_model_cls`)

## Что меняет в движке

`ModelRegistry.inspect_model_cls` и `resolve_model_cls` (`vllm/model_executor/models/registry.py`) устроены одинаково и ветвятся по значению:

- **`transformers`** — сразу пытается разрешить архитектуру через Transformers-бэкенд. Если класса нет ни в `transformers`, ни в `auto_map` конфига, поднимается `Cannot find model module. 'X' is not a registered model in the Transformers library … and 'AutoModel' is not present in the model config's 'auto_map'`. Если класс есть, но несовместим, — `The Transformers implementation of 'X' is not compatible with vLLM.`
- **`terratorch`** — резолвит фиксированную архитектуру `Terratorch`. Дополнительно `ModelConfig.__post_init__` принудительно ставит `tokenizer_mode = "terratorch"`; такого режима нет среди встроенных в `vllm/tokenizers/registry.py`, его должна регистрировать интеграция TerraTorch.
- **`auto`** — сначала обычный поиск архитектуры в реестре vLLM; если ни одна архитектура не найдена, выполняется откат на Transformers-бэкенд (дважды: до и после определения `convert_type`). При успешном откате в лог идет `X has no vLLM implementation, falling back to Transformers implementation. Some features may not be supported and performance may not be optimal.`
- **`vllm`** — ни одна ветка отката не срабатывает; либо архитектура есть в реестре vLLM, либо старт падает на `_raise_for_unsupported`.

Отсюда следует неочевидное: **любое значение вне четырех перечисленных ведет себя как `vllm`** — ни одна ветка условий не совпадает, откат не выполняется. Опечатка не вызывает ошибку разбора, но лишает инстанс Transformers-fallback.

Значение входит в ключ кеша резолва архитектуры (`get_model_architecture`) вместе с `model`, `runner_type`, `convert_type` и `trust_remote_code`.

## Значения и формат

- `auto` — vLLM с откатом на Transformers.
- `vllm` — только нативная реализация; отсутствие архитектуры в реестре = отказ на старте.
- `transformers` — только Transformers-бэкенд, даже если нативная реализация есть.
- `terratorch` — реализация TerraTorch (геопространственные модели), с принудительным режимом токенизатора.
- Любая другая строка проходит парсер и работает как `vllm`.

## Когда использовать

- `transformers` — чтобы сравнить нативную реализацию с эталонной при расследовании расхождений в качестве.
- `vllm` — на управляемом сервере, где тихий откат на медленный путь недопустим: лучше отказ на старте, чем неожиданная просадка производительности.
- `auto` — когда важнее «запустилось», чем «запустилось быстро»: новая архитектура заработает без обновления vLLM.
- Не задавайте `terratorch`, если вы не работаете с TerraTorch: значение меняет и режим токенизатора.

## Влияние на производительность и память

- **Throughput/latency.** Transformers-бэкенд обычно заметно медленнее нативной реализации — движок предупреждает об этом явно.
- **Функциональность.** Часть возможностей (специализированные ядра внимания, отдельные форматы квантизации, некоторые мультимодальные пути) может быть недоступна на Transformers-бэкенде.
- **VRAM.** Прямого влияния нет, но другая реализация слоев может иначе расходовать активации.
- **Время старта.** При откате добавляется динамический импорт класса из `transformers` или из репозитория модели.

## Взаимодействие с другими аргументами

- `--model`: архитектуры из его конфига и резолвятся.
- `--trust-remote-code`: обязателен, если Transformers-бэкенд должен подтянуть класс модели из `auto_map` репозитория.
- `--model-class-overrides`: регистрирует собственный класс под именем архитектуры — резолв найдет его в реестре vLLM раньше любых откатов.
- `--runner`, `--convert`: `convert_type` участвует в условии первого отката; при `--convert embed`/`classify` откат до определения типа не выполняется.
- `--tokenizer-mode`: значение `terratorch` подставляется принудительно при `--model-impl terratorch`.

## Типовые проблемы и диагностика

- **Симптом:** `Cannot find model module. 'X' is not a registered model in the Transformers library … and 'AutoModel' is not present in the model config's 'auto_map'.` **Причина:** запрошен `transformers`, но архитектуры нет ни там, ни в `auto_map`. **Лечение:** `auto`/`vllm` либо другой чекпойнт.
- **Симптом:** `The Transformers implementation of 'X' is not compatible with vLLM.` **Причина:** класс есть, но не поддерживает контракт бэкенда. **Лечение:** нативная реализация или другая модель.
- **Симптом:** в логе `X has no vLLM implementation, falling back to Transformers implementation…`, и скорость ниже ожидаемой. **Причина:** сработал откат при `auto`. **Лечение:** обновить vLLM до версии с нативной поддержкой либо принять просадку осознанно.
- **Симптом:** задан `--model-impl vlm` (опечатка), и модель, которая раньше поднималась через откат, перестала запускаться с ошибкой о неподдерживаемой архитектуре. **Причина:** неизвестное значение ведет себя как `vllm`, парсер опечатку не ловит. **Лечение:** исправить значение.
- **Подтверждение принятого значения:** строка `Resolved architecture: <Arch>` в логе — при откате там будет имя вида `Transformers…`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --model-impl vllm --gpu-memory-utilization 0.85
```

```bash
vllm serve org/new-arch-model --model-impl transformers --trust-remote-code --max-model-len 4096
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/model_executor/models/registry.py`
- `vllm/vllm/model_executor/model_loader/utils.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/tokenizers/registry.py`
