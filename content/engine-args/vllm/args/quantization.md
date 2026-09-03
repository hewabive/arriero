---
schema: 1
engine: vllm
primaryName: "--quantization"
title: "--quantization"
summary: Метод квантизации весов. Обычно задавать не нужно — метод читается из `quantization_config` чекпойнта; явное значение либо выбирает kernel-реализацию, либо включает онлайн-квантизацию неквантованных весов при загрузке.
group: ModelConfig
related:
  - --quantization-config
  - --allow-deprecated-quantization
  - --dtype
  - --kv-cache-dtype
  - --model
  - --moe-backend
  - --linear-backend
---

# --quantization

## Кратко

`--quantization` (алиас `-q`) выбирает метод квантизации весов. Для готового квантованного чекпойнта значение обычно избыточно: движок сам читает `quantization_config` из конфига модели и подбирает подходящую реализацию. Явное значение нужно в двух случаях: включить онлайн-квантизацию BF16/FP16-весов при загрузке или зафиксировать конкретную реализацию там, где их несколько.

Список допустимых значений — реестровый и меняется от сборки к сборке; статический перечень в справке не является полным контрактом.

## Оригинальная справка

```text
Method used to quantize the weights. If `None`, we first check the
`quantization_config` attribute in the model config file. If that is
`None`, we assume the model weights are not quantized and use `dtype` to
determine the data type of the weights.
```

## Паспорт аргумента

- Флаги: `--quantization`, `-q`
- Группа argparse: `ModelConfig`
- Тип значения: str; значение приводится к нижнему регистру валидатором `validate_quantization_before`
- Допустимые значения: **не ограничены парсером**. Поле объявлено как `QuantizationMethods | str | None`, а `literal_to_kwargs` при наличии `str` в объединении выставляет `metavar`, а не `choices`, — argparse пропустит любую строку. Настоящий список живет в `me_quant.QUANTIZATION_METHODS` (`vllm/model_executor/layers/quantization/__init__.py`) — это **изменяемый список**, который пополняется декоратором `@register_quantization_config` из плагинов, загружаемых `load_general_plugins()`. Дополнительно набор сужается платформой в `current_platform.verify_quantization`
- Значение по умолчанию: `None` — «взять из `quantization_config` чекпойнта, иначе считать веса неквантованными»
- Эффективное значение: при `None` заполняется из конфига модели в `_verify_quantization`; при заданном значении может быть **заменено** результатом `override_quantization_method` — например `gptq` подменяется на `gptq_marlin`, `awq` на `awq_marlin`, если реализация с marlin-ядрами применима
- Где объявлен: `vllm/config/model.py:ModelConfig.quantization`
- Этап применения: разбор CLI → `EngineArgs.__post_init__` (десугаринг онлайн-сокращений в `quantization_config`) → `ModelConfig._verify_quantization` → выбор классов слоев при загрузке весов

## Что меняет в движке

`_verify_quantization` — единственное место, где решается итоговый метод:

1. Читается `quantization_config` из конфига модели (`model_arch_config.quantization_config`), из него берется `quant_method`.
2. Перебираются зарегистрированные методы. Часть из них умеет «перехватывать» чекпойнт через `override_quantization_method(...)`; такие методы проверяются в фиксированном порядке предпочтения (`auto_gptq`, `gptq`, `gptq_marlin`, `auto_awq`, `awq`, `awq_marlin`, `inc`, `moe_wna16`, `modelopt*`, `mxfp8`, и последними — тяжелые `mxfp4`, `gpt_oss_mxfp4`, `deepseek_v4_fp8`, `humming`, чтобы не тянуть лишние импорты). Если пользователь явно указал `humming`, он ставится в начало списка.
3. Если пользователь ничего не задавал, итог — метод чекпойнта (возможно, перехваченный). Если задавал и он не совпал с методом чекпойнта — старт падает.
4. Итог проверяется на принадлежность реестру и на поддержку платформой, затем — на признак устаревшего метода.

Дальше выбранный метод определяет классы квантованных линейных слоев и MoE-слоев при построении модели, а значит и требования к compute capability, и доступные backend'ы GEMM/MoE.

Отдельная ветка — **онлайн-квантизация**. Имена из `ONLINE_QUANT_SHORTHAND_NAMES` (`fp8_per_tensor`, `fp8_per_block`, `fp8_per_channel`, `mxfp8`, `mxfp4`, `int8_per_channel_weight_only`, `nvfp4_per_token` и служебное `online`) не описывают чекпойнт: `EngineArgs.__post_init__` разворачивает такое имя в структуру `--quantization-config` (`resolve_quantization_config`), и веса квантуются на лету при загрузке, без калибровки.

## Значения и формат

