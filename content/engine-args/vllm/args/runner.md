---
schema: 1
engine: vllm
primaryName: "--runner"
title: "--runner"
summary: Какой тип рантайма поднимает инстанс — генеративный, pooling (эмбеддинги и классификация) или draft. Один инстанс поддерживает ровно один runner; `auto` определяет его по архитектуре и по признакам sentence-transformers.
group: ModelConfig
related:
  - --convert
  - --pooler-config
  - --model
  - --max-model-len
  - --tokenizer
  - --speculative-config
---

# --runner

## Кратко

`--runner` определяет, чем инстанс является: сервером генерации, сервером эмбеддингов/классификации или draft-моделью. От этого зависят доступные HTTP-эндпоинты, инициализация pooler'а, тип внимания и даже сторона усечения в токенизаторе.

`auto` почти всегда прав; явное значение нужно, когда модель может работать в обеих ролях или когда автоопределение уводит не туда.

## Оригинальная справка

```text
The type of model runner to use. Each vLLM instance only supports one
model runner, even if the same model can be used for multiple types.
```

## Паспорт аргумента

- Флаги: `--runner`
- Группа argparse: `ModelConfig`
- Тип значения: enum
- Допустимые значения: `auto`, `generate`, `pooling`, `draft` — здесь это **настоящие** `choices` argparse, потому что поле объявлено как чистый `Literal` без `str` в объединении, в отличие от `--tokenizer-mode` и `--model-impl`
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` разрешается в `_get_runner_type` при сборке `ModelConfig`; результат, если он не `generate`, пишется в лог строкой `Resolved '--runner auto' to '--runner <тип>'. Pass the value explicitly to silence this message.`
- Где объявлен: `vllm/config/model.py:ModelConfig.runner`
- Этап применения: сборка `ModelConfig` (резолв типа, проверка совместимости с архитектурой, инициализация `pooler_config`) → выбор рантайма и набора эндпоинтов

## Что меняет в движке

Разрешение `auto` (`_get_default_runner_type`):

1. Если у репозитория есть конфигурация sentence-transformers (`get_pooling_config`), тип — `pooling`. Это отдельная ветка: она срабатывает даже для архитектур с суффиксом `*ForCausalLM`.
2. Иначе спрашивается реестр моделей: `is_pooling_model` → `pooling`, `is_text_generation_model` → `generate`.
3. Иначе работает сопоставление по суффиксу архитектуры (`_SUFFIX_TO_DEFAULTS`): `ForCausalLM`, `ForConditionalGeneration`, `ChatModel`, `LMHeadModel` → `generate`; `ForTextEncoding`, `EmbeddingModel` → `pooling`+`embed`; `ForSequenceClassification` → `pooling`+`classify`.
4. Если ничего не подошло — `generate`.

Дальше тип проверяется на совместимость с архитектурой и вместе с `--convert` определяет `convert_type`. Что меняется от типа:

- **`pooling`**: создается `PoolerConfig` (пустой, если `--pooler-config` не задан), поверх него накладывается конфигурация sentence-transformers из репозитория, затем модельные умолчания; поднимаются pooling-эндпоинты вместо чата. Для моделей с абсолютными позиционными эмбеддингами дополнительно учитывается `model_max_length` из `tokenizer_config.json` при выводе `--max-model-len`.
- **`generate`**: обычный генеративный путь.
- **`draft`**: тип, который `SpeculativeConfig` присваивает конфигу draft-модели (`ModelConfig(model=…, runner="draft", …)`). На `vllm serve` это значение задают редко — draft-модель обычно описывается через `--speculative-config`.
- **Токенизатор**: `truncation_side` равен `left` для `generate`/`draft` и `right` для `pooling` (`resolve_tokenizer_args`).

## Значения и формат

- `auto` — определить по модели; печатает свое решение в лог, если оно не `generate`.
- `generate` — генерация текста.
- `pooling` — эмбеддинги, классификация, reward-модели; настраивается через `--pooler-config`.
- `draft` — рантайм draft-модели спекулятивного декодирования.
- Значение вне списка отвергается самим argparse (в отличие от большинства «enum-подобных» аргументов vLLM).

## Когда использовать

- Задавайте явно на управляемом сервере: это снимает зависимость от эвристик автоопределения и убирает строку `Resolved '--runner auto'` из логов.
- `pooling` — когда генеративную модель нужно использовать как эмбеддер; тогда обычно нужен и `--convert embed`.
- `generate` — когда модель с pooling-конфигурацией sentence-transformers на самом деле должна генерировать текст.
- Не пытайтесь совместить роли в одном инстансе: в справке прямо сказано, что рантайм один на инстанс. Нужны обе роли — поднимайте два инстанса.

## Влияние на производительность и память

- **VRAM.** Косвенно: pooling-модели обычно не держат KV-cache для генерации и профилируются иначе; тип рантайма меняет форму вычислительного графа (`attn_type`).
- **Время старта.** Для pooling добавляется чтение конфигурации sentence-transformers из репозитория.
- **Throughput/latency.** Сравнивать между типами бессмысленно — это разные задачи.

## Взаимодействие с другими аргументами

- `--convert`: адаптирует модель под другой рантайм (`embed`, `classify`); именно он позволяет запустить `--runner pooling` на генеративной архитектуре.
- `--pooler-config`: применяется только при `pooling`.
- `--max-model-len`: для pooling с абсолютными позиционными эмбеддингами вывод длины дополнительно ограничивается `model_max_length` токенизатора.
- `--tokenizer`: сторона усечения зависит от типа рантайма.
- `--speculative-config`: штатный способ получить draft-модель; `--runner draft` — внутренний тип, а не замена этой настройке.
- `--model`: архитектура из его конфига и есть вход автоопределения.

## Типовые проблемы и диагностика

- **Симптом:** `Embedding models do not support '--runner generate'. Use '--runner pooling' or '--runner auto' for embedding models.` **Причина:** явно запрошена генерация на эмбеддинговой модели. **Лечение:** `pooling` или `auto`.
- **Симптом:** `This model does not support '--runner generate'.` **Причина:** архитектура не генеративная, а конвертеров в генерацию нет. **Лечение:** взять генеративную модель.
- **Симптом:** `This model does not support '--runner pooling'. You can pass '--convert <embed|classify>' to adapt it into a pooling model.` **Причина:** архитектура не pooling. **Лечение:** добавить `--convert`.
- **Симптом:** генеративная модель неожиданно поднялась как pooling. **Причина:** в репозитории есть конфигурация sentence-transformers, и ветка `get_pooling_config` сработала раньше реестра. **Проверка:** строка `Resolved '--runner auto' to '--runner pooling'` в логе. **Лечение:** задать `--runner generate` явно.
- **Подтверждение принятого значения:** для pooling в лог идет `Resolved pooling config: …, supported_tasks=(…)`; для генерации — обычный набор chat/completions в `GET /v1/models`.

## Примеры

```bash
vllm serve /models/bge-m3 --runner pooling --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --runner generate --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/config/speculative.py`
- `vllm/vllm/tokenizers/registry.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/engine/arg_utils.py`
