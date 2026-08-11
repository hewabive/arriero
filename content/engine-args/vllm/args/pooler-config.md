---
schema: 1
engine: vllm
primaryName: "--pooler-config"
title: "--pooler-config"
summary: Структура настроек пулинга для pooling-моделей: способ агрегации, активация, размерность эмбеддинга, длина входа, калибровка логитов классификатора. Применяется только при `--runner pooling`.
group: ModelConfig
related:
  - --runner
  - --convert
  - --max-model-len
  - --model
  - --tokenizer
---

# --pooler-config

## Кратко

`--pooler-config` — JSON-объект, задающий, как из выходов модели получается вектор или скор. Значения, которые вы не указали, добираются из конфигурации sentence-transformers репозитория, а затем из умолчаний конкретной модели, и источник каждого поля печатается в лог.

Аргумент имеет смысл только для pooling-рантайма; для генеративного инстанса он ничего полезного не делает.

## Оригинальная справка

```text
Pooler config which controls the behaviour of output pooling in pooling
models.
```

## Паспорт аргумента

- Флаги: `--pooler-config`
- Группа argparse: `ModelConfig`
- Тип значения: JSON-объект, валидируемый как датакласс `PoolerConfig` (`vllm/config/pooler.py`); принимается строкой JSON и точечными под-флагами
- Допустимые значения: набор полей `PoolerConfig` — `task`, `pooling_type`, `seq_pooling_type` (`CLS`/`LAST`/`MEAN`), `tok_pooling_type` (`ALL`/`STEP`), `use_activation`, `dimensions`, `enable_chunked_processing`, `max_embed_len`, `logit_mean`, `logit_sigma`, `step_tag_id`, `returned_token_ids`
- Значение по умолчанию: `None`
- Эффективное значение: при `--runner pooling` объект создается всегда — пустой `PoolerConfig()`, если аргумент не задан. Затем незаполненные поля добираются из `get_pooling_config(model, revision)` (конфигурация sentence-transformers репозитория), а `seq_pooling_type`/`tok_pooling_type` — из умолчаний модели. Источник каждого значения запоминается и логируется
- Где объявлен: `vllm/config/model.py:ModelConfig.pooler_config`
- Этап применения: сборка `ModelConfig` (создание и доразрешение) → выбор типа внимания → pooling-эндпоинты HTTP-слоя

## Что меняет в движке

Порядок разрешения (в `ModelConfig.__post_init__`, ветка `runner_type == "pooling"`):

1. Если аргумент не задан — создается пустой `PoolerConfig`, все источники неизвестны.
2. Если задан — поля, которые вы указали явно, помечаются источником `user`.
3. Поля, оставшиеся `None`, заполняются из конфигурации sentence-transformers репозитория (источник `sentence_transformers`).
4. `seq_pooling_type` и `tok_pooling_type`, если все еще `None`, берутся из умолчаний модели (источник `model_default`).
5. `use_activation` по умолчанию логируется как `pooler_default`.

Итог печатается один раз: `Resolved pooling config: pooling_type=LAST(source=model_default), use_activation=True(source=pooler_default), supported_tasks=('embed',)` (`vllm/v1/engine/core.py`).

Отдельно: свойство `ModelConfig.attn_type` ветвится по `pooler_config is not None` — при `CLS`-пулинге тип внимания становится `encoder_only`, при некаузальном конфиге модели тоже. Для обычной каузальной генеративной модели эта ветка возвращает тот же тип внимания, что и без аргумента, поэтому практического эффекта у `--pooler-config` вне pooling-рантайма нет.

Сам объект не входит в хеш вычислительного графа: `PoolerConfig.compute_hash` считает по пустому списку факторов.

## Значения и формат

Одной строкой JSON:

```bash
--pooler-config '{"pooling_type":"MEAN","use_activation":false,"dimensions":512}'
```

Точечными под-флагами:

```bash
--pooler-config.pooling_type MEAN
```

Смысл ключевых полей:

