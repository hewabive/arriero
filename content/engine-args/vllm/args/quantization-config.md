---
schema: 1
engine: vllm
primaryName: "--quantization-config"
title: "--quantization-config"
summary: Тонкая настройка онлайн-квантизации: раздельные схемы для линейных и MoE-слоев плюс список слоев-исключений. Дополняет или перебивает сокращение, заданное в `--quantization`.
group: ModelConfig
related:
  - --quantization
  - --allow-deprecated-quantization
  - --moe-backend
  - --linear-backend
  - --dtype
  - --model
---

# --quantization-config

## Кратко

`--quantization-config` — структурный аналог `--quantization`: вместо одного имени схемы принимает объект с полями `linear`, `moe` и `ignore`. Нужен, когда линейные слои и эксперты MoE должны квантоваться по-разному, когда часть слоев надо исключить, или когда у готового квантованного чекпойнта надо задать формат активаций.

Аргумент имеет смысл только в паре с онлайн-квантизацией: с обычным методом чекпойнта (`awq`, `gptq`, `compressed-tensors`, …) он отвергается на старте.

## Оригинальная справка

```text
User-facing quantization configuration. Carries per-layer-kind specs
(linear, moe) and ignore patterns; see :class:`QuantizationConfigArgs`.
Auto-populated from the matching online shorthand when `quantization` is
one of the values in `ONLINE_QUANT_SHORTHAND_NAMES`.
```

## Паспорт аргумента

