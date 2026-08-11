---
schema: 1
engine: vllm
primaryName: "--hf-config-path"
title: "--hf-config-path"
summary: Читать конфиг модели из другого репозитория или каталога, оставив веса на месте. Нужен для репозиториев без `config.json` и для подмены заведомо сломанного конфига целиком.
group: ModelConfig
related:
  - --hf-overrides
  - --config-format
  - --revision
  - --code-revision
  - --tokenizer
  - --generation-config
---

# --hf-config-path

## Кратко

`--hf-config-path` разрывает связь «веса и конфиг в одном месте»: архитектура, размерности, rope-параметры, `max_position_embeddings` и `quantization_config` читаются отсюда, а веса по-прежнему берутся из позиционного аргумента модели.

Это тяжёлый инструмент. Для точечных правок есть `--hf-overrides`; `--hf-config-path` осмыслен, когда нужен другой конфиг целиком.

## Оригинальная справка

```text
Name or path of the Hugging Face config to use. If unspecified, model
name or path will be used.
```

## Паспорт аргумента

- Флаги: `--hf-config-path`
- Группа argparse: `ModelConfig`
- Тип значения: str (идентификатор репозитория Hub или локальный путь)
- Допустимые значения: не ограничены
- Значение по умолчанию: `None` — конфиг читается оттуда же, откуда веса
- Эффективное значение: строковое значение прогоняется через `maybe_model_redirect()` (перенаправление по `VLLM_MODEL_REDIRECT_PATH`), поэтому фактический путь может отличаться от заданного
- Где объявлен: `vllm/config/model.py:ModelConfig.hf_config_path`
- Этап применения: самое начало `ModelConfig.__post_init__` — до загрузки весов, до определения архитектуры и до вычисления `max_model_len`

## Что меняет в движке

**Основной эффект.** `ModelConfig.__post_init__` вызывает

```
hf_config = get_config(self.hf_config_path or self.model, self.trust_remote_code, self.revision, self.code_revision, self.config_format, ...)
```

Всё, что дальше строится из `hf_config` — `hf_text_config`, `model_arch_config`, `architectures`, `attention_chunk_size`, `encoder_config`, производный `max_model_len`, обнаруженная квантизация — приходит из указанного вами источника.

**Побочный эффект на резолвинг ревизии.** Тут же считается:

```
config_from_model = not self.hf_config_path or self.hf_config_path == self.model
can_resolve_model_revision = config_from_model and weights_from_model
```

Если `hf_config_path` задан и отличается от модели, `can_resolve_model_revision` становится `False`, и `self.revision` **не** прогоняется через `resolve_revision()` — то есть не превращается в фиксированный commit-хеш. Ревизия токенизатора при этом резолвится отдельным вызовом. Практический вывод: связка «свой конфиг + `--revision main`» теряет ту воспроизводимость, которую обычно даёт резолвинг.

**Второй потребитель.** `try_get_generation_config()` при `--generation-config auto` читает generation config тоже из `self.hf_config_path or self.model`. То есть подмена конфига тянет за собой и дефолты сэмплирования.

**Чего он не меняет.** Токенизатор (`--tokenizer`), формат парсера (`--config-format`) и источник весов остаются независимыми. Если конфиг взят из другого репозитория, токенизатор всё ещё грузится из модели, если не задан явно.

## Значения и формат

- Идентификатор репозитория Hub (`org/repo`) или локальный путь к каталогу с конфигом.
- Файл указывать нельзя — ожидается каталог/репозиторий, из которого парсер сам возьмёт `config.json` или `params.json` согласно `--config-format`.
- `None` (не задан) — поведение по умолчанию.
- Значение, равное самому пути модели, эквивалентно «не задан» по логике `config_from_model`, но всё равно проходит через `maybe_model_redirect`.

## Когда использовать

- Каталог с одними весами (`*.safetensors`) без `config.json` — типично для дообученных чекпоинтов, выложенных «как есть».
- Форк модели, у которого конфиг заведомо сломан или отличается от того, что нужен vLLM, а веса совместимы.
- Веса, вытянутые из объектного хранилища в локальный каталог, при том что конфиг удобнее держать в репозитории Hub.
- **Не используйте** ради одного-двух полей — это работа `--hf-overrides`.
- **Не подсовывайте конфиг другой модели.** Совпадение по числу слоёв и hidden size не гарантирует ничего: несовпадение вскроется либо ошибкой формы при загрузке весов, либо, что хуже, тихим мусором на выходе.

## Влияние на производительность и память

Прямого влияния нет: один дополнительный источник чтения на старте (при удалённом репозитории — сетевой запрос). Косвенное влияние максимально: из этого конфига берутся `max_position_embeddings` и параметры архитектуры, из которых считаются `max_model_len` и размер KV-cache на токен. Ошибочный конфиг даёт неверный расчёт памяти со всеми последствиями — от OOM до неоправданно маленького KV-cache.

## Взаимодействие с другими аргументами

- `--hf-overrides`: применяется поверх того конфига, который прочитан по этому пути. Комбинация «чужой конфиг + точечные правки» рабочая.
- `--config-format`: определяет, каким парсером читать найденный конфиг; `auto` пробует mistral, затем hf.
- `--revision`: применяется к чтению конфига по этому пути, но при заданном `--hf-config-path` перестаёт резолвиться в commit-хеш для модели.
- `--code-revision`: если конфиг несёт remote code, его ревизия берётся отсюда.
- `--tokenizer`: не наследует этот путь; при необходимости задавайте отдельно.
- `--generation-config auto`: читает generation config по этому же пути.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Could not detect config format for no config file found...` при заданном `--hf-config-path`. **Причина:** в указанном каталоге нет ни `config.json`, ни `params.json`. **Лечение:** проверить путь; для локального каталога — что там именно каталог, а не файл.
- **Симптом:** загрузка весов падает на несовпадении форм. **Причина:** конфиг описывает другую модель. **Проверка:** строка `Resolved architecture: <Arch>` и число слоёв/hidden size в конфиге.
- **Симптом:** `Using max model len N` не тот, что ожидался. **Причина:** `max_position_embeddings` приехал из подменённого конфига. **Лечение:** `--max-model-len` явно либо правка через `--hf-overrides`.
- **Симптом:** дефолты сэмплирования изменились после подмены конфига. **Причина:** `--generation-config auto` читает generation config по тому же пути. **Лечение:** `--generation-config vllm` либо явный путь.
- **Симптом:** та же команда даёт разные результаты в разные дни, хотя `--revision` задан. **Причина:** при заданном `--hf-config-path` ревизия не резолвится в хеш. **Лечение:** указать commit id вместо ветки.
- **Подтверждение принятого значения:** отдельной строки нет; ориентируйтесь на `Resolved architecture` и `Using max model len`.

## Примеры

```bash
vllm serve /models/finetune-weights-only --hf-config-path Qwen/Qwen3-4B --max-model-len 8192
```

```bash
vllm serve /models/finetune-weights-only --hf-config-path /models/base-config --tokenizer /models/base-config --generation-config vllm
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/transformers_utils/config.py`
- `vllm/vllm/transformers_utils/repo_utils.py`
- `vllm/vllm/transformers_utils/utils.py`
