---
schema: 1
engine: vllm
primaryName: "--convert"
title: "--convert"
summary: Оборачивает модель адаптером, превращающим генеративную архитектуру в pooling-модель (эмбеддинги или классификация). Меняет тип runner'а, набор эндпоинтов и состав загружаемых весов.
group: ModelConfig
related:
  - --runner
  - --pooler-config
  - --hf-overrides
  - --io-processor-plugin
  - --logits-processors
---

# --convert

## Кратко

`--convert` — это не «режим вывода», а фабрика классов: vLLM берёт зарегистрированный класс модели и наследует от него обёртку из `vllm/model_executor/models/adapters.py`, заменяя голову генерации пулером.

Побочный эффект важнее самого преобразования: любое значение кроме `auto`/`none` переводит инстанс в `runner_type == "pooling"`, то есть сервер перестаёт генерировать текст и начинает обслуживать `/pooling`, `/v1/embeddings`, `/score`.

## Оригинальная справка

```text
Convert the model using adapters defined in
[vllm.model_executor.models.adapters][]. The most common use case is to
adapt a text generation model to be used for pooling tasks.
```

## Паспорт аргумента

- Флаги: `--convert`
- Группа argparse: `ModelConfig`
- Тип значения: enum (строка)
- Допустимые значения: `auto`, `none`, `embed`, `classify` (тип `ConvertOption = Literal["auto", ConvertType]`, где `ConvertType = Literal["none", "embed", "classify"]`)
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` разрешается в `_get_convert_type()` по архитектуре и типу runner'а — для генеративной модели в `none`, для pooling-архитектуры в `none` или в `embed` по умолчанию для Sentence-Transformers-подобных репозиториев; результат печатается в лог
- Где объявлен: `vllm/config/model.py:ModelConfig.convert`
- Этап применения: `ModelConfig.__post_init__` (выбор runner'а и convert-типа) → `VllmConfig.try_verify_and_update_config` (для `classify`) → загрузка модели (`get_model_architecture`)

## Что меняет в движке

Три последовательных шага.

**1. Выбор runner'а.** `_get_runner_type(architectures, runner, convert)`: при `--runner auto` и `convert` вне `{auto, none}` тип runner'а принудительно становится `pooling`. То есть `--convert embed` сам по себе переключает сервер в pooling-режим, без `--runner pooling`.

**2. Разрешение convert-типа.** `_get_convert_type(...)`: при `auto` вызывается `_get_default_convert_type`, который смотрит реестр архитектур и `try_match_architecture_defaults`; для pooling-runner'а, не опознанного иначе, возвращает `embed`. Если результат не `none`, в лог уходит `Resolved \`--convert auto\` to \`--convert <type>\`. Pass the value explicitly to silence this message.`

**3. Подмена класса модели.** `vllm/model_executor/model_loader/utils.py`:

- `none` — класс не меняется;
- `embed` — `as_embedding_model(model_cls)`, лог `Converting to embedding model.`;
- `classify` — `as_seq_cls_model(model_cls)`, лог `Converting to sequence classification model.`

Обе обёртки строятся поверх `_create_pooling_model_cls`, который конструирует исходную модель внутри контекста `no_init_weights(..., targets=(LogitsProcessor, ParallelLMHead))`. Практически это значит, что **`lm_head` и логит-процессор модели не создаются и их веса не загружаются**: вместо них ставится пулер (`DispatchPooler.for_embedding(...)` для `embed`, линейный `score` для `classify`).

Для `classify` дополнительно вызывается `SequenceClassificationConfig.verify_and_update_config(self)` в `VllmConfig.try_verify_and_update_config` — так конвертируются reranker'ы, у которых голова собирается из токенов (`classifier_from_token`, `method`).

Ограничения обёрток заявлены в их docstring'ах прямо: «We assume that no extra layers are added to the original model» для `embed` и «We assume that the classification head is a single linear layer stored as the attribute `score`» для `classify`. Модель, не удовлетворяющая этому, потребует собственной реализации, а не флага.

## Значения и формат

- `auto` — решает движок по архитектуре. Дефолт.
- `none` — не конвертировать. Явное значение полезно, чтобы заглушить лог `Resolved --convert auto to ...` и зафиксировать намерение.
- `embed` — эмбеддинги: пулинг по последнему токену с нормализацией по умолчанию, поведение настраивается `--pooler-config`.
- `classify` — классификация/скоринг через линейную голову `score`.
- Значения `embed`/`classify` для уже pooling-модели игнорируются на уровне адаптера: `as_embedding_model`/`as_seq_cls_model` возвращают класс без изменений, если `is_pooling_model(cls)`.