- `pooling_type` — удобный ярлык: `CLS`/`LAST`/`MEAN` раскладываются в `seq_pooling_type`, `ALL`/`STEP` — в `tok_pooling_type`. Задавать одновременно ярлык и соответствующее ему конкретное поле нельзя.
- `use_activation` — применять ли активацию к выходу пулера; `None` означает «умолчание пулера», обычно `True`.
- `dimensions` — усечение эмбеддинга для моделей с matryoshka-представлением.
- `enable_chunked_processing` — резать длинный вход на куски и агрегировать взвешенным усреднением.
- `max_embed_len` — максимальная длина входа для эмбеддингов; при `None` равна `max_model_len`.
- `logit_mean`, `logit_sigma` — аффинная калибровка логитов классификатора (Platt scaling): `activation((logit - logit_mean) / logit_sigma)`. `logit_sigma` не может быть нулем.
- `step_tag_id`, `returned_token_ids` — для reward-моделей: вернуть скор только для отмеченного токена и только для выбранных позиций словаря.

Удаленный параметр `normalize` отвергается явной ошибкой с указанием замены.

## Когда использовать

- Модель поддерживает несколько типов пулинга, а нужный отличается от умолчания (частый случай — `MEAN` вместо `LAST`).
- Требуется эмбеддинг уменьшенной размерности (`dimensions`) без отдельной модели.
- Вход длиннее контекста модели, и допустима агрегация кусками (`enable_chunked_processing` плюс `max_embed_len`).
- Классификатор нужно откалибровать под уже принятый порог (`logit_mean`/`logit_sigma`).
- Не задавайте аргумент, если репозиторий sentence-transformers уже описывает нужный пулинг: движок возьмет его сам, и в логе будет `source=sentence_transformers`.

## Влияние на производительность и память

- **VRAM.** Прямого влияния нет. `enable_chunked_processing` увеличивает число прогонов на один запрос, но не пиковую память.
- **Latency.** Кусочная обработка длинного входа линейно увеличивает время ответа на такой запрос.
- **Размер ответа.** `dimensions` напрямую задает длину возвращаемого вектора.
- **Время старта.** Не меняется; чтение конфигурации sentence-transformers выполняется в любом случае при pooling-рантайме.

## Взаимодействие с другими аргументами

- `--runner`: аргумент применяется только при `pooling`; при `auto` тип может разрешиться в `pooling` автоматически.
- `--convert`: позволяет использовать генеративную архитектуру как pooling-модель — тогда и `--pooler-config` начинает действовать.
- `--max-model-len`: значение по умолчанию для `max_embed_len`; при `enable_chunked_processing` бюджет вывода считается как `max_model_len - max_embed_len`.
- `--model`, `--revision`: конфигурация sentence-transformers читается из этого репозитория и этой ревизии.

## Типовые проблемы и диагностика

- **Симптом:** `Parameter 'normalize' was removed; use 'use_activation' instead.` **Причина:** устаревшее поле. **Лечение:** переименовать.
- **Симптом:** `Cannot set both 'pooling_type' and 'seq_pooling_type'` (аналогично для `tok_pooling_type`). **Причина:** одновременно задан ярлык и конкретное поле. **Лечение:** оставить одно.
- **Симптом:** `logit_sigma cannot be 0 (division by zero)`. **Причина:** нулевой делитель калибровки. **Лечение:** корректное значение.
- **Симптом:** заданный пулинг «не применился». **Проверка:** строка `Resolved pooling config: …` в логе — в ней у каждого поля указан источник (`user`, `sentence_transformers`, `model_default`, `pooler_default`). Если ваш параметр показан не как `user`, он не дошел до конфига.
- **Симптом:** аргумент задан, но инстанс генеративный, и ничего не изменилось. **Причина:** объект создается и доразрешается только для pooling-рантайма. **Лечение:** `--runner pooling` (и, при необходимости, `--convert embed`).

## Примеры

```bash
vllm serve /models/bge-m3 --runner pooling --pooler-config '{"pooling_type":"MEAN","use_activation":false}'
```

```bash
vllm serve /models/Qwen3-Embedding-0.6B --runner pooling --pooler-config.dimensions 512
```

## Источники

- `vllm/vllm/config/pooler.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/entrypoints/pooling/base/protocol.py`
- `vllm/vllm/entrypoints/pooling/embed/io_processor.py`
- `vllm/vllm/engine/arg_utils.py`