- Флаги: `--quantization-config`
- Группа argparse: `ModelConfig`
- Тип значения: JSON-объект, валидируемый как датакласс `QuantizationConfigArgs` (`vllm/config/quantization.py`); принимается и одной строкой JSON, и точечными под-флагами
- Допустимые значения: три поля — `linear` и `moe` (объект `{weight, activation}` либо строка) и `ignore` (список строк). Имена схем **не статический перечень**: строка сначала ищется среди онлайн-сокращений `_ONLINE_SHORTHANDS`, затем среди ключей `QUANT_KEY_NAMES` (`fp8_per_tensor_static`, `fp8_per_tensor_dynamic`, `fp8_per_token`, `fp8_per_channel_static`, `fp8_per_block_static`, `fp8_per_block_dynamic`, `mxfp8`, `mxfp4`, `int8_per_channel_static` в этом commit'е) — оба словаря живут в коде и меняются между релизами
- Значение по умолчанию: `None`
- Эффективное значение: при онлайн-сокращении в `--quantization` поле **автозаполняется** соответствующей структурой в `EngineArgs.__post_init__` (`resolve_quantization_config`); явно заданные поля перекрывают поля сокращения, незаданные наследуются
- Где объявлен: `vllm/config/model.py:ModelConfig.quantization_config`
- Этап применения: разбор CLI → `EngineArgs.__post_init__` (слияние с сокращением) → построение квантованных слоев при загрузке весов

## Что меняет в движке

`resolve_quantization_config(quantization, quantization_config)` сводит две ручки в один объект:

- если `--quantization` задан и **не** является онлайн-сокращением, а `--quantization-config` непустой — `ValueError` (см. диагностику);
- если `--quantization` — онлайн-сокращение, оно разворачивается в базовую структуру `QuantizationConfigArgs`;
- заданные поля `--quantization-config` перекрывают базу пофайлово: `linear or base.linear`, `moe or base.moe`, `ignore or base.ignore`;
- если `--quantization` не задан вовсе, `--quantization-config` используется как есть — этот путь и применяется к уже квантованным чекпойнтам, где метод определится позже автоматически.

Внутри `linear`/`moe` строка приводится к `QuantSpec` валидатором `_coerce_spec`: сначала проверяется, не является ли она именем онлайн-сокращения (тогда берется соответствующий слот — `linear` из сокращения для поля `linear`, `moe` для `moe`), иначе строка трактуется как имя **весовой** схемы из `QUANT_KEY_NAMES`. Незаданная половина пары (`weight` или `activation`) означает «оставить умолчание метода», то есть для готового чекпойнта — то, что в нем объявлено.

`ignore` — список слоев, которые не квантуются. Принимаются точные имена и регулярные выражения с префиксом `re:`. Для слитых слоев (`qkv_proj`) шаблон должен совпадать с **неслитыми** именами шардов (`q_proj`, `k_proj`, `v_proj`).

## Значения и формат

Одной строкой JSON:

```bash
--quantization-config '{"moe":{"activation":"mxfp8"},"ignore":["re:.*[qkv]_proj"]}'
```

Точечными под-флагами (`FlexibleArgumentParser` собирает их во вложенный объект до разбора):

```bash
--quantization-config.moe.activation mxfp8
```

Форма со списком — суффикс `+` и значения через запятую:

```bash
--quantization-config.ignore+ q_proj,k_proj
```

Особенности:

- `null` в `weight`/`activation` означает «не квантовать эту часть»: так, например, отключают квантизацию активаций у mxfp4-чекпойнта.
- Неизвестное имя схемы отвергается сразу: `unknown quantization name 'X'; expected one of [...]`.
- Пустой объект `{}` эквивалентен отсутствию аргумента (все поля остаются `None`/пустыми).

## Когда использовать

- Разные схемы для dense-слоев и экспертов: MoE квантовать агрессивнее, линейные слои — мягче (или наоборот).
- Исключение чувствительных слоев из квантизации через `ignore`, когда просадка качества локализована.
- Выбор формата активаций у уже квантованного чекпойнта — в текущем commit'е это поддержано для mxfp4-MoE (gpt-oss).
- Не используйте как замену `--quantization`: без онлайн-сокращения (или без квантованного чекпойнта) структура ничего не включает.

## Влияние на производительность и память

- **VRAM.** Определяет, какие именно слои и в каком формате уменьшатся в размере. Исключения в `ignore` возвращают соответствующие слои к исходному dtype и увеличивают потребление.
- **Throughput.** Формат активаций решает, будет ли использован w8a8/w4a4-путь или fallback w8a16; это часто больший эффект, чем формат весов.
- **Время старта.** Онлайн-квантизация конвертирует веса при загрузке; чем больше слоев затронуто, тем дольше.
- **Точность.** Инструмент точечного компромисса: `ignore` — способ сохранить качество там, где квантизация ломает модель.

## Взаимодействие с другими аргументами

- `--quantization`: задает базовую схему; онлайн-сокращения перечислены в `ONLINE_QUANT_SHORTHAND_NAMES`. Не-онлайн метод делает этот аргумент недопустимым.
- `--linear-backend`, `--moe-backend`: выбирают конкретное семейство ядер под заданную схему; для mxfp4 именно backend решает, будут ли активации в BF16 или в mxfp4.
- `--dtype`: dtype неквантованных частей и активаций там, где схема их не задает.
- `--allow-deprecated-quantization`: к онлайн-схемам отношения не имеет, но живет в том же узле выбора метода.
- `--model`: для уже квантованного чекпойнта схема весов приходит из него, а этот аргумент может задать только то, что чекпойнт оставил открытым.

## Типовые проблемы и диагностика

- **Симптом:** `quantization_config is only supported when quantization is one of [...], got quantization='awq'`. **Причина:** структура задана вместе с методом чекпойнта. **Лечение:** убрать `--quantization`, либо перейти на онлайн-сокращение.
- **Симптом:** `unknown quantization name 'fp8'; expected one of [...]`. **Причина:** в `weight`/`activation` попало имя, которого нет ни среди онлайн-сокращений, ни в `QUANT_KEY_NAMES`. **Лечение:** взять имя из перечисленных в самом сообщении.
- **Симптом:** `online shorthand 'int8_per_channel_weight_only' does not define a linear spec`. **Причина:** сокращение задает только слот `moe`, а использовано в поле `linear`. **Лечение:** указать явную схему весов для линейных слоев.
- **Симптом:** `ignore` не срабатывает для `qkv_proj`. **Причина:** слитый слой; шаблон должен совпадать с неслитыми шардами. **Лечение:** `re:.*[qkv]_proj`.
- **Симптом:** аргумент задан точечными под-флагами, но значение не применилось. **Проверка:** в логе `FlexibleArgumentParser` предупреждает `Found duplicate keys …`, если один и тот же путь задан дважды; кроме того, значения из `--config file.yaml` подставляются до явных флагов и потому проигрывают им.

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --quantization fp8_per_tensor --quantization-config '{"moe":"fp8_per_block"}'
```

```bash
vllm serve /models/gpt-oss-20b --quantization-config.moe.activation mxfp8
```

## Источники

- `vllm/vllm/config/quantization.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/docs/features/quantization/online.md`