## Когда использовать

- Причинная LM, которую нужно отдавать как эмбеддер (`--convert embed`), потому что подходящего pooling-репозитория нет.
- Reranker, опубликованный как `*ForCausalLM`: типовой рецепт из апстрим-документации — `--convert` вместе с `--hf-overrides '{"architectures": [...], "classifier_from_token": [...], "method": "..."}'`.
- Явная фиксация `--convert none` на генеративном инстансе, если хочется убрать неопределённость и лог о разрешении `auto`.
- **Не используйте** для «попробовать эмбеддинги на всякий случай»: инстанс перестаёт генерировать, и в arriero это другой прокси-таргет, а не дополнительная возможность существующего.

## Влияние на производительность и память

- **VRAM (веса).** `embed`/`classify` не создают `lm_head`, поэтому его веса не занимают память: экономия примерно `vocab_size × hidden_size × байт_на_элемент` (для 150k словаря и hidden 4096 в BF16 — порядка 1.2 GiB). Для `classify` вместо неё появляется маленькая линейная голова на число меток.
- **KV-cache.** Pooling-runner не декодирует авторегрессивно; профиль потребления KV-cache определяется длиной входа, а не длиной генерации.
- **Время старта.** Дополнительной компиляции конверсия не требует; для `classify` добавляется шаг `verify_and_update_config`, который может дочитать конфиг.
- **Throughput.** Один forward на запрос вместо цикла декодирования — совершенно другая кривая нагрузки; сравнивать с генеративным режимом бессмысленно.

## Взаимодействие с другими аргументами

- `--runner`: `--convert embed|classify` уже подразумевает `pooling`. Явный `--runner generate` вместе с ними приведёт к ошибке «This model does not support `--runner generate`.», потому что конвертеров для генерации нет (`_RUNNER_CONVERTS["generate"]` пуст).
- `--pooler-config`: настраивает получившийся пулер (`pooling_type`, `use_activation`, `dimensions` для matryoshka). Незаданные поля добираются из `sentence_transformers`-конфига модели, если он есть, затем из дефолтов архитектуры.
- `--hf-overrides`: обязательный спутник при конвертации reranker'ов — им задают `architectures` и параметры головы.
- `--logits-processors`: несовместим. `build_logitsprocs` для pooling-модели с непустым списком поднимает ошибку «Custom logits processors are not supported for pooling models».
- `--io-processor-plugin`: работает только в pooling-режиме, то есть после конвертации становится применим.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: This model does not support \`--runner pooling\`. You can pass \`--convert <embed|classify> to adapt it into a pooling model.` **Причина:** задан pooling-runner для генеративной архитектуры без конверсии. **Лечение:** добавить `--convert embed` или `--convert classify`.
- **Симптом:** `ValueError: Embedding models do not support \`--runner generate\`. Use \`--runner pooling\` or \`--runner auto\` for embedding models.` **Причина:** модель pooling-only, а запрошена генерация.
- **Симптом:** в логе `Resolved \`--convert auto\` to \`--convert embed\`.`, хотя ожидалась генерация. **Причина:** архитектура опознана как pooling. **Лечение:** `--runner generate` (если модель это поддерживает) либо другой репозиторий.
- **Симптом:** классификация даёт неверное число классов. **Причина:** число меток берётся из `num_labels`, а у композитных конфигов оно может прийти из вложенного text-config со значением по умолчанию (2). **Лечение:** задать метки явно через `--hf-overrides`.
- **Подтверждение принятого значения:** строки `Resolved architecture: <Arch>` и `Converting to embedding model.` / `Converting to sequence classification model.` (уровень debug) в логе старта; набор поднятых эндпоинтов виден в стартовом списке routes.

## Примеры

```bash
vllm serve /models/Qwen3-0.6B --convert embed --max-model-len 8192
```

```bash
vllm serve Qwen/Qwen3-Reranker-0.6B --convert classify --hf-overrides '{"architectures": ["Qwen3ForSequenceClassification"], "classifier_from_token": ["no", "yes"], "is_original_qwen3_reranker": true}'
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/model_executor/models/adapters.py`
- `vllm/vllm/model_executor/model_loader/utils.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/sample/logits_processor/__init__.py`
- `vllm/docs/models/pooling_models/scoring.md`