- Одна строка, регистр не важен: `-q FP8` эквивалентно `--quantization fp8`.
- Не задано (`None`) — метод определяется чекпойнтом; для BF16/FP16-модели квантизации не будет, dtype весов задается `--dtype`.
- Имена из реестра чекпойнтов (`compressed-tensors`, `gptq`, `awq`, `modelopt`, `quark`, `torchao`, `inc`, …) описывают формат уже квантованных весов. `bitsandbytes` удалён из stock-реестра и из статического `choices`: поддержка мигрировала во внешний плагин и появляется только если тот зарегистрировал метод и загрузчик в конкретной сборке.
- Онлайн-сокращения (см. выше) описывают, во что квантовать неквантованные веса при загрузке.
- Устаревшие методы (`fbgemm_fp8`, `fp_quant`) отвергаются, пока не задан `--allow-deprecated-quantization`.
- **Как посмотреть настоящий список на своей сборке.** Перечень в `--help` — это статический `Literal` из исходников, он не включает методы плагинов. Авторитетный список печатает сам движок в тексте ошибки при неизвестном значении (`Unknown quantization method: X. Must be one of [...]`), и его же можно получить в окружении инстанса: `<env>/bin/python -c "import vllm.plugins as p; p.load_general_plugins(); from vllm.model_executor.layers.quantization import QUANTIZATION_METHODS as q; print(sorted(q))"`.

## Когда использовать

- Оставляйте пустым для квантованных чекпойнтов: движок определит метод сам и при возможности возьмет более быструю реализацию (marlin-ядра).
- Задавайте явно, когда нужно **отменить** автоподмену реализации или зафиксировать одну и ту же реализацию между хостами.
- Задавайте онлайн-сокращение, когда есть только BF16-веса, а VRAM не хватает: это способ уменьшить вес модели без отдельного квантованного чекпойнта, ценой качества и времени загрузки.
- Не подбирайте значение перебором «а вдруг заработает»: несовпадение с чекпойнтом дает жесткую ошибку, а неподдерживаемый платформой метод — отказ на старте.

## Влияние на производительность и память

- **VRAM.** Основной эффект — размер весов. Освобожденная память автоматически уходит в KV-cache, потому что бюджет задается долей от полной памяти устройства (`--gpu-memory-utilization`).
- **Throughput.** Зависит от метода и железа: часть форматов (fp8 на Hopper/Ada, mxfp4/nvfp4 на Blackwell) ускоряет GEMM, часть (weight-only int4) ускоряет только чтение весов и может проигрывать на больших батчах.
- **Время старта.** Онлайн-квантизация добавляет конвертацию весов при загрузке. Чтение уже квантованного чекпойнта времени не добавляет.
- **Точность.** Любая квантизация весов — компромисс; онлайн-режим без калибровки хуже квантованного чекпойнта, собранного с калибровкой.

## Взаимодействие с другими аргументами

- `--quantization-config`: тонкая настройка онлайн-схемы (раздельно для linear и MoE, список исключений). Комбинация с **не**-онлайн методом запрещена явной проверкой.
- `--allow-deprecated-quantization`: единственный способ запустить `fbgemm_fp8` и `fp_quant`.
- `--dtype`: dtype неквантованных частей модели и активаций; независимая ось.
- `--kv-cache-dtype`: квантизация KV-cache — отдельная ось, с квантизацией весов не связана.
- `--moe-backend`, `--linear-backend`: выбирают семейство ядер под уже определенный метод; для mxfp4/fp8 именно они решают, какой dtype активаций будет использован.
- `--model`: чекпойнт и есть источник метода по умолчанию.

## Типовые проблемы и диагностика

- **Симптом:** `Quantization method specified in the model config (X) does not match the quantization method specified in the 'quantization' argument (Y).` **Причина:** явное значение противоречит чекпойнту. **Лечение:** убрать аргумент или указать метод чекпойнта.
- **Симптом:** `Unknown quantization method: X. Must be one of [...]`. **Причина:** опечатка либо метод из плагина, который не загружен. **Проверка:** список в самом сообщении — это и есть реестр текущего процесса. **Лечение:** исправить имя или установить плагин.
- **Симптом:** `X quantization is currently not supported in <device_name>.` **Причина:** платформенная проверка `verify_quantization`. **Лечение:** метод, поддержанный вашим устройством.
- **Симптом:** `The quantization method %s is deprecated and will be removed in future versions of vLLM. To bypass, set '--allow-deprecated-quantization'.` **Причина:** метод в списке устаревших. **Лечение:** перейти на актуальный метод; флаг обхода — временная мера.
- **Симптом:** задан `gptq`, а в логе фигурирует `gptq_marlin`. **Причина:** сработал `override_quantization_method` — это штатное поведение, реализация быстрее. **Проверка:** порядок списка `overrides` в `_verify_quantization`.
- **Симптом:** `--quantization-config` отвергнут с `quantization_config is only supported when quantization is one of [...]`. **Причина:** метод не онлайн-сокращение. **Лечение:** см. документ `--quantization-config`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --quantization fp8_per_block --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B-AWQ -q awq --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/config/quantization.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/model_executor/layers/quantization/__init__.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/docs/features/quantization/online.md`
